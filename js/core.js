/* ================================================================
   core.js — logic shared by the web page and the scheduled data job.
   No DOM access here. Works in browsers (window.MLBCore) and Node (require).
================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MLBCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ET = 'America/New_York';
  const DAY = 864e5;
  const ALLOWED_TYPES = new Set(['R', 'F', 'D', 'L', 'W']);          // regular season + postseason rounds
  const ROUND_NEED = { F: 2, D: 3, L: 4, W: 4 };                      // wins needed to win each series
  const ROUND_SHORT = { F: 'Wild Card', D: 'Division Series', L: 'LCS', W: 'World Series' };
  const LEAGUES = { 103: 'AL', 104: 'NL' };
  const DIVISIONS = { 200: 'AL West', 201: 'AL East', 202: 'AL Central', 203: 'NL West', 204: 'NL East', 205: 'NL Central' };
  const STAT_DEFS = [
    { key: 'runs',        idp: 'r',  label: 'Runs', low: false },
    { key: 'homeRuns',    idp: 'hr', label: 'HRs',  low: false },
    { key: 'stolenBases', idp: 'sb', label: 'SBs',  low: false },
    { key: 'strikeouts',  idp: 'k',  label: 'Ks',   low: false },
    { key: 'runsAllowed', idp: 'ra', label: 'RA',   low: true  },
  ];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---------- dates (always Eastern Time, never UTC) ---------- */
  const etPartsFmt = new Intl.DateTimeFormat('en-US', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' });
  function etDay(d) {
    const p = Object.fromEntries(etPartsFmt.formatToParts(d || new Date()).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  function addDays(ymd, n) {
    const d = new Date(ymd + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /* ---------- season context: which season's stats to show and what phase we're in ---------- */
  function computeContext(today, info) {
    const year = Number(today.slice(0, 4));
    let regStart, regEnd, seasonEnd, approx = false;
    if (info) {
      regStart = info.regularSeasonStartDate;
      regEnd = info.regularSeasonEndDate || info.seasonEndDate;
      seasonEnd = info.postSeasonEndDate || info.seasonEndDate || regEnd;
    } else {
      approx = true;
      regStart = `${year}-03-27`; regEnd = `${year}-09-28`; seasonEnd = `${year}-11-02`;
    }
    let phase;
    if (today < regStart) phase = 'before';
    else if (today <= regEnd) phase = 'regular';
    else if (today <= seasonEnd) phase = 'postseason';
    else phase = 'after';
    return { year, today, phase, statsSeason: phase === 'before' ? year - 1 : year, regStart, regEnd, seasonEnd, approx };
  }

  /* ---------- games ---------- */
  function normGame(g, teamId) {
    const home = g.teams && g.teams.home, away = g.teams && g.teams.away;
    const isHome = !!(home && home.team && home.team.id === teamId);
    const me = isHome ? home : away, opp = isHome ? away : home;
    const st = g.status || {}, ls = g.linescore;
    const rhe = x => x ? { r: x.runs, h: x.hits, e: x.errors } : null;
    const lsT = ls && ls.teams;
    return {
      pk: g.gamePk, ms: Date.parse(g.gameDate), type: g.gameType, season: g.season, isHome,
      oppId: opp && opp.team && opp.team.id, oppName: opp && opp.team && opp.team.name,
      my: me && me.score, their: opp && opp.score,
      abstract: st.abstractGameState, detailed: st.detailedState || '', tbd: !!st.startTimeTBD,
      inning: ls && ls.currentInningOrdinal, half: ls && ls.inningState, innings: ls && ls.currentInning,
      sched: (ls && ls.scheduledInnings) || g.scheduledInnings,
      myPP: (me && me.probablePitcher && me.probablePitcher.fullName) || null,
      theirPP: (opp && opp.probablePitcher && opp.probablePitcher.fullName) || null,
      rhe: lsT ? { my: rhe(isHome ? lsT.home : lsT.away), their: rhe(isHome ? lsT.away : lsT.home) } : null,
    };
  }

  /* Picks the live game, the most recent final, and the next scheduled game from a list. */
  function pickGames(games) {
    const ok = games.filter(g => ALLOWED_TYPES.has(g.type) && !/postpone|cancel/i.test(g.detailed));
    const live = ok.filter(g => g.abstract === 'Live' && !/suspend/i.test(g.detailed)).sort((a, b) => a.ms - b.ms)[0] || null;
    const last = ok.filter(g => g.abstract === 'Final' && g.my != null && g.their != null).sort((a, b) => b.ms - a.ms)[0] || null;
    const next = ok.filter(g => g.abstract === 'Preview').sort((a, b) => a.ms - b.ms)[0] || null;
    return { live, last, next };
  }

  /* Most recent finished games, newest first (de-duplicated). */
  function recentFrom(games, n) {
    const seen = new Set(), out = [];
    games.filter(g => ALLOWED_TYPES.has(g.type) && g.abstract === 'Final' && g.my != null && g.their != null && !/postpone|cancel/i.test(g.detailed))
      .sort((a, b) => b.ms - a.ms)
      .forEach(g => { if (seen.has(g.pk)) return; seen.add(g.pk); out.push({ ms: g.ms, my: g.my, their: g.their, oppId: g.oppId, isHome: g.isHome, type: g.type }); });
    return out.slice(0, n || 10);
  }

  /* Postseason picture from a team's games: each round's series score, pennant (league title), World Series result. */
  function postseasonInfo(games) {
    const post = games.filter(g => 'FDLW'.indexOf(g.type) !== -1 && g.type && !/postpone|cancel/i.test(g.detailed));
    if (!post.length) return null;
    const rounds = {};
    for (const type of ['F', 'D', 'L', 'W']) {
      const rg = post.filter(g => g.type === type);
      if (!rg.length) continue;
      const done = rg.filter(g => g.abstract === 'Final' && g.my != null && g.their != null);
      const wins = done.filter(g => g.my > g.their).length, losses = done.filter(g => g.my < g.their).length;
      const need = ROUND_NEED[type];
      rounds[type] = { wins, losses, over: wins >= need || losses >= need, won: wins >= need, season: rg[0].season };
    }
    const types = Object.keys(rounds);
    const top = types[types.length - 1];
    const ws = rounds.W ? Object.assign({}, rounds.W, { champion: rounds.W.won }) : null;
    return {
      rounds, round: top, ws, season: rounds[top].season,
      leagueChamp: !!(rounds.L && rounds.L.won) || !!rounds.W,       // reaching the World Series means winning the pennant
      eliminated: !!(rounds[top].over && !rounds[top].won),
    };
  }

  /* ================================================================
     create(): everything that needs the team list and a fetch function
  ================================================================ */
  function create(opts) {
    const TEAMS = opts.teams;
    const BASE = opts.base || 'https://statsapi.mlb.com/api/v1';
    const doFetch = opts.fetch || (typeof fetch === 'function' ? fetch.bind(typeof window !== 'undefined' ? window : globalThis) : null);
    const log = opts.log || function () {};
    const cache = opts.cache || { get() { return null; }, set() {} };
    const now = opts.now || (() => Date.now());
    const teamMeta = {};                                            // id -> { abbr, short, name }
    const teamByMlbId = id => TEAMS.find(t => t.id === id);

    /* ---------- HTTP ---------- */
    async function getJSON(url, label, o) {
      o = o || {};
      const retries = o.retries == null ? 1 : o.retries;
      const timeout = o.timeout || 15000;
      let lastErr;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const t0 = Date.now();
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
        try {
          const res = await doFetch(url, ctrl ? { signal: ctrl.signal } : undefined);
          const ms = Date.now() - t0;
          if (!res.ok) {
            log(label, url, res.status, ms, undefined, 'HTTP ' + res.status);
            const e = new Error(`${label}: HTTP ${res.status}`);
            e.retryable = res.status >= 500;
            throw e;
          }
          const data = await res.json();
          log(label, url, res.status, ms, data);
          return data;
        } catch (e) {
          if (!e.logged && !/HTTP \d+$/.test(e.message || '')) {
            const aborted = e && e.name === 'AbortError';
            log(label, url, 0, Date.now() - t0, undefined, aborted ? 'timeout' : (e && e.message));
            const online = typeof navigator === 'undefined' || navigator.onLine !== false;
            const err = new Error(`${label}: ${aborted ? 'timed out' : (online ? 'network error' : 'offline')}`);
            err.retryable = true; err.logged = true;
            e = err;
          }
          lastErr = e;
          if (!e.retryable || attempt === retries) throw e;
          await sleep(700);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      throw lastErr;
    }
    const api = (path, label) => getJSON(BASE + path, label);

    /* ---------- season + team info ---------- */
    async function getSeasonInfo(year) {
      const key = 'season:' + year;
      const c = cache.get(key);
      if (c && c.v && now() - c.at < 7 * DAY) return c.v;
      for (const path of [`/seasons/${year}?sportId=1`, `/seasons?sportId=1&season=${year}`]) {
        try {
          const d = await api(path, 'season ' + year);
          const s = d.seasons && d.seasons[0];
          if (s && s.regularSeasonStartDate) { cache.set(key, { at: now(), v: s }); return s; }
        } catch (e) { /* try the next form */ }
      }
      return (c && c.v) || null;                                    // stale cache beats nothing
    }
    const peekSeasonInfo = year => { const c = cache.get('season:' + year); return (c && c.v) || null; };

    function setTeamMeta(map) { Object.keys(teamMeta).forEach(k => delete teamMeta[k]); Object.assign(teamMeta, map); }
    function peekTeamsMeta() { const c = cache.get('teams'); if (c && c.v) setTeamMeta(c.v); }
    async function loadTeamsMeta(ctx) {
      const c = cache.get('teams');
      if (c && c.v && now() - c.at < 30 * DAY) { setTeamMeta(c.v); return teamMeta; }
      try {
        const d = await api(`/teams?sportId=1&season=${ctx.statsSeason}`, 'teams');
        const map = {};
        for (const t of d.teams || []) map[t.id] = { abbr: t.abbreviation, short: t.teamName, name: t.name };
        if (Object.keys(map).length) { setTeamMeta(map); cache.set('teams', { at: now(), v: map }); }
      } catch (e) { if (c && c.v) setTeamMeta(c.v); }
      return teamMeta;
    }

    /* ---------- standings / team stats ---------- */
    async function loadStandings(ctx) {
      const d = await api(`/standings?leagueId=103,104&season=${ctx.statsSeason}&standingsTypes=regularSeason`, 'standings');
      const out = {}, divisions = {};
      for (const div of d.records || []) {
        const divId = div.division && div.division.id;
        let hasOurs = false;
        for (const e of div.teamRecords || []) {
          const t = teamByMlbId(e.team && e.team.id);
          if (!t) continue;
          hasOurs = true;
          const l10 = ((e.records && e.records.splitRecords) || []).find(r => r.type === 'lastTen');
          out[t.abbr] = {
            wins: e.wins, losses: e.losses, pct: e.winningPercentage,
            divRank: e.divisionRank, divId, leagueId: div.league && div.league.id,
            gb: e.divisionGamesBack != null ? e.divisionGamesBack : e.gamesBack,
            streak: e.streak && e.streak.streakCode,
            l10: l10 ? `${l10.wins}-${l10.losses}` : null,
            rd: e.runDifferential, runsScored: e.runsScored, runsAllowed: e.runsAllowed, sportRank: e.sportRank,
            clinch: e.clinchIndicator || null,
            divChamp: e.divisionChamp === true || e.clinchIndicator === 'z' || e.clinchIndicator === 'y',
          };
        }
        if (hasOurs) divisions[divId] = (div.teamRecords || []).map(e => ({
          id: e.team && e.team.id, w: e.wins, l: e.losses, rank: e.divisionRank,
          gb: e.divisionGamesBack != null ? e.divisionGamesBack : e.gamesBack,
        }));
      }
      out.__divisions = divisions;
      return out;
    }

    async function loadTeamStats(ctx, group) {
      const d = await api(`/teams/stats?stats=season&group=${group}&season=${ctx.statsSeason}&sportId=1`, group);
      const out = {};
      const splits = (d.stats && d.stats[0] && d.stats[0].splits) || [];
      for (const sp of splits) {
        const t = teamByMlbId(sp.team && sp.team.id);
        if (!t) continue;
        const s = sp.stat || {};
        out[t.abbr] = group === 'hitting'
          ? { runs: s.runs, homeRuns: s.homeRuns, stolenBases: s.stolenBases }
          : { strikeouts: s.strikeOuts, runs: s.runs };
      }
      return out;
    }

    /* ---------- schedule ---------- */
    async function fetchGames(teamId, start, end, rich) {
      const path = `/schedule?sportId=1&teamId=${teamId}&startDate=${start}&endDate=${end}` + (rich ? '&hydrate=linescore,probablePitcher' : '');
      const d = await api(path, `schedule ${teamByMlbId(teamId).abbr} ${start}..${end}`);
      const games = [];
      for (const day of d.dates || []) for (const g of day.games || []) games.push(normGame(g, teamId));
      return games;
    }

    async function loadTeamSchedule(t, ctx, light, prev) {
      const today = ctx.today;
      const win = await fetchGames(t.id, addDays(today, -14), addDays(today, 30), true);
      const p = pickGames(win);
      const out = { live: p.live, last: p.last, next: p.next };
      const recentWin = recentFrom(win, 10);

      if (light) {                                    // quick live-score refresh: keep older facts if the window has none
        const pv = prev || {};
        if (!out.last) out.last = pv.last;
        if (!out.next) out.next = pv.next;
        out.ws = pv.ws; out.post = pv.post; out.postChecked = pv.postChecked;
        out.recent = recentWin.length ? recentWin : pv.recent;
        return out;
      }

      let all = win.slice();
      if (ctx.phase !== 'regular') {
        try {
          const s = ctx.statsSeason;
          const post = await fetchGames(t.id, `${s}-09-20`, `${s}-12-15`, false);
          all = all.concat(post);
          const info = postseasonInfo(post);
          out.post = info; out.ws = info && info.ws; out.postChecked = true;
          if (!out.last) out.last = pickGames(post).last;
        } catch (e) {
          const pv = prev || {};
          out.post = pv.post; out.ws = pv.ws; out.postChecked = pv.postChecked;
        }
      } else {
        out.post = null; out.ws = null; out.postChecked = false;
      }
      // Last game fell outside the window (offseason, or eliminated a while ago): look back through the stats season.
      if (!out.last && ctx.phase !== 'regular') {
        try {
          const s = ctx.statsSeason;
          const season = await fetchGames(t.id, `${s}-02-15`, `${s}-12-31`, false);
          all = all.concat(season);
          out.last = pickGames(season).last;
        } catch (e) { if (prev) out.last = prev.last; }
      }
      // No upcoming game within 30 days: find next season's opener (if the schedule is published yet).
      if (!out.next) {
        try {
          const fy = ctx.phase === 'before' ? ctx.year : ctx.year + 1;
          const from = addDays(today, 1) > `${fy}-02-01` ? addDays(today, 1) : `${fy}-02-01`;
          out.next = pickGames(await fetchGames(t.id, from, `${fy}-04-20`, true)).next;
        } catch (e) { if (prev) out.next = prev.next; }
      }
      if (out.next) out.next.opener = out.next.type === 'R' && String(out.next.season) !== String(ctx.statsSeason);
      out.recent = recentFrom(all, 10);
      return out;
    }

    async function loadSchedule(ctx, light, prevAll) {
      prevAll = prevAll || {};
      const settled = await Promise.allSettled(TEAMS.map(t => loadTeamSchedule(t, ctx, light, prevAll[t.abbr])));
      if (settled.every(r => r.status === 'rejected')) throw settled[0].reason;
      const out = {};
      settled.forEach((r, i) => { out[TEAMS[i].abbr] = r.status === 'fulfilled' ? r.value : (prevAll[TEAMS[i].abbr] || null); });
      return out;
    }

    /* ---------- snapshot used by the scheduled job ---------- */
    async function buildSnapshot(prev) {
      const today = etDay(new Date(now()));
      const info = await getSeasonInfo(Number(today.slice(0, 4)));
      const ctx = computeContext(today, info);
      const prevSections = (prev && prev.sections) || {};
      const jobs = {
        standings: loadStandings(ctx),
        hitting: loadTeamStats(ctx, 'hitting'),
        pitching: loadTeamStats(ctx, 'pitching'),
        schedule: loadSchedule(ctx, false, prevSections.schedule && prevSections.schedule.data),
        teams: loadTeamsMeta(ctx),
      };
      const keys = Object.keys(jobs);
      const results = await Promise.allSettled(Object.values(jobs));
      const sections = {}, errors = {};
      results.forEach((r, i) => {
        const k = keys[i];
        if (k === 'teams') return;
        if (r.status === 'fulfilled') sections[k] = { at: now(), season: ctx.statsSeason, data: r.value };
        else {
          errors[k] = (r.reason && r.reason.message) || String(r.reason);
          const old = prevSections[k];
          if (old && old.season === ctx.statsSeason) sections[k] = old;          // keep the last good copy
        }
      });
      return { v: 3, generatedAt: now(), ctx, seasonInfo: info, sections, errors, teamMeta: Object.assign({}, teamMeta) };
    }

    /* ---------- model: merge sections into one object per team ---------- */
    function buildModel(sections) {
      const out = {};
      const pick = (k, abbr) => (sections[k] && sections[k].data && sections[k].data[abbr]) || null;
      for (const t of TEAMS) {
        const st = pick('standings', t.abbr), hi = pick('hitting', t.abbr), pi = pick('pitching', t.abbr), sc = pick('schedule', t.abbr);
        const noGames = !!st && (st.wins + st.losses === 0);       // season hasn't produced any games yet
        const v = x => (noGames || x == null || x === '') ? null : Number(x);
        out[t.abbr] = {
          st, sc, noGames,
          runs: v(hi && hi.runs != null ? hi.runs : st && st.runsScored),
          homeRuns: v(hi && hi.homeRuns),
          stolenBases: v(hi && hi.stolenBases),
          strikeouts: v(pi && pi.strikeouts),
          runsAllowed: v(pi && pi.runs != null ? pi.runs : st && st.runsAllowed),
        };
      }
      return out;
    }

    function computeLeaders(model) {
      const out = {};
      for (const d of STAT_DEFS) {
        const vals = TEAMS.map(t => ({ a: t.abbr, v: model[t.abbr][d.key] })).filter(x => x.v != null);
        if (vals.length < 2 || vals.every(x => x.v === 0)) { out[d.key] = []; continue; }
        const best = d.low ? Math.min(...vals.map(x => x.v)) : Math.max(...vals.map(x => x.v));
        out[d.key] = vals.filter(x => x.v === best).map(x => x.a);
      }
      return out;
    }

    /* Most stars first; ties go to the better MLB rank, then win%. */
    function rankTeams(model, leaders) {
      const counts = Object.fromEntries(TEAMS.map(t => [t.abbr, 0]));
      STAT_DEFS.forEach(d => (leaders[d.key] || []).forEach(a => counts[a]++));
      return TEAMS.map(t => {
        const st = model[t.abbr].st, sc = model[t.abbr].sc;
        return { t, cats: counts[t.abbr], pct: st ? (parseFloat(st.pct) || 0) : 0, st, ws: sc && sc.ws, sportRank: st && st.sportRank ? Number(st.sportRank) : null };
      }).sort((a, b) => {
        if (b.cats !== a.cats) return b.cats - a.cats;
        if (a.sportRank != null && b.sportRank != null && a.sportRank !== b.sportRank) return a.sportRank - b.sportRank;
        return b.pct - a.pct;
      });
    }

    /* A completed season's record for the "Past Seasons" panel; null if any team's data is incomplete. */
    function makeHistoryEntry(ctx, model) {
      const teams = {};
      for (const t of TEAMS) {
        const m = model[t.abbr];
        if (!m.st || m.noGames || m.runs == null || m.homeRuns == null || m.strikeouts == null) return null;
        teams[t.abbr] = {
          owner: t.owner, name: t.name, wins: m.st.wins, losses: m.st.losses, runs: m.runs, homeRuns: m.homeRuns,
          stolenBases: m.stolenBases, strikeouts: m.strikeouts, runsAllowed: m.runsAllowed,
          ws: m.sc && m.sc.ws ? (m.sc.ws.champion ? 'champion' : 'finalist') : null,
        };
      }
      const order = rankTeams(model, computeLeaders(model)).map(r => r.t.abbr);
      return { season: ctx.statsSeason, savedAt: now(), teams, order };
    }

    /* One day's W-L for every team (for the season trend chart); null if incomplete. */
    function makeTrendPoint(ctx, model) {
      const t = {};
      for (const tm of TEAMS) {
        const m = model[tm.abbr];
        if (!m.st || m.noGames) return null;
        t[tm.abbr] = { w: m.st.wins, l: m.st.losses };
      }
      return { d: ctx.today, t };
    }

    return {
      TEAMS, teamMeta, getJSON, api, getSeasonInfo, peekSeasonInfo, loadTeamsMeta, peekTeamsMeta,
      loadStandings, loadTeamStats, loadSchedule, buildSnapshot,
      buildModel, computeLeaders, rankTeams, makeHistoryEntry, makeTrendPoint,
    };
  }

  /* Union of two trend series (same season); later arguments win on the same date. */
  function mergeTrend(season, ...series) {
    const byDate = {};
    series.forEach(s => { if (s && String(s.season) === String(season)) (s.points || []).forEach(p => { byDate[p.d] = p; }); });
    return { season, points: Object.keys(byDate).sort().map(d => byDate[d]) };
  }

  return {
    create, computeContext, etDay, addDays, normGame, pickGames, recentFrom, postseasonInfo, mergeTrend,
    STAT_DEFS, DIVISIONS, LEAGUES, ROUND_SHORT, ALLOWED_TYPES, DAY,
  };
});
