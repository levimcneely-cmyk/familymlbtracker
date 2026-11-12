const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
// Build one self-contained page: inline the scripts (jsdom won't fetch files) and drop external CSS/fonts.
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .replace(/<link[^>]+(stylesheet|manifest|icon)[^>]*>/g, '')
  .replace(/<script src="([^"]+)"><\/script>/g, (m, src) => '<script>' + fs.readFileSync(path.join(ROOT, src), 'utf8') + '</script>');
process.env.TZ = 'America/Los_Angeles';        // viewer's zone for the time-zone toggle test; Eastern is explicit everywhere else

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { META, teamsResp, G, standingsResp, statsResp, SEASON_INFO, FULL, makeFetch } = require('./mock');
const gamesAref = null;

/* ---------- harness ---------- */
async function boot(nowMs, db, seedLS) {
  const counters = {};
  const vc = new VirtualConsole(); // swallow jsdom "not implemented" noise
  const dom = new JSDOM(html, {
    url: 'https://family.example/tracker/index.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      const RD = w.Date;
      class FD extends RD {
        constructor(...a) { if (a.length === 0) super(FD._now); else super(...a); }
        static now() { return FD._now; }
      }
      FD._now = nowMs; w.Date = FD; w.FD = FD;
      w.fetch = makeFetch(db, counters);
      if (seedLS) for (const [k, v] of Object.entries(seedLS)) w.localStorage.setItem(k, v);
    },
  });
  const w = dom.window;
  await sleep(50);
  const idle = async () => { for (let i = 0; i < 400; i++) { if (!w.__tracker.busy) return; await sleep(25); } };
  await idle();
  const T = id => w.document.getElementById(id);
  return { w, dom, counters, idle, T, text: id => (T(id) ? T(id).textContent.trim() : null), html: id => (T(id) ? T(id).innerHTML : null), db };
}
const ls = w => Object.fromEntries(Object.keys(w.localStorage).map(k => [k, w.localStorage.getItem(k)]));

/* ================= Scenario A: offseason (after season) ================= */
async function scenarioA() {
  console.log('\nA) Nov 12 2026 — offseason, final stats, next-season fallback');
  const games = () => [
    G({ pk: 1, date: '2026-09-27T18:10:00Z', home: 139, away: 147, hs: 4, as: 2, abstract: 'Final' }),                       // TB last
    G({ pk: 2, date: '2026-10-02T23:00:00Z', home: 119, away: 158, hs: 5, as: 3, abstract: 'Final', type: 'D' }),          // MIL last (postseason, away loss)
    G({ pk: 3, date: '2026-09-27T18:05:00Z', home: 111, away: 141, hs: 1, as: 6, abstract: 'Final' }),                      // TOR last
    G({ pk: 4, date: '2026-09-27T19:10:00Z', home: 113, away: 138, hs: 2, as: 3, abstract: 'Final' }),                      // CIN last
    G({ pk: 10, date: '2027-02-25T18:05:00Z', home: 139, away: 111, abstract: 'Preview', type: 'S', season: '2027' }),     // spring training -> must be ignored
    G({ pk: 11, date: '2027-03-26T20:10:00Z', home: 139, away: 111, abstract: 'Preview', season: '2027' }),                 // TB opener 4:10 PM ET
    G({ pk: 12, date: '2027-03-26T18:20:00Z', home: 112, away: 158, abstract: 'Preview', season: '2027' }),                 // MIL opener @CHC
    G({ pk: 13, date: '2027-03-26T20:00:00Z', home: 141, away: 147, abstract: 'Preview', season: '2027', tbd: true }),      // TOR opener TBD time
  ];
  const a = await boot(Date.UTC(2026, 10, 12, 13, 13), { ...FULL, games });
  const { text, html, T, w } = a;
  check('season tag = Final 2026', text('season-tag') === 'Final 2026', text('season-tag'));
  check('TB record 90-72', text('rec-TB') === '90-72', text('rec-TB'));
  check('CIN stat cells populated', text('r-CIN') === '650' && text('k-CIN') === '1,380' && text('ra-CIN') === '730', `${text('r-CIN')} ${text('k-CIN')} ${text('ra-CIN')}`);
  check('meta chips (division / GB / streak / L10 / RD)', /2nd AL East/.test(text('meta-TB')) && /3\.0 GB/.test(text('meta-TB')) && /W3/.test(text('meta-TB')) && /L10 7-3/.test(text('meta-TB')) && /RD \+45/.test(text('meta-TB')), text('meta-TB'));
  check('division leader shows no GB chip', !/GB/.test(text('meta-MIL')), text('meta-MIL'));
  check('TB prev game = vs Yankees, W 4–2', /vs Yankees/.test(text('prev-opp-TB')) && text('last-score-TB') === 'W 4–2', text('prev-opp-TB') + ' | ' + text('last-score-TB'));
  check('MIL last game is the postseason loss @ Dodgers, L 3–5', /@ Dodgers/.test(text('prev-opp-MIL')) && text('last-score-MIL') === 'L 3–5', text('prev-opp-MIL') + ' | ' + text('last-score-MIL'));
  check('last score label carries date', /Last Score · Oct 2/.test(text('last-score-lbl-MIL')), text('last-score-lbl-MIL'));
  check('TB next = 2027 opener vs Red Sox, ignores spring training', /vs Red Sox/.test(text('next-opp-TB')) && text('next-date-TB') === 'Fri, Mar 26' && text('next-time-TB') === '4:10 PM', `${text('next-opp-TB')} | ${text('next-date-TB')} | ${text('next-time-TB')}`);
  check('opener labelled "Opening Day"', text('next-date-lbl-TB') === 'Opening Day', text('next-date-lbl-TB'));
  check('MIL opener @ Cubs 2:20 PM ET', /@ Cubs/.test(text('next-opp-MIL')) && text('next-time-MIL') === '2:20 PM', text('next-opp-MIL') + ' | ' + text('next-time-MIL'));
  check('TBD start time shown as TBD', text('next-time-TOR') === 'TBD', text('next-time-TOR'));
  check('no 2027 schedule for CIN -> TBA', text('next-opp-CIN') === 'TBA', text('next-opp-CIN'));
  // leaders: runs MIL 820, HR TOR 230, SB MIL 150, K MIL 1450, RA lowest TB&MIL tie 700
  const lead = id => T(id).classList.contains('leader');
  check('leader stars: runs=MIL, HR=TOR, SB=MIL, K=MIL', lead('r-cell-MIL') && lead('hr-cell-TOR') && lead('sb-cell-MIL') && lead('k-cell-MIL') && !lead('r-cell-TB'));
  check('RA tie -> both TB and MIL starred', lead('ra-cell-TB') && lead('ra-cell-MIL') && !lead('ra-cell-TOR'));
  check('logo sits right after vs/@ (e.g. "vs [logo] Yankees")', /vs <img class="opp-logo"/.test(html('prev-opp-TB')) && /@ <img class="opp-logo"/.test(html('prev-opp-MIL')), html('prev-opp-TB'));
  const order = Array.from(T('cards').children).map(c => c.id).join();
  check('cards sorted by stars; TOR/TB tie on 1 star -> better MLB rank (TOR #9) goes first', order === 'card-MIL,card-TOR,card-TB,card-CIN', order);
  check('MLB rank chip shown', /MLB #14/.test(text('meta-TB')) && /MLB #3/.test(text('meta-MIL')), text('meta-TB'));
  const statColor = id => (T('card-' + id).getAttribute('style').match(/--stat:(#[0-9a-f]{6})/i) || [])[1];
  check('non-leader stat colors are never the leader gold (Brewers fixed)', ['TB', 'MIL', 'TOR', 'CIN'].every(id => { const c = statColor(id), n = i => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16); return Math.hypot(n(0) - 255, n(1) - 210, n(2) - 60) > 90; }) && statColor('MIL') === '#cfdcff', ['TB', 'MIL', 'TOR', 'CIN'].map(statColor).join());
  check('no WS badges when nobody played in the World Series', !T('card-TB').classList.contains('champion') && T('badge-TB').innerHTML === '');
  check('leaderboard: Final 2026 Standings, Mom wins', /Final 2026 Standings/.test(text('leaderboard')) && /Mom wins the family title for 2026/.test(text('leaderboard')), text('leaderboard').slice(0, 120));
  const hist = JSON.parse(w.localStorage.getItem('mlbft:history:v1') || '{}');
  check('2026 snapshot saved to history', hist['2026'] && hist['2026'].teams.MIL && hist['2026'].order[0] === 'MIL', JSON.stringify(hist).slice(0, 120));
  check('history panel visible', !T('history-wrap').hidden && /Past Seasons \(1\)/.test(text('history')));
  check('no banner when everything loaded', T('banner').hidden);
  check('no live strips', !T('live-TB').classList.contains('on'));
  check('skeleton removed', !T('card-TB').classList.contains('skeleton'));
  check('status line says Updated', /^Updated at/.test(text('last-updated')), text('last-updated'));
  return a;
}

/* ================= Scenario B: live game, extra innings, doubleheader, postponed ================= */
async function scenarioB() {
  console.log('\nB) Jul 15 2026 9:30 PM ET — live game, extra innings, doubleheader, postponement');
  let tbLive = true;
  const games = () => [
    // TB: live now (Top 5th, 3-2), last = Jul 14 W, next = Jul 16
    tbLive ? G({ pk: 1, date: '2026-07-15T23:05:00Z', official: '2026-07-15', home: 139, away: 147, hs: 3, as: 2, abstract: 'Live', ls: { currentInning: 5, currentInningOrdinal: '5th', inningState: 'Top', scheduledInnings: 9 } })
           : G({ pk: 1, date: '2026-07-15T23:05:00Z', official: '2026-07-15', home: 139, away: 147, hs: 5, as: 2, abstract: 'Final', ls: { currentInning: 9, scheduledInnings: 9 } }),
    G({ pk: 2, date: '2026-07-14T23:05:00Z', home: 139, away: 147, hs: 5, as: 3, abstract: 'Final', ls: { currentInning: 9, scheduledInnings: 9 } }),
    G({ pk: 3, date: '2026-07-16T23:05:00Z', home: 139, away: 111, abstract: 'Preview' }),
    // MIL: 11-inning home win earlier today, next tomorrow
    G({ pk: 4, date: '2026-07-15T18:10:00Z', home: 158, away: 112, hs: 4, as: 3, abstract: 'Final', ls: { currentInning: 11, scheduledInnings: 9 } }),
    G({ pk: 5, date: '2026-07-16T20:10:00Z', home: 158, away: 112, abstract: 'Preview' }),
    // TOR: doubleheader today, game 1 final, game 2 not yet started (10:00 PM ET)
    G({ pk: 6, date: '2026-07-15T17:07:00Z', home: 141, away: 109, hs: 6, as: 2, abstract: 'Final', ls: { currentInning: 7, scheduledInnings: 7 } }),
    G({ pk: 7, date: '2026-07-16T02:00:00Z', official: '2026-07-15', home: 141, away: 109, abstract: 'Preview' }),
    // CIN: postponed Jul 14 (must be ignored), last = Jul 13 loss @ STL, next later tonight 10:10 PM ET
    G({ pk: 8, date: '2026-07-14T23:10:00Z', home: 113, away: 138, abstract: 'Final', detailed: 'Postponed' }),
    G({ pk: 9, date: '2026-07-13T23:15:00Z', home: 138, away: 113, hs: 7, as: 1, abstract: 'Final', ls: { currentInning: 9, scheduledInnings: 9 } }),
    G({ pk: 14, date: '2026-07-16T02:10:00Z', official: '2026-07-15', home: 113, away: 138, abstract: 'Preview' }),
  ];
  const a = await boot(Date.UTC(2026, 6, 16, 1, 30), { ...FULL, games });
  const { text, T, w, counters } = a;
  check('season tag = 2026 Season (regular season)', text('season-tag') === '2026 Season', text('season-tag'));
  check('TB live strip shows score + inning', T('live-TB').classList.contains('on') && /LIVE/.test(text('live-TB')) && /3–2/.test(text('live-TB')) && /Top 5th/.test(text('live-TB')) && /vs Yankees/.test(text('live-TB')), text('live-TB'));
  check('TB last game excludes the live game (Jul 14 W 5–3)', text('last-score-TB') === 'W 5–3' && /Jul 14/.test(text('last-score-lbl-TB')), text('last-score-TB') + ' | ' + text('last-score-lbl-TB'));
  check('TB next game = Tomorrow 7:05 PM', text('next-date-TB') === 'Tomorrow' && text('next-time-TB') === '7:05 PM', text('next-date-TB') + ' | ' + text('next-time-TB'));
  check('MIL extra innings flagged (F/11)', /W 4–3/.test(text('last-score-MIL')) && /F\/11/.test(text('last-score-MIL')), text('last-score-MIL'));
  check('MIL last-score label = Today', /Today/.test(text('last-score-lbl-MIL')), text('last-score-lbl-MIL'));
  check('TOR doubleheader: last = game 1 W 6–2, next = game 2 Today 10:00 PM', text('last-score-TOR') === 'W 6–2' && text('next-date-TOR') === 'Today' && text('next-time-TOR') === '10:00 PM', `${text('last-score-TOR')} | ${text('next-date-TOR')} | ${text('next-time-TOR')}`);
  check('TOR 7-inning DH game not flagged as extra innings', !/F\//.test(text('last-score-TOR')));
  check('CIN ignores postponed game; last = Jul 13 L 1–7 @ Cardinals', text('last-score-CIN') === 'L 1–7' && /@ Cardinals/.test(text('prev-opp-CIN')), text('last-score-CIN') + ' | ' + text('prev-opp-CIN'));
  check('CIN next = Today 10:10 PM (ET date, not UTC date)', text('next-date-CIN') === 'Today' && text('next-time-CIN') === '10:10 PM', text('next-date-CIN') + ' | ' + text('next-time-CIN'));
  check('regular-season next label is "Next Game"', text('next-date-lbl-TB') === 'Next Game');
  check('status mentions live auto-updating', /live, auto-updating/.test(text('last-updated')), text('last-updated'));
  check('in-season: schedule uses window only (1 call per team, no fallbacks)', counters.schedule === 4, 'schedule calls = ' + counters.schedule);
  check('in-season: no history saved', !w.localStorage.getItem('mlbft:history:v1'));

  // light refresh: game ends -> live strip clears, last updates, and a follow-up full refresh fires
  const before = { standings: counters.standings, sched: counters.schedule };
  tbLive = false;
  await w.__tracker.refresh('light');
  check('light refresh only hit the schedule (4 calls) at first', counters.schedule === before.sched + 4 && counters.standings === before.standings, JSON.stringify(counters));
  check('live strip cleared, last score now W 5–2', !T('live-TB').classList.contains('on') && text('last-score-TB') === 'W 5–2', text('last-score-TB'));
  await sleep(900); await a.idle();
  check('game ending triggered an automatic full refresh', counters.standings === before.standings + 1, 'standings calls = ' + counters.standings);
  return a;
}

/* ================= Scenario C: partial failure + cached restore + total failure ================= */
async function scenarioC(seed) {
  console.log('\nC1) one section fails -> others still render, banner explains');
  const games = () => [G({ pk: 1, date: '2026-07-14T23:05:00Z', home: 139, away: 147, hs: 5, as: 3, abstract: 'Final' }), G({ pk: 3, date: '2026-07-16T23:05:00Z', home: 139, away: 111, abstract: 'Preview' })];
  const c1 = await boot(Date.UTC(2026, 6, 15, 14, 0), { ...FULL, games, fail: k => (k === 'teams-stats:hitting' ? 500 : null) });
  check('standings + pitching still render', c1.text('rec-TB') === '90-72' && c1.text('k-TB') === '1,400', c1.text('rec-TB') + ' ' + c1.text('k-TB'));
  check('runs fall back to standings runsScored when hitting fails', c1.text('r-TB') === '780', c1.text('r-TB'));
  check('HR/SB show dashes (no data) instead of 0', c1.text('hr-TB') === '—' && c1.text('sb-TB') === '—', c1.text('hr-TB') + ' ' + c1.text('sb-TB'));
  check('warn banner names hitting stats', !c1.T('banner').hidden && /hitting stats/.test(c1.text('banner')) && c1.T('banner').className.includes('warn'), c1.text('banner'));
  check('a 500 was retried once', c1.counters['teams-stats:hitting'] === 2, String(c1.counters['teams-stats:hitting']));

  console.log('\nC2) cached restore: everything now fails; saved data stays on screen');
  const c2 = await boot(Date.UTC(2026, 6, 16, 1, 40), { ...FULL, games: () => [], fail: () => 'network' }, seed);
  check('cached record still shown', c2.text('rec-MIL') === '95-67', c2.text('rec-MIL'));
  check('cached schedule still shown', c2.text('last-score-TOR') === 'W 6–2', c2.text('last-score-TOR'));
  check('banner: couldn\'t refresh, showing saved data', !c2.T('banner').hidden && /Couldn't refresh/.test(c2.text('banner')) && /saved data/.test(c2.text('banner')), c2.text('banner'));
  check('status line says Saved', /^Saved/.test(c2.text('last-updated')), c2.text('last-updated'));

  console.log('\nC3) no cache and everything fails -> clear error state, no stuck skeleton');
  const c3 = await boot(Date.UTC(2026, 6, 16, 1, 40), { ...FULL, games: () => [], fail: () => 'network' });
  check('error banner', c3.T('banner').className.includes('error') && /Couldn't reach/.test(c3.text('banner')), c3.text('banner'));
  check('skeleton removed, dashes shown', !c3.T('card-TB').classList.contains('skeleton') && c3.text('rec-TB') === '—' && c3.text('r-TB') === '—');
  check('leaderboard hidden with no data', c3.T('leaderboard-wrap').hidden);
  check('retry happened (2 attempts per endpoint)', c3.counters.standings === 2, String(c3.counters.standings));
}

/* ================= Scenario D: pre-season (Feb) ================= */
async function scenarioD() {
  console.log('\nD) Feb 10 2027 — before Opening Day, season-info API unavailable (heuristic fallback)');
  const games = () => [
    G({ pk: 1, date: '2026-09-27T18:10:00Z', home: 139, away: 147, hs: 4, as: 2, abstract: 'Final' }),
    G({ pk: 11, date: '2027-03-25T20:10:00Z', home: 139, away: 111, abstract: 'Preview', season: '2027' }),
  ];
  const d = await boot(Date.UTC(2027, 1, 10, 15, 0), { ...FULL, games, noSeasonInfo: true });
  check('tag shows prior season final + approximate start', /^Final 2026 · 2027 starts Mar 27$/.test(d.text('season-tag')), d.text('season-tag'));
  check('shows 2026 final record', d.text('rec-TB') === '90-72');
  check('last game found via season look-back', d.text('last-score-TB') === 'W 4–2', d.text('last-score-TB'));
  check('next = opener', d.text('next-date-lbl-TB') === 'Opening Day' && /vs Red Sox/.test(d.text('next-opp-TB')), d.text('next-date-lbl-TB'));
  check('final 2026 snapshot saved (phase=before)', !!JSON.parse(d.w.localStorage.getItem('mlbft:history:v1') || '{}')['2026']);
  check('debug panel notes approximate dates', (d.w.document.getElementById('debug-wrap').hidden = false, d.w.__tracker.render(), /approximate dates/.test(d.text('dbg-state'))), d.text('dbg-state'));
}

/* ================= Scenario E: season just started, 0-0 ================= */
async function scenarioE() {
  console.log('\nE) Opening day morning — everyone 0-0');
  const zero = Object.fromEntries(Object.keys(FULL.standings).map(id => [id, { div: 201, w: 0, l: 0, pct: '.000', rank: 1, gb: '-', streak: '', l10: [0, 0], rd: 0, rs: 0, ra: 0 }]));
  const zh = Object.fromEntries(Object.keys(FULL.hit).map(id => [id, { rs: 0, hr: 0, sb: 0 }]));
  const zp = Object.fromEntries(Object.keys(FULL.pit).map(id => [id, { k: 0, ra: 0 }]));
  const games = () => [G({ pk: 20, date: '2026-03-26T20:10:00Z', home: 139, away: 111, abstract: 'Preview' })];
  const e = await boot(Date.UTC(2026, 2, 26, 12, 0), { standings: zero, hit: zh, pit: zp, games });
  check('tag = 2026 Season', e.text('season-tag') === '2026 Season', e.text('season-tag'));
  check('stats show dashes, record 0-0, "no games yet"', e.text('r-TB') === '—' && e.text('rec-TB') === '0-0' && /no games yet/.test(e.text('pct-TB')), `${e.text('r-TB')} ${e.text('rec-TB')} ${e.text('pct-TB')}`);
  check('no stars when nothing has happened', !e.T('r-cell-TB').classList.contains('leader'));
  check('leaderboard explains the wait', /Waiting for the season/.test(e.text('leaderboard')), e.text('leaderboard'));
  check('TB next = Today 4:10 PM', e.text('next-date-TB') === 'Today' && e.text('next-time-TB') === '4:10 PM', e.text('next-date-TB') + ' ' + e.text('next-time-TB'));
  check('no history saved during season start', !e.w.localStorage.getItem('mlbft:history:v1'));
}

const gamesA = () => [
  G({ pk: 1, date: '2026-09-27T18:10:00Z', home: 139, away: 147, hs: 4, as: 2, abstract: 'Final' }),
  G({ pk: 3, date: '2026-09-27T18:05:00Z', home: 111, away: 141, hs: 1, as: 6, abstract: 'Final' }),
  G({ pk: 4, date: '2026-09-27T19:10:00Z', home: 113, away: 138, hs: 2, as: 3, abstract: 'Final' }),
  G({ pk: 5, date: '2026-09-27T19:10:00Z', home: 112, away: 158, hs: 2, as: 3, abstract: 'Final' }),
];

async function scenarioF() {
  console.log('\nF) Nov 12 2026 — World Series over: MIL beat TB 4-1');
  const ws = [
    G({ pk: 101, date: '2026-10-24T23:08:00Z', home: 139, away: 158, hs: 2, as: 5, abstract: 'Final', type: 'W' }),
    G({ pk: 102, date: '2026-10-25T23:08:00Z', home: 139, away: 158, hs: 4, as: 3, abstract: 'Final', type: 'W' }),
    G({ pk: 103, date: '2026-10-27T23:08:00Z', home: 158, away: 139, hs: 6, as: 1, abstract: 'Final', type: 'W' }),
    G({ pk: 104, date: '2026-10-28T23:08:00Z', home: 158, away: 139, hs: 3, as: 2, abstract: 'Final', type: 'W' }),
    G({ pk: 105, date: '2026-10-29T23:08:00Z', home: 139, away: 158, hs: 1, as: 4, abstract: 'Final', type: 'W' }),
  ];
  const f = await boot(Date.UTC(2026, 10, 12, 13, 13), { ...FULL, games: () => [...gamesA(), ...ws] });
  const { text, T } = f;
  check('MIL gets the champion banner', T('card-MIL').classList.contains('champion') && /2026 World Series Champions/.test(text('badge-MIL')) && T('badge-MIL').querySelector('.champ-banner'), text('badge-MIL'));
  check('TB gets a silver World Series runner-up banner', !T('card-TB').classList.contains('champion') && T('badge-TB').querySelector('.ws-banner.second') && !T('badge-TB').querySelector('.pennant') && /2026 World Series · Runner-Up/.test(text('badge-TB')), text('badge-TB'));
  check('TOR and CIN get no badge', T('badge-TOR').innerHTML === '' && T('badge-CIN').innerHTML === '');
  check('TB last game is the Game 5 loss, vs Brewers, L 1–4', /vs Brewers/.test(text('prev-opp-TB')) && text('last-score-TB') === 'L 1–4', text('prev-opp-TB') + ' ' + text('last-score-TB'));
  check('leaderboard: trophy on MIL, WS tag on TB', /🏆/.test(T('leaderboard').innerHTML) && /lb-tag">WS/.test(T('leaderboard').innerHTML));
  check('family title line uses a crown, not the trophy', /👑 Mom wins the family title for 2026/.test(text('leaderboard')), text('leaderboard').slice(0, 120));
  const hist = JSON.parse(f.w.localStorage.getItem('mlbft:history:v1'));
  check('history records WS champion / finalist', hist['2026'].teams.MIL.ws === 'champion' && hist['2026'].teams.TB.ws === 'finalist' && hist['2026'].teams.TOR.ws === null, JSON.stringify(Object.values(hist['2026'].teams).map(t => t.ws)));
  check('history table shows trophy for the champ', /🏆/.test(f.html('history')) && /👑/.test(f.html('history')));
}

async function scenarioG() {
  console.log('\nG) Oct 27 2026 8 PM ET — World Series in progress (TB 1-1... Game 3 live)');
  const ws = [
    G({ pk: 101, date: '2026-10-24T23:08:00Z', home: 139, away: 158, hs: 2, as: 5, abstract: 'Final', type: 'W' }),
    G({ pk: 102, date: '2026-10-25T23:08:00Z', home: 139, away: 158, hs: 4, as: 3, abstract: 'Final', type: 'W' }),
    G({ pk: 103, date: '2026-10-28T00:08:00Z', official: '2026-10-27', home: 158, away: 139, hs: 1, as: 1, abstract: 'Live', type: 'W', ls: { currentInning: 6, currentInningOrdinal: '6th', inningState: 'Bottom', scheduledInnings: 9 } }),
  ];
  const g = await boot(Date.UTC(2026, 9, 28, 0, 20), { ...FULL, games: () => [...gamesA(), ...ws] });
  const { text, T } = g;
  check('tag = 2026 Postseason', text('season-tag') === '2026 Postseason', text('season-tag'));
  check('both finalists get a red in-progress banner with series score', T('badge-TB').querySelector('.ws-banner.series') && /World Series · 1–1/.test(text('badge-TB')) && /World Series · 1–1/.test(text('badge-MIL')), text('badge-TB') + ' | ' + text('badge-MIL'));
  check('nobody is champion yet', !T('card-TB').classList.contains('champion') && !T('card-MIL').classList.contains('champion'));
  check('live strip shows the WS game', T('live-MIL').classList.contains('on') && /Bottom 6th/.test(text('live-MIL')), text('live-MIL'));
  check('live game does not count toward the series record', !/2–1|1–2/.test(text('badge-MIL')));
}


/* ================= New features ================= */
const ser = (pk0, type, team, opp, wins, day) => wins.map((w, i) => G({ pk: pk0 + i, date: `2026-10-${String(day + i).padStart(2, '0')}T23:00:00Z`, home: team, away: opp, hs: w ? 5 : 2, as: w ? 2 : 5, abstract: 'Final', type }));

async function scenarioH() {
  console.log('\nH) Nov 12 2026 — pennants, division / wild card / round chips, expandable details');
  const standings = JSON.parse(JSON.stringify(FULL.standings));
  standings[158].champ = true; standings[158].clinch = 'z'; standings[139].clinch = 'w';
  standings[147] = { div: 201, w: 99, l: 63, pct: '.611', rank: 1, gb: '-', streak: 'W1', l10: [6, 4], rd: 100, rs: 800, ra: 700, sr: 2 };
  standings[111] = { div: 201, w: 70, l: 92, pct: '.432', rank: 4, gb: '21.0', streak: 'L1', l10: [3, 7], rd: -50, rs: 650, ra: 700, sr: 25 };
  const ws = [
    G({ pk: 101, date: '2026-10-24T23:08:00Z', home: 139, away: 158, hs: 2, as: 5, abstract: 'Final', type: 'W' }),
    G({ pk: 102, date: '2026-10-25T23:08:00Z', home: 139, away: 158, hs: 4, as: 3, abstract: 'Final', type: 'W' }),
    G({ pk: 103, date: '2026-10-27T23:08:00Z', home: 158, away: 139, hs: 6, as: 1, abstract: 'Final', type: 'W' }),
    G({ pk: 104, date: '2026-10-28T23:08:00Z', home: 158, away: 139, hs: 3, as: 2, abstract: 'Final', type: 'W' }),
    G({ pk: 105, date: '2026-10-29T23:08:00Z', home: 139, away: 158, hs: 1, as: 4, abstract: 'Final', type: 'W' }),
  ];
  const games = () => [...gamesA(), ...ws,
    ...ser(200, 'F', 139, 147, [1, 1], 1), ...ser(210, 'D', 139, 147, [1, 0, 1, 1], 3), ...ser(220, 'L', 139, 111, [1, 1, 0, 1, 0, 1], 10),     // TB: wild card -> pennant
    ...ser(300, 'D', 158, 112, [1, 1, 1], 3), ...ser(310, 'L', 158, 119, [1, 1, 0, 1, 1], 12),                                                       // MIL: division champ -> pennant
    ...ser(400, 'F', 113, 138, [0, 0], 1),                                                                                                          // CIN: out in the wild card round
    G({ pk: 11, date: '2027-03-26T20:10:00Z', home: 139, away: 111, abstract: 'Preview', season: '2027', hpp: 'Test Pitcher A', app: 'Test Pitcher B' }),
  ];
  const h = await boot(Date.UTC(2026, 10, 12, 13, 13), { ...FULL, standings, games });
  const { text, T } = h;
  const chips = id => Array.from(T('meta-' + id).querySelectorAll('.chip')).map(c => c.textContent.trim());
  check('MIL: NL Champions pennant chip (with SVG) + Division Champs', T('meta-MIL').querySelector('.chip.pennant svg') && chips('MIL').includes('NL Champions') && chips('MIL').includes('Division Champs'), chips('MIL').join(' | '));
  check('TB: AL Champions pennant + Wild Card', chips('TB').includes('AL Champions') && chips('TB').includes('Wild Card'), chips('TB').join(' | '));
  check('CIN: out in the Wild Card round, no pennant', chips('CIN').includes('Out in Wild Card') && !T('meta-CIN').querySelector('.pennant'), chips('CIN').join(' | '));
  check('TOR: Missed Playoffs', chips('TOR').includes('Missed Playoffs'), chips('TOR').join(' | '));
  check('pennant chip is not gold-coloured text-only (has label)', /AL Champions/.test(text('meta-TB')));

  // expandable details
  check('details start collapsed', T('detail-TB').hidden && T('exp-TB').getAttribute('aria-expanded') === 'false');
  T('exp-TB').click();
  check('tap expands: aria-expanded true, panel visible', !T('detail-TB').hidden && T('exp-TB').getAttribute('aria-expanded') === 'true' && /Hide details/.test(text('exp-TB')));
  check('last 10 list has 10 games with W/L letters', T('detail-TB').querySelectorAll('ul.l10 li').length === 10 && /^[WL]$/.test(T('detail-TB').querySelector('ul.l10 li b').textContent));
  check('probable pitchers shown for next game', /TB: Test Pitcher A · BOS: Test Pitcher B/.test(text('detail-TB')), text('detail-TB').slice(0, 200));
  check('division standings table (AL East) with our team highlighted', /AL East/.test(text('detail-TB')) && T('detail-TB').querySelectorAll('table.dt tr.me').length === 1 && /1\. NYY/.test(text('detail-TB')), text('detail-TB').slice(0, 300));
  check('expanded state survives a re-render', (h.w.__tracker.render(), !T('detail-TB').hidden));
  T('exp-TB').click();
  check('tap again collapses', T('detail-TB').hidden && T('exp-TB').getAttribute('aria-expanded') === 'false');

  // accessibility bits
  check('leader categories have screen-reader text', /leads the family/.test(text('r-sr-MIL')) && text('r-sr-TB') === '');
  check('landmarks + skip link present', !!h.w.document.querySelector('main') && !!h.w.document.querySelector('header') && !!h.w.document.querySelector('a.skip-link[href="#cards"]') && h.w.document.querySelectorAll('article.team-card').length === 4);
  check('banner is a status region; announcer is aria-live', T('banner').getAttribute('role') === 'status' && T('announcer').getAttribute('aria-live') === 'polite');
}

async function scenarioI() {
  console.log('\nI) Jul 15 2026 8 PM ET — family showdown (TB vs TOR live), line score, announcements');
  let tbScore = 3;
  const base = () => [
    G({ pk: 50, date: '2026-07-15T23:05:00Z', home: 139, away: 141, hs: tbScore, as: 2, abstract: 'Live', ls: { currentInning: 5, currentInningOrdinal: '5th', inningState: 'Top', scheduledInnings: 9, teams: { home: { runs: tbScore, hits: 6, errors: 0 }, away: { runs: 2, hits: 4, errors: 1 } } } }),
    G({ pk: 51, date: '2026-07-14T23:05:00Z', home: 139, away: 147, hs: 5, as: 3, abstract: 'Final' }),
    G({ pk: 52, date: '2026-07-14T23:05:00Z', home: 111, away: 141, hs: 5, as: 3, abstract: 'Final' }),
  ];
  const i = await boot(Date.UTC(2026, 6, 15, 23, 40), { ...FULL, games: base });
  const { text, T } = i;
  check('showdown banner is visible and says LIVE with both owners', !T('showdown-wrap').hidden && /Family showdown/.test(text('showdown')) && /LIVE/.test(text('showdown')) && /Dad's Rays vs Brady's Blue Jays/.test(text('showdown')), text('showdown'));
  check('both cards carry a showdown chip', /vs Brady/.test(text('meta-TB')) && /vs Dad/.test(text('meta-TOR')), text('meta-TB'));
  T('exp-TB').click();
  check('live line score (R/H/E) in details', /Live line score/.test(text('detail-TB')) && /TB\s*3\s*6\s*0/.test(text('detail-TB')) && /TOR\s*2\s*4\s*1/.test(text('detail-TB')), text('detail-TB').slice(0, 200));
  check('no announcement on the first load', text('announcer') === '');
  tbScore = 4;
  await i.w.__tracker.refresh('light');
  check('score change is announced politely', /Tampa Bay Rays.*4 to 2/.test(text('announcer')), text('announcer'));

  console.log('\nJ) Jul 15 2026 2 PM ET — upcoming family game + time-zone toggle');
  const j = await boot(Date.UTC(2026, 6, 15, 18, 0), { ...FULL, games: () => [
    G({ pk: 60, date: '2026-07-16T23:10:00Z', home: 158, away: 113, abstract: 'Preview' }),
    G({ pk: 61, date: '2026-07-16T23:05:00Z', home: 139, away: 147, abstract: 'Preview' }),
    G({ pk: 62, date: '2026-07-14T23:05:00Z', home: 139, away: 147, hs: 5, as: 3, abstract: 'Final' }),
  ] });
  check('upcoming showdown shows date + ET time', !j.T('showdown-wrap').hidden && /Tomorrow/.test(j.text('showdown')) && /7:10 PM ET/.test(j.text('showdown')) && /Mom's Brewers vs Deacon's Reds/.test(j.text('showdown')), j.text('showdown'));
  check('default time zone is ET', j.text('next-time-TB') === '7:05 PM' && j.text('next-time-lbl-TB') === 'Game Time (ET)' && j.text('tz-btn') === 'Times: ET');
  j.T('tz-btn').click();
  check('toggle -> viewer local time (PDT)', j.text('next-time-TB') === '4:05 PM' && j.text('next-time-lbl-TB') === 'Game Time (PDT)' && j.text('tz-btn') === 'Times: PDT' && /4:10 PM PDT/.test(j.text('showdown')), j.text('next-time-TB') + ' | ' + j.text('next-time-lbl-TB') + ' | ' + j.text('showdown'));
  check('choice is remembered', j.w.localStorage.getItem('mlbft:tz:v1') === '"local"');
  j.T('tz-btn').click();
  check('toggle back -> ET', j.text('next-time-TB') === '7:05 PM' && j.text('tz-btn') === 'Times: ET');
}

async function scenarioK() {
  console.log('\nK) Shared data branch: snapshot used when fresh, direct MLB when stale, shared trend + history');
  const fs2 = require('fs'), os = require('os');
  const { run } = require('../scripts/update-data.js');
  const now = Date.UTC(2026, 6, 15, 18, 0);
  const games = () => [
    G({ pk: 62, date: '2026-07-14T23:05:00Z', home: 139, away: 147, hs: 5, as: 3, abstract: 'Final' }),
    G({ pk: 61, date: '2026-07-16T23:05:00Z', home: 139, away: 147, abstract: 'Preview' }),
  ];
  const build = async at => {
    const dir = fs2.mkdtempSync(os.tmpdir() + '/mlbft-');
    await run({ outDir: dir, fetch: makeFetch({ ...FULL, games }, {}), now: () => at });
    return Object.fromEntries(['snapshot.json', 'trend.json', 'history.json'].map(f => [f, JSON.parse(fs2.readFileSync(dir + '/' + f, 'utf8'))]));
  };
  const fresh = await build(now - 5 * 60e3);
  fresh['trend.json'].points = ['2026-07-10', '2026-07-12', '2026-07-14'].map((d, i) => ({ d, t: { TB: { w: 40 + i, l: 40 }, MIL: { w: 50 + i * 2, l: 40 }, TOR: { w: 38, l: 42 + i }, CIN: { w: 30, l: 50 + i } } }));
  fresh['history.json'] = { 2025: { season: 2025, savedAt: 1, order: ['MIL', 'TB'], teams: { MIL: { owner: "Mom's Team", name: 'Milwaukee Brewers', wins: 90, losses: 72, runs: 1, homeRuns: 2, stolenBases: 3, strikeouts: 4, runsAllowed: 5, ws: null }, TB: { owner: "Dad's Team", name: 'Tampa Bay Rays', wins: 80, losses: 82, runs: 1, homeRuns: 2, stolenBases: 3, strikeouts: 4, runsAllowed: 5, ws: null } } } };
  const k = await boot(now, { ...FULL, games, raw: fresh });
  check('fresh snapshot used: no direct standings/hitting/pitching/schedule calls', !k.counters.standings && !k.counters.schedule && !k.counters['teams-stats:hitting'], JSON.stringify(k.counters));
  check('page renders from snapshot', k.text('rec-TB') === '90-72' && /vs Yankees/.test(k.text('next-opp-TB')) && k.w.__tracker.STATE.source === 'snapshot', k.w.__tracker.STATE.source);
  check('shared trend chart drawn (4 lines + labels)', !k.T('trend-wrap').hidden && k.T('trend').querySelectorAll('svg polyline').length === 4 && /MIL/.test(k.html('trend')), k.text('trend').slice(0, 100));
  check('shared history shown, labelled as shared', !k.T('history-wrap').hidden && /2025 Season/.test(k.text('history')) && /Shared across devices/.test(k.text('history')));
  check('in-season trend point also saved locally', JSON.parse(k.w.localStorage.getItem('mlbft:trend:v1')).points.length >= 1);

  const stale = await build(now - 2 * 3600e3);
  const k2 = await boot(now, { ...FULL, games, raw: stale });
  check('stale snapshot ignored -> falls back to MLB directly', k2.counters.standings === 1 && k2.w.__tracker.STATE.source === 'mlb' && k2.text('rec-TB') === '90-72', JSON.stringify(k2.counters));
  const k3 = await boot(now, { ...FULL, games });
  check('no data branch yet (404) -> works exactly as before', k3.text('rec-TB') === '90-72' && k3.T('banner').hidden, k3.text('banner'));
  check('single trend point shows the "fills in" note, not a chart', !k3.T('trend-wrap').hidden && !k3.T('trend').querySelector('svg') && /fills in/.test(k3.text('trend')), k3.text('trend'));
}

(async () => {
  try {
    await scenarioF();
    await scenarioG();
    await scenarioA();
    const b = await scenarioB();
    await scenarioC(ls(b.w));
    await scenarioD();
    await scenarioE();
    await scenarioH();
    await scenarioI();
    await scenarioK();
  } catch (e) { console.log('HARNESS ERROR', e); fail++; }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
