'use strict';
/* Shared fixtures: a fake MLB Stats API built from small hand-made data sets. */
/* ---------- mock data ---------- */
const META = {
  139: ['TB', 'Rays', 'Tampa Bay Rays'], 158: ['MIL', 'Brewers', 'Milwaukee Brewers'], 141: ['TOR', 'Blue Jays', 'Toronto Blue Jays'],
  113: ['CIN', 'Reds', 'Cincinnati Reds'], 147: ['NYY', 'Yankees', 'New York Yankees'], 111: ['BOS', 'Red Sox', 'Boston Red Sox'],
  112: ['CHC', 'Cubs', 'Chicago Cubs'], 119: ['LAD', 'Dodgers', 'Los Angeles Dodgers'], 138: ['STL', 'Cardinals', 'St. Louis Cardinals'],
  109: ['AZ', 'Diamondbacks', 'Arizona Diamondbacks'],
};
const teamsResp = { teams: Object.entries(META).map(([id, [abbr, teamName, name]]) => ({ id: Number(id), abbreviation: abbr, teamName, name })) };

function G(o) {
  const st = o.abstract === 'Final' ? { abstractGameState: 'Final', detailedState: o.detailed || 'Final', codedGameState: 'F' }
    : o.abstract === 'Live' ? { abstractGameState: 'Live', detailedState: o.detailed || 'In Progress', codedGameState: 'I' }
    : { abstractGameState: o.abstract || 'Preview', detailedState: o.detailed || 'Scheduled', codedGameState: 'S', startTimeTBD: !!o.tbd };
  const g = {
    gamePk: o.pk, gameDate: o.date, officialDate: o.official || o.date.slice(0, 10), gameType: o.type || 'R', season: o.season || o.date.slice(0, 4),
    status: st,
    teams: { home: { team: { id: o.home, name: META[o.home][2] } }, away: { team: { id: o.away, name: META[o.away][2] } } },
    _ls: o.ls,
  };
  if (o.hpp) g.teams.home.probablePitcher = { fullName: o.hpp };
  if (o.app) g.teams.away.probablePitcher = { fullName: o.app };
  if (o.hs != null) { g.teams.home.score = o.hs; g.teams.away.score = o.as; }
  return g;
}

function standingsResp(rows) {
  const byDiv = {};
  for (const [id, r] of Object.entries(rows)) {
    (byDiv[r.div] = byDiv[r.div] || []).push({
      team: { id: Number(id) }, wins: r.w, losses: r.l, winningPercentage: r.pct, divisionRank: String(r.rank), divisionGamesBack: r.gb, gamesBack: r.gb,
      streak: { streakCode: r.streak }, records: { splitRecords: [{ type: 'lastTen', wins: r.l10[0], losses: r.l10[1] }] },
      runDifferential: r.rd, runsScored: r.rs, runsAllowed: r.ra, sportRank: r.sr != null ? String(r.sr) : undefined,
      clinchIndicator: r.clinch, divisionChamp: r.champ,
    });
  }
  return { records: Object.entries(byDiv).map(([d, tr]) => ({ division: { id: Number(d) }, league: { id: Number(d) >= 203 ? 104 : 103 }, teamRecords: tr })) };
}
const statsResp = (rows, kind) => ({ stats: [{ splits: Object.entries(rows).map(([id, s]) => ({ team: { id: Number(id) }, stat: kind === 'h' ? { runs: s.rs, homeRuns: s.hr, stolenBases: s.sb } : { strikeOuts: s.k, runs: s.ra } })) }] });

const SEASON_INFO = y => ({ seasons: [{ seasonId: String(y), regularSeasonStartDate: `${y}-03-26`, regularSeasonEndDate: `${y}-09-27`, postSeasonEndDate: `${y}-11-01`, seasonEndDate: `${y}-11-01` }] });

const FULL = {
  standings: {
    139: { div: 201, w: 90, l: 72, pct: '.556', rank: 2, gb: '3.0', streak: 'W3', l10: [7, 3], rd: 45, rs: 780, ra: 700, sr: 14 },
    158: { div: 205, w: 95, l: 67, pct: '.586', rank: 1, gb: '-', streak: 'L1', l10: [5, 5], rd: 120, rs: 820, ra: 700, sr: 3 },
    141: { div: 201, w: 85, l: 77, pct: '.525', rank: 3, gb: '8.0', streak: 'W1', l10: [4, 6], rd: -5, rs: 760, ra: 765, sr: 9 },
    113: { div: 205, w: 70, l: 92, pct: '.432', rank: 4, gb: '25.0', streak: 'L5', l10: [2, 8], rd: -80, rs: 650, ra: 730, sr: 28 },
  },
  hit: { 139: { rs: 780, hr: 210, sb: 130 }, 158: { rs: 820, hr: 190, sb: 150 }, 141: { rs: 760, hr: 230, sb: 60 }, 113: { rs: 650, hr: 150, sb: 95 } },
  pit: { 139: { k: 1400, ra: 700 }, 158: { k: 1450, ra: 700 }, 141: { k: 1300, ra: 765 }, 113: { k: 1380, ra: 730 } },
};


function makeFetch(db, counters) {
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  return async (url) => {
    const u = new URL(url);
    if (u.hostname === 'raw.githubusercontent.com') {
      const file = u.pathname.split('/').pop();
      counters['raw:' + file] = (counters['raw:' + file] || 0) + 1;
      return db.raw && db.raw[file] ? resp(200, db.raw[file]) : resp(404, {});
    }
    const p = u.pathname.replace('/api/v1', '');
    const key = p.startsWith('/schedule') ? 'schedule' : p.startsWith('/seasons') ? 'seasons' : p.replace(/^\//, '').replace('/', '-') + (u.searchParams.get('group') ? ':' + u.searchParams.get('group') : '');
    counters[key] = (counters[key] || 0) + 1;
    const f = db.fail && db.fail(key, u);
    if (f === 'network') throw new TypeError('Failed to fetch');
    if (typeof f === 'number') return resp(f, {});
    if (p.startsWith('/seasons')) {
      const y = (p.match(/\/seasons\/(\d+)/) || [])[1] || u.searchParams.get('season');
      return db.noSeasonInfo ? resp(404, {}) : resp(200, SEASON_INFO(y));
    }
    if (p === '/teams') return resp(200, teamsResp);
    if (p === '/standings') return resp(200, standingsResp(db.standings));
    if (p === '/teams/stats') return resp(200, statsResp(u.searchParams.get('group') === 'hitting' ? db.hit : db.pit, u.searchParams.get('group') === 'hitting' ? 'h' : 'p'));
    if (p === '/schedule') {
      const team = Number(u.searchParams.get('teamId'));
      const s = u.searchParams.get('startDate'), e = u.searchParams.get('endDate');
      const hyd = (u.searchParams.get('hydrate') || '').includes('linescore');
      const games = db.games().filter(g => (g.teams.home.team.id === team || g.teams.away.team.id === team) && g.officialDate >= s && g.officialDate <= e)
        .map(g => { const c = JSON.parse(JSON.stringify(g)); if (hyd && g._ls) c.linescore = g._ls; delete c._ls; return c; });
      const dates = {};
      games.forEach(g => (dates[g.officialDate] = dates[g.officialDate] || []).push(g));
      return resp(200, { dates: Object.entries(dates).sort().map(([date, gs]) => ({ date, games: gs })) });
    }
    return resp(404, {});
  };
}


function makeChecker() {
  const r = { pass: 0, fail: 0 };
  r.check = (name, cond, detail = '') => {
    if (cond) { r.pass++; console.log('  ok   ' + name); }
    else { r.fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
  };
  return r;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
module.exports = { META, teamsResp, G, standingsResp, statsResp, SEASON_INFO, FULL, makeFetch, makeChecker, sleep };
