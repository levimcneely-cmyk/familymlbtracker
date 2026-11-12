/* ================================================================
   app.js — the page: state, rendering, refresh loop.
   Data logic lives in core.js; team settings live in config.js.
================================================================ */
(function () {
'use strict';

const CFG = window.MLBConfig, K = window.MLBCore;
const TEAMS = CFG.TEAMS;
const STAT_DEFS = K.STAT_DEFS, DIVISIONS = K.DIVISIONS, LEAGUES = K.LEAGUES, ROUND_SHORT = K.ROUND_SHORT;
const etDay = K.etDay, addDays = K.addDays;
const LS = { state: 'mlbft:state:v3', history: 'mlbft:history:v1', trend: 'mlbft:trend:v1', tz: 'mlbft:tz:v1', cache: 'mlbft:c:' };
const SNAPSHOT_MAX_AGE = 30 * 60e3;

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = n => (n == null || Number.isNaN(Number(n))) ? '—' : Number(n).toLocaleString('en-US');
const logoUrl = id => `https://www.mlbstatic.com/team-logos/${id}.svg`;
const ordinal = n => { n = Number(n); const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const ownerName = t => t.owner.replace(/'s Team$/, '');
const setHTML = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };

const store = {
  get(k, fallback = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
};

/* ---------- time zone (Eastern by default, or the viewer's own) ---------- */
let TZ = store.get(LS.tz) === 'local' ? 'local' : 'ET';
const fmtCache = {};
function fm(kind) {
  const key = TZ + kind;
  if (fmtCache[key]) return fmtCache[key];
  const tz = TZ === 'ET' ? 'America/New_York' : undefined;
  const o = { timeZone: tz };
  const specs = {
    wd: { weekday: 'short', month: 'short', day: 'numeric' },
    md: { month: 'short', day: 'numeric' },
    time: { hour: 'numeric', minute: '2-digit' },
    day: { year: 'numeric', month: '2-digit', day: '2-digit' },
    zone: { timeZoneName: 'short' },
  };
  return (fmtCache[key] = new Intl.DateTimeFormat('en-US', Object.assign(o, specs[kind])));
}
function dayIn(d) {
  const p = Object.fromEntries(fm('day').formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function tzShort() {
  if (TZ === 'ET') return 'ET';
  const p = fm('zone').formatToParts(new Date()).find(x => x.type === 'timeZoneName');
  return (p && p.value) || 'local';
}
const ymdLabel = ymd => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(ymd + 'T12:00:00Z'));

/* ---------- debug log ---------- */
const DEBUG = {
  log: [], raw: {},
  rec(label, url, status, ms, data, err) {
    this.log.unshift({ t: new Date().toLocaleTimeString(), label, url, status, ms, err: err || null });
    if (this.log.length > 60) this.log.length = 60;
    if (data !== undefined) this.raw[label] = data;
    renderDebug();
  },
};
window.addEventListener('error', e => DEBUG.rec('js error', '', 0, 0, undefined, e.message));
window.addEventListener('unhandledrejection', e => DEBUG.rec('promise rejection', '', 0, 0, undefined, String(e.reason && e.reason.message || e.reason)));

/* ---------- core instance ---------- */
const C = K.create({
  teams: TEAMS,
  base: CFG.MLB_BASE,
  log: (...a) => DEBUG.rec(...a),
  now: () => Date.now(),
  cache: { get: k => store.get(LS.cache + k), set: (k, v) => store.set(LS.cache + k, v) },
});
const TEAM_META = C.teamMeta;

/* ---------- state ---------- */
const STATE = {
  ctx: null,
  sections: { standings: null, hitting: null, pitching: null, schedule: null },
  errors: {},
  fetchedAt: null,
  attempted: false,
  fromCache: false,
  source: null,                       // 'snapshot' | 'mlb'
  remote: { history: null, trend: null },
};
let busy = false, lastFull = 0, lastLight = 0;
const expanded = new Set();
const SECTION_NAMES = { standings: 'standings', hitting: 'hitting stats', pitching: 'pitching stats', schedule: 'schedule' };
const anyLive = () => TEAMS.some(t => { const s = STATE.sections.schedule; return s && s.data && s.data[t.abbr] && s.data[t.abbr].live; });
const abbrOf = id => { const t = TEAMS.find(x => x.id === id); return t ? t.abbr : ((TEAM_META[id] && TEAM_META[id].abbr) || '?'); };

/* ================================================================
   Refresh
================================================================ */
async function fetchSnapshot(ctx) {
  if (!CFG.DATA_BASE) return null;
  try {
    const snap = await C.getJSON(CFG.DATA_BASE + 'snapshot.json', 'snapshot', { retries: 0, timeout: 7000 });
    const age = Date.now() - snap.generatedAt;
    const ok = snap && snap.v === 3 && snap.ctx && snap.ctx.statsSeason === ctx.statsSeason && snap.ctx.today === ctx.today && age >= 0 && age < SNAPSHOT_MAX_AGE;
    return ok ? snap : null;
  } catch (e) { return null; }
}
async function fetchRemoteExtras() {
  if (!CFG.DATA_BASE) return;
  const get = async name => { try { return await C.getJSON(CFG.DATA_BASE + name, name, { retries: 0, timeout: 7000 }); } catch (e) { return null; } };
  const [history, trend] = await Promise.all([get('history.json'), get('trend.json')]);
  if (history) STATE.remote.history = history;
  if (trend) STATE.remote.trend = trend;
}

async function refresh(mode = 'full') {
  if (busy) return;
  busy = true;
  const btn = $('refresh-btn');
  if (mode === 'full') {
    btn.textContent = 'Loading…';
    btn.classList.add('loading');
    setText('last-updated', 'Updating…');
  }
  const wasLive = anyLive();
  try {
    if (mode === 'full') {
      const today = etDay();
      const info = await C.getSeasonInfo(Number(today.slice(0, 4)));
      STATE.ctx = K.computeContext(today, info);
    } else if (STATE.ctx) {
      STATE.ctx = Object.assign({}, STATE.ctx, { today: etDay() });
    }
    const ctx = STATE.ctx || (STATE.ctx = K.computeContext(etDay(), null));

    let anyOk = false;
    const apply = (k, value) => { STATE.sections[k] = value; delete STATE.errors[k]; anyOk = true; };

    let snap = null;
    if (mode === 'full') {
      [snap] = await Promise.all([fetchSnapshot(ctx), fetchRemoteExtras()]);
    }
    if (snap) {
      for (const k of Object.keys(SECTION_NAMES)) {
        const sec = snap.sections && snap.sections[k];
        if (sec && sec.data && sec.season === ctx.statsSeason) apply(k, sec);
      }
      if (snap.teamMeta) Object.keys(snap.teamMeta).forEach(id => { TEAM_META[id] = snap.teamMeta[id]; });
      STATE.source = 'snapshot';
    }
    // Anything the snapshot didn't cover (or everything, without one) comes straight from MLB.
    const jobs = {};
    if (mode === 'light') jobs.schedule = C.loadSchedule(ctx, true, STATE.sections.schedule && STATE.sections.schedule.data);
    else {
      const need = k => !(snap && STATE.sections[k] && STATE.sections[k].at === (snap.sections[k] && snap.sections[k].at));
      if (need('standings')) jobs.standings = C.loadStandings(ctx);
      if (need('hitting')) jobs.hitting = C.loadTeamStats(ctx, 'hitting');
      if (need('pitching')) jobs.pitching = C.loadTeamStats(ctx, 'pitching');
      if (need('schedule')) jobs.schedule = C.loadSchedule(ctx, false, STATE.sections.schedule && STATE.sections.schedule.data);
      if (!Object.keys(TEAM_META).length) jobs.teams = C.loadTeamsMeta(ctx);
      if (!snap) STATE.source = 'mlb';
    }
    const keys = Object.keys(jobs);
    const results = await Promise.allSettled(Object.values(jobs));
    results.forEach((r, i) => {
      const k = keys[i];
      if (k === 'teams') return;
      if (r.status === 'fulfilled') apply(k, { at: Date.now(), season: ctx.statsSeason, data: r.value });
      else STATE.errors[k] = (r.reason && r.reason.message) || String(r.reason);
    });
    // Snapshot says a game is live: refresh the scores directly so they're not minutes old.
    if (snap && anyLive() && !jobs.schedule) {
      try { apply('schedule', { at: Date.now(), season: ctx.statsSeason, data: await C.loadSchedule(ctx, true, STATE.sections.schedule.data) }); STATE.source = 'snapshot+live'; }
      catch (e) { /* keep snapshot scores */ }
    }
    if (anyOk) { STATE.fetchedAt = Date.now(); STATE.fromCache = false; }
    STATE.attempted = true;
    if (mode === 'full') lastFull = Date.now();
    lastLight = Date.now();
    saveState();
    maybeSaveHistoryAndTrend();
    render();
    if (mode === 'light' && wasLive && !anyLive()) setTimeout(() => refresh('full'), 600);
  } catch (e) {
    STATE.attempted = true;
    DEBUG.rec('refresh', '', 0, 0, undefined, e && e.message);
    render();
  } finally {
    busy = false;
    btn.textContent = 'Refresh Stats';
    btn.classList.remove('loading');
    renderStatus();
  }
}

/* Auto-refresh only while a game is live or about to start, and only while the tab is visible. */
function startsSoon() {
  const s = STATE.sections.schedule;
  if (!s || !s.data) return false;
  return TEAMS.some(t => { const n = s.data[t.abbr] && s.data[t.abbr].next; return n && n.ms - Date.now() < 30 * 60e3 && n.ms - Date.now() > -3 * 3600e3; });
}
function autoTick() {
  if (document.hidden || busy || !navigator.onLine) return;
  const now = Date.now();
  if (anyLive()) {
    if (now - lastFull >= 5 * 60e3) refresh('full');
    else if (now - lastLight >= 45e3) refresh('light');
  } else if (startsSoon() && now - lastLight >= 2 * 60e3) {
    refresh('light');
  }
}
setInterval(autoTick, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastFull > 10 * 60e3) refresh('full'); });
window.addEventListener('online', () => refresh('full'));
window.addEventListener('offline', () => render());

/* ================================================================
   Persistence
================================================================ */
function saveState() {
  store.set(LS.state, { v: 3, savedAt: Date.now(), fetchedAt: STATE.fetchedAt, statsSeason: STATE.ctx && STATE.ctx.statsSeason, sections: STATE.sections });
}
function restoreState() {
  const today = etDay();
  const year = Number(today.slice(0, 4));
  STATE.ctx = K.computeContext(today, C.peekSeasonInfo(year));
  C.peekTeamsMeta();
  const saved = store.get(LS.state);
  if (saved && saved.v === 3 && saved.statsSeason === STATE.ctx.statsSeason && saved.sections) {
    STATE.sections = saved.sections;
    STATE.fetchedAt = saved.fetchedAt || saved.savedAt;
    STATE.attempted = true;
    STATE.fromCache = true;
  }
}

function localHistory() { return store.get(LS.history, {}) || {}; }
function allHistory() { return Object.assign({}, STATE.remote.history || {}, localHistory()); }
function localTrend() { return store.get(LS.trend); }
function allTrend(season) { return K.mergeTrend(season, STATE.remote.trend, localTrend()); }

function maybeSaveHistoryAndTrend() {
  const ctx = STATE.ctx;
  if (!ctx) return;
  const sec = STATE.sections;
  const fresh = ['standings', 'hitting', 'pitching'].every(k => sec[k] && sec[k].season === ctx.statsSeason && Date.now() - sec[k].at < 10 * 60e3 && !STATE.errors[k]);
  if (!fresh) return;
  const model = C.buildModel(sec);
  if (ctx.phase === 'after' || ctx.phase === 'before') {
    const entry = C.makeHistoryEntry(ctx, model);
    if (entry) { const h = localHistory(); h[ctx.statsSeason] = entry; store.set(LS.history, h); }
  } else {
    const pt = C.makeTrendPoint(ctx, model);
    if (pt) {
      const cur = localTrend();
      const base = cur && String(cur.season) === String(ctx.statsSeason) ? cur : { season: ctx.statsSeason, points: [] };
      base.points = base.points.filter(p => p.d !== pt.d).concat(pt).sort((a, b) => a.d < b.d ? -1 : 1);
      store.set(LS.trend, base);
    }
  }
}

/* ================================================================
   Rendering
================================================================ */
const arrow = '<span class="chev" aria-hidden="true">▾</span>';

function buildCards() {
  $('cards').innerHTML = TEAMS.map(t => {
    const a = t.abbr;
    const cells = STAT_DEFS.map(d => `<div class="stat-cell" id="${d.idp}-cell-${a}"><div class="stat-num" id="${d.idp}-${a}">—</div><div class="stat-lbl">${d.label}</div><span class="sr-only" id="${d.idp}-sr-${a}"></span></div>`).join('');
    return `
  <article class="team-card skeleton" id="card-${a}" aria-label="${esc(t.owner)}: ${esc(t.name)}" style="--g1:${t.g1};--g2:${t.g2};--accent:${t.accent};--stat:${t.stat}">
    <div class="card-badge" id="badge-${a}"></div>
    <div class="card-header">
      <div class="logo-circle" id="logo-${a}"><img src="${logoUrl(t.id)}" alt="${esc(t.name)} logo"></div>
      <div class="card-identity">
        <div class="owner-label">${esc(t.owner)}</div>
        <h3 class="team-name-label">${esc(t.name)}</h3>
      </div>
      <div class="record">
        <div class="record-num" id="rec-${a}">—</div>
        <div class="record-pct" id="pct-${a}">&nbsp;</div>
      </div>
    </div>
    <div class="live-strip" id="live-${a}"></div>
    <div class="card-meta" id="meta-${a}"></div>
    <div class="card-stats">${cells}</div>
    <div class="card-last-game">
      <div class="game-cell"><div class="game-val" id="prev-opp-${a}">—</div><div class="game-lbl">Prev Opponent</div></div>
      <div class="game-cell"><div class="game-val" id="last-score-${a}">—</div><div class="game-lbl" id="last-score-lbl-${a}">Last Score</div></div>
    </div>
    <div class="card-next-game">
      <div class="game-cell"><div class="game-val" id="next-opp-${a}">—</div><div class="game-lbl">Next Opponent</div></div>
      <div class="game-cell"><div class="game-val" id="next-date-${a}">—</div><div class="game-lbl" id="next-date-lbl-${a}">Next Game</div></div>
      <div class="game-cell"><div class="game-val" id="next-time-${a}">—</div><div class="game-lbl" id="next-time-lbl-${a}">Game Time (ET)</div></div>
    </div>
    <button class="expand-btn" id="exp-${a}" type="button" aria-expanded="false" aria-controls="detail-${a}"><span id="exp-lbl-${a}">Details</span>${arrow}</button>
    <div class="card-detail" id="detail-${a}" hidden></div>
  </article>`;
  }).join('');
  TEAMS.forEach(t => {
    const img = document.querySelector(`#logo-${t.abbr} img`);
    if (img) img.addEventListener('error', () => { $('logo-' + t.abbr).textContent = t.abbr; });
    $('exp-' + t.abbr).addEventListener('click', () => {
      const open = !expanded.has(t.abbr);
      open ? expanded.add(t.abbr) : expanded.delete(t.abbr);
      syncExpand(t.abbr);
    });
  });
}
function syncExpand(a) {
  const open = expanded.has(a);
  $('detail-' + a).hidden = !open;
  $('exp-' + a).setAttribute('aria-expanded', String(open));
  setText('exp-lbl-' + a, open ? 'Hide details' : 'Details');
}

function oppHTML(g) {
  if (!g) return '—';
  const meta = TEAM_META[g.oppId];
  const short = (meta && meta.short) || g.oppName || '?';
  const full = (meta && meta.name) || g.oppName || short;
  return `<span title="${esc(full)}">${g.isHome ? 'vs' : '@'} <img class="opp-logo" src="${logoUrl(g.oppId)}" alt="" onerror="this.remove()">${esc(short)}</span>`;
}

const PENNANT = '<svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="1" y="0" width="1.6" height="14" fill="currentColor"/><path d="M2.6 1.2 L15 5 L2.6 8.8 Z" fill="currentColor"/></svg>';

/* Season-status chips: pennant, division / wild card / playoff round, missed playoffs. */
function statusChips(m, ctx) {
  const st = m.st, sc = m.sc, post = sc && sc.post, chips = [];
  if (!st || m.noGames) return chips;
  const past = ctx.phase === 'after' || ctx.phase === 'before';
  const league = LEAGUES[st.leagueId] || '';
  if (post && post.leagueChamp) chips.push(`<span class="chip status pennant">${PENNANT}<span>${league ? esc(league) + ' ' : ''}Champions</span></span>`);
  if (st.divChamp) chips.push(`<span class="chip status">${past || post ? 'Division Champs' : 'Clinched Division'}</span>`);
  else if (st.clinch === 'w' || (post && !st.divChamp)) chips.push(`<span class="chip status">Wild Card</span>`);
  else if (st.clinch === 'x') chips.push(`<span class="chip status">Clinched Playoffs</span>`);
  if (post && post.round !== 'W') {
    const r = post.rounds[post.round], name = ROUND_SHORT[post.round];
    if (r.over && !r.won) chips.push(`<span class="chip status out">Out in ${esc(name)}</span>`);
    else if (r.over) chips.push(`<span class="chip status">Won ${esc(name)}</span>`);
    else chips.push(`<span class="chip status">${esc(name)} ${r.wins}–${r.losses}</span>`);
  } else if (!post && sc && sc.postChecked && past && !st.divChamp && st.clinch !== 'w' && st.clinch !== 'x') {
    chips.push(`<span class="chip status out">Missed Playoffs</span>`);
  } else if (!post && st.clinch === 'e' && !past) {
    chips.push(`<span class="chip status out">Eliminated</span>`);
  }
  return chips;
}

/* A family-vs-family game that is live now or starts within a week. */
function findShowdown(model) {
  const fam = new Set(TEAMS.map(t => t.id));
  const seen = new Map();
  for (const t of TEAMS) {
    const sc = model[t.abbr].sc;
    if (!sc) continue;
    for (const [kind, g] of [['live', sc.live], ['next', sc.next]]) {
      if (g && fam.has(g.oppId)) {
        const k = g.pk || kind + t.abbr;
        if (!seen.has(k)) seen.set(k, { kind, g, a: t, b: TEAMS.find(x => x.id === g.oppId) });
      }
    }
  }
  const list = [...seen.values()];
  const live = list.find(x => x.kind === 'live');
  if (live) return live;
  return list.filter(x => x.g.ms - Date.now() < 7 * 864e5).sort((x, y) => x.g.ms - y.g.ms)[0] || null;
}

function lastTenHTML(m) {
  const rec = m.sc && m.sc.recent;
  if (!rec || !rec.length) return '';
  const items = rec.map(g => {
    const res = g.my > g.their ? 'w' : g.my < g.their ? 'l' : 't';
    return `<li class="${res}"><b>${res.toUpperCase()}</b><span>${g.my}–${g.their}</span><span class="o">${g.isHome ? 'vs' : '@'} ${esc(abbrOf(g.oppId))}</span></li>`;
  }).join('');
  return `<div class="d-sec"><h4>Last ${rec.length} games</h4><ul class="l10">${items}</ul></div>`;
}
function pitchersHTML(t, m) {
  const n = m.sc && m.sc.next;
  if (!n || (!n.myPP && !n.theirPP)) return '';
  return `<div class="d-sec"><h4>Probable pitchers</h4><div>${esc(t.abbr)}: ${esc(n.myPP || 'TBD')} · ${esc(abbrOf(n.oppId))}: ${esc(n.theirPP || 'TBD')}</div></div>`;
}
function divisionHTML(t, m) {
  const st = m.st, sec = STATE.sections.standings;
  const div = st && sec && sec.data && sec.data.__divisions && sec.data.__divisions[st.divId];
  if (!div || !div.length) return '';
  const rows = div.slice().sort((a, b) => Number(a.rank) - Number(b.rank)).map(r => `<tr class="${r.id === t.id ? 'me' : ''}"><td>${esc(r.rank)}. ${esc(abbrOf(r.id))}</td><td>${r.w}-${r.l}</td><td>${r.gb == null || r.gb === '-' ? '—' : esc(r.gb)}</td></tr>`).join('');
  return `<div class="d-sec"><h4>${esc(DIVISIONS[st.divId] || 'Division')}</h4><table class="dt"><tr><th>Team</th><th>W-L</th><th>GB</th></tr>${rows}</table></div>`;
}
function lineScoreHTML(t, m) {
  const live = m.sc && m.sc.live;
  if (!live || !live.rhe || !live.rhe.my) return '';
  const row = (ab, x) => `<tr><td>${esc(ab)}</td><td>${x && x.r != null ? x.r : '—'}</td><td>${x && x.h != null ? x.h : '—'}</td><td>${x && x.e != null ? x.e : '—'}</td></tr>`;
  return `<div class="d-sec"><h4>Live line score</h4><table class="dt"><tr><th>Team</th><th>R</th><th>H</th><th>E</th></tr>${row(t.abbr, live.rhe.my)}${row(abbrOf(live.oppId), live.rhe.their)}</table></div>`;
}
function detailHTML(t, m) {
  const html = lineScoreHTML(t, m) + lastTenHTML(m) + pitchersHTML(t, m) + divisionHTML(t, m);
  return html || '<div class="d-note">No extra details yet.</div>';
}

function renderTeam(t, m, ctx, showdown) {
  const a = t.abbr, st = m.st;
  $('card-' + a).classList.toggle('skeleton', !STATE.attempted);

  setText('rec-' + a, st ? `${st.wins}-${st.losses}` : '—');
  setText('pct-' + a, st ? (m.noGames ? 'no games yet' : `${(st.pct || '').toString().replace(/^0(?=\.)/, '') || '.000'} win%`) : ' ');
  STAT_DEFS.forEach(d => setText(`${d.idp}-${a}`, m[d.key] == null ? '—' : fmtNum(m[d.key])));

  const chips = statusChips(m, ctx);
  if (st && !m.noGames) {
    if (st.divRank) chips.push(`<span class="chip">${ordinal(st.divRank)} ${esc(DIVISIONS[st.divId] || '')}</span>`);
    if (st.sportRank) chips.push(`<span class="chip">MLB #${esc(st.sportRank)}</span>`);
    if (st.gb != null && st.gb !== '-' && st.gb !== '0.0' && Number(st.divRank) !== 1) chips.push(`<span class="chip">${esc(st.gb)} GB</span>`);
    if (st.streak) chips.push(`<span class="chip ${/^W/.test(st.streak) ? 'res-w' : 'res-l'}">${esc(st.streak)}</span>`);
    if (st.l10) chips.push(`<span class="chip">L10 ${esc(st.l10)}</span>`);
    if (st.rd != null) chips.push(`<span class="chip">RD ${st.rd > 0 ? '+' : ''}${st.rd}</span>`);
  }
  if (showdown && (showdown.a === t || showdown.b === t)) {
    const other = showdown.a === t ? showdown.b : showdown.a;
    chips.unshift(`<span class="chip status fam">⚔ vs ${esc(ownerName(other))}</span>`);
  }
  setHTML('meta-' + a, chips.join(''));

  // World Series banner
  const ws = m.sc && m.sc.ws;
  const badge = $('badge-' + a), card = $('card-' + a);
  card.classList.toggle('champion', !!(ws && ws.champion));
  if (ws && ws.champion) {
    badge.className = 'card-badge champ';
    badge.innerHTML = `<div class="champ-banner"><span>🏆</span><span>${esc(ws.season || ctx.statsSeason)} World Series Champions</span><span>🏆</span></div>`;
  } else if (ws) {
    const txt = ws.over ? `${ws.season || ctx.statsSeason} World Series · Runner-Up` : `World Series · ${ws.wins}–${ws.losses}`;
    badge.className = 'card-badge';
    badge.innerHTML = `<div class="ws-banner ${ws.over ? 'second' : 'series'}"><span>⚾</span><span>${esc(txt)}</span><span>⚾</span></div>`;
  } else {
    badge.className = 'card-badge';
    badge.innerHTML = '';
  }

  // Live strip
  const sc = m.sc, live = sc && sc.live;
  const strip = $('live-' + a);
  if (live) {
    const state = (!live.detailed || /in progress/i.test(live.detailed)) ? `${live.half || ''} ${live.inning || ''}`.trim() : live.detailed;
    strip.innerHTML = `<span class="live-dot"></span><span class="live-tag">LIVE</span><span>${oppHTML(live)}</span><span class="live-score">${live.my ?? 0}–${live.their ?? 0}</span><span>${esc(state)}</span>`;
    strip.classList.add('on');
  } else {
    strip.innerHTML = '';
    strip.classList.remove('on');
  }

  // Previous game
  const today = dayIn(new Date());
  const last = sc && sc.last;
  setHTML('prev-opp-' + a, last ? oppHTML(last) : (sc ? 'None yet' : '—'));
  if (last) {
    const res = last.my > last.their ? 'W' : last.my < last.their ? 'L' : 'T';
    const extra = (last.innings && last.sched && last.innings !== last.sched) ? ` (F/${last.innings})` : '';
    setHTML('last-score-' + a, `<span class="${res === 'W' ? 'res-w' : res === 'L' ? 'res-l' : ''}">${res} ${last.my}–${last.their}</span>${extra}`);
    const day = dayIn(new Date(last.ms));
    setText('last-score-lbl-' + a, 'Last Score · ' + (day === today ? 'Today' : fm('md').format(new Date(last.ms))));
  } else {
    setText('last-score-' + a, '—');
    setText('last-score-lbl-' + a, 'Last Score');
  }

  // Next game
  const next = sc && sc.next;
  setText('next-time-lbl-' + a, `Game Time (${tzShort()})`);
  if (next) {
    const day = dayIn(new Date(next.ms));
    const dateStr = day === today ? 'Today' : day === addDays(today, 1) ? 'Tomorrow' : fm('wd').format(new Date(next.ms));
    setHTML('next-opp-' + a, oppHTML(next));
    setText('next-date-' + a, dateStr);
    setText('next-time-' + a, next.tbd ? 'TBD' : fm('time').format(new Date(next.ms)));
    setText('next-date-lbl-' + a, next.opener ? 'Opening Day' : 'Next Game');
  } else {
    setText('next-opp-' + a, sc ? 'TBA' : '—');
    setText('next-date-' + a, '—');
    setText('next-time-' + a, '—');
    setText('next-date-lbl-' + a, 'Next Game');
  }

  setHTML('detail-' + a, detailHTML(t, m));
  syncExpand(a);
}

function renderShowdown(sd) {
  const wrap = $('showdown-wrap');
  if (!sd) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const { a, b, g, kind } = sd;
  const nick = t => (TEAM_META[t.id] && TEAM_META[t.id].short) || t.name.split(' ').pop();
  const names = `${esc(ownerName(a))}'s ${esc(nick(a))} ${g.isHome ? 'vs' : '@'} ${esc(ownerName(b))}'s ${esc(nick(b))}`;
  let when;
  if (kind === 'live') {
    const state = `${g.half || ''} ${g.inning || ''}`.trim();
    when = `<span class="sd-live">LIVE</span> · ${g.my ?? 0}–${g.their ?? 0} (${esc(a.abbr)}–${esc(b.abbr)}) ${esc(state)}`;
  } else {
    const today = dayIn(new Date()), day = dayIn(new Date(g.ms));
    const d = day === today ? 'Today' : day === addDays(today, 1) ? 'Tomorrow' : fm('wd').format(new Date(g.ms));
    when = `${esc(d)} · ${g.tbd ? 'time TBD' : esc(fm('time').format(new Date(g.ms))) + ' ' + esc(tzShort())}`;
  }
  setHTML('showdown', `<b>⚔ Family showdown</b><div>${names}</div><div class="sd-when">${when}</div>`);
}

function renderLeaderboard(model, leaders, ctx) {
  const wrap = $('leaderboard-wrap');
  const haveData = TEAMS.some(t => model[t.abbr].st);
  if (!STATE.attempted || !haveData) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const ranked = C.rankTeams(model, leaders);
  const over = ctx.phase === 'after' || ctx.phase === 'before';
  const anyLeaders = STAT_DEFS.some(d => (leaders[d.key] || []).length);
  const title = over ? `Final ${ctx.statsSeason} Standings` : 'Family Leaderboard';
  let html = `<div class="lb-title"><h2>${esc(title)}</h2><small>★ = categories led · ties go to MLB rank</small></div>`;
  if (!anyLeaders) {
    html += `<div class="lb-empty">Waiting for the season to get going — nobody leads a category yet.</div>`;
  } else {
    if (over) html += `<div class="lb-champ">👑 ${esc(ownerName(ranked[0].t))} wins the family title for ${ctx.statsSeason}</div>`;
    html += ranked.map((r, i) => `
      <div class="lb-row${i === 0 ? ' first' : ''}">
        <span class="lb-rank">${i + 1}</span>
        <img class="lb-logo" src="${logoUrl(r.t.id)}" alt="" onerror="this.style.visibility='hidden'">
        <span class="lb-owner">${esc(ownerName(r.t))} <span class="lb-rec">· ${esc(r.t.abbr)}</span>${r.ws ? (r.ws.champion ? ' 🏆' : ' <span class="lb-tag">WS</span>') : ''}</span>
        <span class="lb-rec">${r.st ? `${r.st.wins}-${r.st.losses}` : '—'}</span>
        <span class="lb-stars" aria-label="${r.cats} categories led">★ ${r.cats}</span>
      </div>`).join('');
  }
  setHTML('leaderboard', html);
}

function renderHistory() {
  const hist = allHistory();
  const seasons = Object.keys(hist).sort((a, b) => b - a);
  const wrap = $('history-wrap');
  if (!seasons.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const el = $('history');
  const wasOpen = el.open;
  const shared = !!STATE.remote.history;
  el.innerHTML = `<summary>Past Seasons (${seasons.length})</summary>` + seasons.map(s => {
    const h = hist[s];
    const rows = (h.order || Object.keys(h.teams)).filter(a => h.teams[a]).map((a, i) => {
      const x = h.teams[a];
      return `<tr class="${i === 0 ? 'champ' : ''}"><td>${i === 0 ? '👑 ' : ''}${esc(x.owner.replace(/'s Team$/, ''))} · ${esc(a)}${x.ws === 'champion' ? ' 🏆' : x.ws === 'finalist' ? ' <span class="lb-tag">WS</span>' : ''}</td><td>${x.wins}-${x.losses}</td><td>${fmtNum(x.runs)}</td><td>${fmtNum(x.homeRuns)}</td><td>${fmtNum(x.stolenBases)}</td><td>${fmtNum(x.strikeouts)}</td><td>${fmtNum(x.runsAllowed)}</td></tr>`;
    }).join('');
    return `<div class="hist-season"><h3>${esc(s)} Season</h3><table class="hist"><tr><th>Team</th><th>W-L</th><th>R</th><th>HR</th><th>SB</th><th>K</th><th>RA</th></tr>${rows}</table></div>`;
  }).join('') + `<div class="hist-actions"><button class="small" type="button" id="hist-copy">Copy backup</button><span id="hist-msg">${shared ? 'Shared across devices.' : 'Saved on this device/browser only.'}</span></div>`;
  el.open = wasOpen;
  $('hist-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(hist, null, 2)); setText('hist-msg', 'Copied to clipboard.'); }
    catch (e) { setText('hist-msg', 'Copy failed — your browser blocked clipboard access.'); }
  });
}

/* Season trend: games above/below .500 for each team, one point per day. */
function trendSVG(points) {
  const W = 440, H = 210, L = 34, R = 46, T = 12, B = 24;
  const vals = p => TEAMS.map(t => p.t[t.abbr] ? p.t[t.abbr].w - p.t[t.abbr].l : null);
  const all = points.flatMap(vals).filter(v => v != null).concat(0);
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 4) { hi += 2; lo -= 2; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const day = d => Date.parse(d + 'T12:00:00Z') / 864e5;
  const d0 = day(points[0].d), d1 = day(points[points.length - 1].d) || d0 + 1;
  const x = d => L + (d1 === d0 ? 0 : (day(d) - d0) / (d1 - d0)) * (W - L - R);
  const y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const step = [1, 2, 5, 10, 20, 50].find(s => (hi - lo) / s <= 5) || 100;
  let grid = '';
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${v === 0 ? '#777' : '#2a2a2a'}" stroke-width="${v === 0 ? 1.2 : 1}"${v === 0 ? ' stroke-dasharray="4 3"' : ''}/><text x="${L - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${v > 0 ? '+' + v : v}</text>`;
  }
  const lines = [], labels = [];
  TEAMS.forEach((t, i) => {
    const pts = points.map(p => { const v = vals(p)[i]; return v == null ? null : [x(p.d), y(v), v]; }).filter(Boolean);
    if (!pts.length) return;
    lines.push(`<polyline fill="none" stroke="${t.line}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}"/>`);
    const e = pts[pts.length - 1];
    lines.push(`<circle cx="${e[0].toFixed(1)}" cy="${e[1].toFixed(1)}" r="4" fill="${t.line}" stroke="#151515" stroke-width="2"/>`);
    labels.push({ abbr: t.abbr, y: e[1], v: e[2], color: t.line });
  });
  labels.sort((a, b) => a.y - b.y);                          // nudge apart so end labels never overlap
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 12) labels[i].y = labels[i - 1].y + 12;
  const lab = labels.map(l => `<text x="${W - R + 8}" y="${(l.y + 3.5).toFixed(1)}" style="fill:#e6e6e6;font-weight:600">${esc(l.abbr)}</text>`).join('');
  const xl = `<text x="${L}" y="${H - 6}">${esc(ymdLabel(points[0].d))}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${esc(ymdLabel(points[points.length - 1].d))}</text>`;
  return `<svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Wins above .500 over the season">${grid}${lines.join('')}${lab}${xl}</svg>`;
}
function renderTrend() {
  const wrap = $('trend-wrap'), ctx = STATE.ctx;
  if (!ctx) { wrap.hidden = true; return; }
  const tr = allTrend(ctx.statsSeason), pts = tr.points;
  if (!pts.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const el = $('trend'), wasOpen = el.open;
  const last = pts[pts.length - 1];
  const summary = TEAMS.map(t => { const p = last.t[t.abbr]; return p ? `${t.abbr} ${p.w - p.l >= 0 ? '+' : ''}${p.w - p.l}` : null; }).filter(Boolean).join(', ');
  let body;
  if (pts.length < 2) body = `<div class="trend-cap">The chart fills in as the season goes — one point is saved per day. Today: ${esc(summary)}.</div>`;
  else {
    body = `<div class="trend-cap">Games above/below .500 (wins minus losses), ${esc(String(ctx.statsSeason))}. Latest: ${esc(summary)}.</div>${trendSVG(pts)}` +
      `<div class="trend-legend">${TEAMS.map(t => `<span><i style="background:${t.line}"></i>${esc(ownerName(t))} · ${esc(t.abbr)}</span>`).join('')}</div>`;
  }
  el.innerHTML = `<summary>Season Trend</summary>${body}`;
  el.open = wasOpen;
}

function seasonTagText(ctx) {
  switch (ctx.phase) {
    case 'regular':    return `${ctx.year} Season`;
    case 'postseason': return `${ctx.year} Postseason`;
    case 'after':      return `Final ${ctx.year}`;
    default:           return `Final ${ctx.statsSeason} · ${ctx.year} starts ${ymdLabel(ctx.regStart)}`;
  }
}

function renderBanner() {
  const el = $('banner');
  const when = STATE.fetchedAt ? new Date(STATE.fetchedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  const failed = Object.keys(STATE.errors).map(k => SECTION_NAMES[k] || k);
  let kind = null, msg = '';
  if (!navigator.onLine) {
    kind = 'warn'; msg = when ? `You're offline — showing saved data from ${when}.` : `You're offline and nothing is saved yet.`;
  } else if (failed.length) {
    const noData = Object.keys(STATE.errors).filter(k => !STATE.sections[k]).map(k => SECTION_NAMES[k] || k);
    if (noData.length === Object.keys(SECTION_NAMES).length) { kind = 'error'; msg = `Couldn't reach MLB's stats service. Try again in a minute.`; }
    else { kind = 'warn'; msg = `Couldn't refresh ${failed.join(', ')}${when ? ` — showing the last saved data (${when})` : ''}.`; }
  } else if (STATE.fromCache && !STATE.fetchedAt) {
    kind = 'info'; msg = 'Refreshing…';
  } else if (STATE.fromCache) {
    kind = 'info'; msg = `Showing saved data from ${when} — refreshing…`;
  }
  el.hidden = !kind;
  if (kind) { el.className = 'banner ' + kind; el.textContent = msg; }
}

function renderStatus() {
  if (busy && $('refresh-btn').classList.contains('loading')) return;
  const el = $('last-updated');
  if (!STATE.fetchedAt) { el.textContent = STATE.attempted ? 'No data loaded yet' : 'Loading…'; return; }
  const d = new Date(STATE.fetchedAt);
  const stamp = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay = etDay(d) === etDay();
  let txt = (STATE.fromCache ? 'Saved ' : 'Updated ') + (sameDay ? 'at ' + stamp : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + stamp);
  if (anyLive()) txt += ' · live, auto-updating';
  el.textContent = txt;
}

/* Screen-reader announcements for live score / inning changes and final scores. */
const lastLiveKey = {};
let announceReady = false;
function announce(model) {
  const msgs = [];
  for (const t of TEAMS) {
    const sc = model[t.abbr].sc, live = sc && sc.live;
    const key = live ? `${live.my}-${live.their}-${live.half}-${live.inning}` : '';
    if (announceReady && key !== lastLiveKey[t.abbr]) {
      if (live) msgs.push(`${t.name} ${live.isHome ? 'vs' : 'at'} ${(TEAM_META[live.oppId] && TEAM_META[live.oppId].short) || live.oppName}: ${live.my} to ${live.their}, ${live.half || ''} ${live.inning || ''}`.trim());
      else if (sc && sc.last && lastLiveKey[t.abbr]) msgs.push(`Final: ${t.name} ${sc.last.my > sc.last.their ? 'won' : 'lost'} ${sc.last.my} to ${sc.last.their}`);
    }
    lastLiveKey[t.abbr] = key;
  }
  if (STATE.attempted) announceReady = true;
  if (msgs.length) setText('announcer', msgs.join('. '));
}

function render() {
  const ctx = STATE.ctx;
  if (!ctx) return;
  setText('season-tag', seasonTagText(ctx));
  const model = C.buildModel(STATE.sections);
  const leaders = C.computeLeaders(model);
  const showdown = findShowdown(model);
  TEAMS.forEach(t => {
    renderTeam(t, model[t.abbr], ctx, showdown);
    STAT_DEFS.forEach(d => {
      const lead = (leaders[d.key] || []).includes(t.abbr);
      $(`${d.idp}-cell-${t.abbr}`).classList.toggle('leader', lead);
      setText(`${d.idp}-sr-${t.abbr}`, lead ? ' — leads the family' : '');
    });
  });
  const ranked = C.rankTeams(model, leaders);
  const cont = $('cards');
  const want = ranked.map(r => 'card-' + r.t.abbr).join();
  if (want !== Array.from(cont.children).map(c => c.id).join()) ranked.forEach(r => cont.appendChild($('card-' + r.t.abbr)));
  renderShowdown(showdown);
  renderLeaderboard(model, leaders, ctx);
  renderTrend();
  renderHistory();
  renderBanner();
  renderStatus();
  announce(model);
  setText('tz-btn', `Times: ${TZ === 'ET' ? 'ET' : tzShort()}`);
  renderDebug();
}

/* ================================================================
   Debug panel
================================================================ */
function renderDebug() {
  const wrap = $('debug-wrap');
  if (!wrap || wrap.hidden) return;
  const sec = STATE.sections;
  const age = k => sec[k] ? Math.round((Date.now() - sec[k].at) / 1000) + 's ago' : 'none';
  setText('dbg-state', [
    'phase: ' + (STATE.ctx ? `${STATE.ctx.phase} (stats season ${STATE.ctx.statsSeason}${STATE.ctx.approx ? ', approximate dates' : ''})` : '—'),
    'source: ' + (STATE.source || '—'),
    'sections: ' + Object.keys(SECTION_NAMES).map(k => `${k}=${age(k)}`).join('  '),
    'errors: ' + (Object.keys(STATE.errors).length ? JSON.stringify(STATE.errors) : 'none'),
    'online: ' + navigator.onLine,
  ].join('\n'));
  $('dbg-log').innerHTML = DEBUG.log.slice(0, 14).map(r => `<tr><td>${esc(r.t)}</td><td>${esc(r.label)}</td><td class="${r.err ? 'bad' : ''}">${r.err ? esc(r.err) : r.status}</td><td>${r.ms}ms</td></tr>`).join('');
  const sel = $('dbg-select');
  const keys = Object.keys(DEBUG.raw);
  if (sel.options.length !== keys.length) {
    const cur = sel.value;
    sel.innerHTML = keys.map(k => `<option>${esc(k)}</option>`).join('');
    if (keys.includes(cur)) sel.value = cur;
  }
  const k = sel.value || keys[0];
  if (k) { const s = JSON.stringify(DEBUG.raw[k], null, 1); $('dbg-raw').textContent = s.length > 6000 ? s.slice(0, 6000) + '\n… (truncated)' : s; }
}
$('debug-toggle').addEventListener('click', () => { const w = $('debug-wrap'); w.hidden = !w.hidden; renderDebug(); });
$('dbg-select').addEventListener('change', renderDebug);
$('dbg-copy').addEventListener('click', async () => {
  const report = {
    at: new Date().toISOString(), ua: navigator.userAgent, ctx: STATE.ctx, errors: STATE.errors, source: STATE.source,
    sectionAges: Object.fromEntries(Object.keys(SECTION_NAMES).map(k => [k, STATE.sections[k] ? STATE.sections[k].at : null])),
    log: DEBUG.log,
    raw: Object.fromEntries(Object.entries(DEBUG.raw).map(([k, v]) => [k, JSON.stringify(v).slice(0, 3000)])),
  };
  try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); $('dbg-copy').textContent = 'Copied'; }
  catch (e) { $('dbg-copy').textContent = 'Copy failed'; }
  setTimeout(() => { $('dbg-copy').textContent = 'Copy report'; }, 2000);
});

/* ================================================================
   Boot
================================================================ */
window.loadStats = () => refresh('full');
window.__tracker = { STATE, refresh, render, get busy() { return busy; } };          // handy for debugging and tests
$('refresh-btn').addEventListener('click', () => refresh('full'));
$('tz-btn').addEventListener('click', () => {
  TZ = TZ === 'ET' ? 'local' : 'ET';
  store.set(LS.tz, TZ);
  render();
});

buildCards();
restoreState();
if (/[?&]debug\b/.test(location.search)) $('debug-wrap').hidden = false;
render();
refresh('full');

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
})();
