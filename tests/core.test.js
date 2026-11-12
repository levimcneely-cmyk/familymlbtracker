'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const K = require('../js/core.js');
const CFG = require('../js/config.js');
const { G, FULL, makeFetch, makeChecker } = require('./mock');
const res = makeChecker();
const check = res.check;

(async () => {
  console.log('\ncore: season phases (Eastern-time date strings)');
  const info = { regularSeasonStartDate: '2026-03-26', regularSeasonEndDate: '2026-09-27', postSeasonEndDate: '2026-11-01' };
  const ph = d => K.computeContext(d, info);
  check('before / regular / postseason / after', ph('2026-03-25').phase === 'before' && ph('2026-03-26').phase === 'regular' && ph('2026-09-27').phase === 'regular' && ph('2026-09-28').phase === 'postseason' && ph('2026-11-01').phase === 'postseason' && ph('2026-11-02').phase === 'after');
  check('stats season is last year only before opening day', ph('2026-03-25').statsSeason === 2025 && ph('2026-11-12').statsSeason === 2026);
  check('no season info -> approximate dates flagged', K.computeContext('2026-05-01', null).approx === true);
  check('etDay uses Eastern, not UTC (00:30 UTC is still the previous ET day)', K.etDay(new Date(Date.UTC(2026, 6, 16, 0, 30))) === '2026-07-15');
  check('addDays crosses month/year', K.addDays('2026-12-31', 1) === '2027-01-01' && K.addDays('2026-03-01', -1) === '2026-02-28');

  console.log('\ncore: postseason detection');
  const g = (type, my, their, abstract = 'Final') => ({ type, my, their, abstract, detailed: abstract, season: '2026' });
  const rep = (type, w, l) => Array.from({ length: w }, () => g(type, 5, 1)).concat(Array.from({ length: l }, () => g(type, 1, 5)));
  const champ = K.postseasonInfo([...rep('F', 2, 0), ...rep('D', 3, 1), ...rep('L', 4, 2), ...rep('W', 4, 1)]);
  check('champion: pennant + World Series win', champ.leagueChamp && champ.ws.champion && champ.round === 'W');
  const runnerUp = K.postseasonInfo([...rep('D', 3, 0), ...rep('L', 4, 0), ...rep('W', 1, 4)]);
  check('runner-up: pennant, WS over, not champion', runnerUp.leagueChamp && runnerUp.ws.over && !runnerUp.ws.champion);
  const out = K.postseasonInfo([...rep('F', 2, 0), ...rep('D', 1, 3)]);
  check('eliminated in the division series', out.eliminated && out.round === 'D' && !out.leagueChamp);
  const inProg = K.postseasonInfo([...rep('D', 2, 1), g('D', 0, 0, 'Live')]);
  check('series in progress is not "over"; live game not counted', !inProg.rounds.D.over && inProg.rounds.D.wins === 2 && inProg.rounds.D.losses === 1);
  check('wild card is best-of-3 (2 wins clinch)', K.postseasonInfo(rep('F', 2, 0)).rounds.F.won === true && K.postseasonInfo(rep('F', 1, 1)).rounds.F.over === false);
  check('no postseason games -> null', K.postseasonInfo([g('R', 3, 1)]) === null);

  console.log('\ncore: picking games, trend merge, ranking');
  const mk = (o) => K.normGame(G(o), 139);
  const pk = K.pickGames([mk({ pk: 1, date: '2026-07-10T23:00:00Z', home: 139, away: 147, hs: 1, as: 0, abstract: 'Final' }), mk({ pk: 2, date: '2026-07-12T23:00:00Z', home: 139, away: 147, hs: 2, as: 0, abstract: 'Final' }), mk({ pk: 3, date: '2026-07-20T23:00:00Z', home: 139, away: 147, abstract: 'Preview' }), mk({ pk: 4, date: '2026-07-14T23:00:00Z', home: 139, away: 147, abstract: 'Final', detailed: 'Postponed' }), mk({ pk: 5, date: '2026-07-14T23:00:00Z', home: 139, away: 147, abstract: 'Preview', type: 'S' })]);
  check('pickGames: latest final, next preview, ignores postponed + spring training', pk.last.pk === 2 && pk.next.pk === 3 && !pk.live);
  const m = K.mergeTrend(2026, { season: 2026, points: [{ d: '2026-07-01', t: { a: 1 } }, { d: '2026-07-02', t: { a: 2 } }] }, { season: 2026, points: [{ d: '2026-07-02', t: { a: 99 } }, { d: '2026-07-03', t: { a: 3 } }] }, { season: 2025, points: [{ d: '2025-09-01', t: {} }] }, null);
  check('mergeTrend: union by date, later wins, other seasons dropped', m.points.length === 3 && m.points[1].t.a === 99 && m.points.every(p => p.d.startsWith('2026')));
  const C = K.create({ teams: CFG.TEAMS, fetch: makeFetch({ ...FULL, games: () => [] }, {}), now: () => Date.UTC(2026, 6, 15, 18) });
  const mod = C.buildModel({ standings: { data: toData(FULL.standings) }, hitting: { data: { TB: { runs: 1, homeRuns: 1, stolenBases: 1 } } } });
  function toData(rows) { const ids = { 139: 'TB', 158: 'MIL', 141: 'TOR', 113: 'CIN' }; return Object.fromEntries(Object.entries(rows).map(([id, r]) => [ids[id], { wins: r.w, losses: r.l, pct: r.pct, sportRank: r.sr }])); }
  check('buildModel: missing sections give nulls, never zeros', mod.MIL.homeRuns === null && mod.TB.homeRuns === 1);
  const lead = { runs: ['TB'], homeRuns: ['TB'], stolenBases: [], strikeouts: ['MIL'], runsAllowed: [] };
  const ranked = C.rankTeams(mod, lead).map(r => r.t.abbr);
  check('rankTeams: most stars first, then better MLB rank (MIL #3 before TOR #9 before CIN #28)', ranked.join() === 'TB,MIL,TOR,CIN', ranked.join());

  console.log('\nupdate-data: scheduled job');
  const { run, shouldSkip } = require('../scripts/update-data.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlbft-ud-'));
  const NOV = Date.UTC(2026, 10, 12, 13, 0);
  const games = () => [G({ pk: 1, date: '2026-09-27T18:10:00Z', home: 139, away: 147, hs: 4, as: 2, abstract: 'Final' }), G({ pk: 2, date: '2026-09-27T18:10:00Z', home: 158, away: 112, hs: 4, as: 2, abstract: 'Final' })];
  let r = await run({ outDir: dir, fetch: makeFetch({ ...FULL, games }, {}), now: () => NOV });
  const snap = JSON.parse(fs.readFileSync(dir + '/snapshot.json', 'utf8'));
  check('writes snapshot with all four sections + team names', ['standings', 'hitting', 'pitching', 'schedule'].every(k => snap.sections[k] && snap.sections[k].data) && snap.v === 3 && Object.keys(snap.teamMeta).length > 0);
  const hist = JSON.parse(fs.readFileSync(dir + '/history.json', 'utf8'));
  check('offseason run saves the finished season to history.json', hist['2026'] && hist['2026'].order[0] === 'MIL');
  check('trend.json stays empty outside the season', JSON.parse(fs.readFileSync(dir + '/trend.json', 'utf8')).points.length === 0);
  const counters = {};
  r = await run({ outDir: dir, fetch: makeFetch({ ...FULL, games }, counters), now: () => NOV + 3600e3 });
  check('quiet off-season: second run within hours does nothing', r.skipped === true && !counters.standings, JSON.stringify(r));

  console.log('\nupdate-data: in season, partial failure keeps last good section');
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mlbft-ud-'));
  const JUL = Date.UTC(2026, 6, 15, 18, 0);
  const gm = () => [G({ pk: 1, date: '2026-07-14T23:05:00Z', home: 139, away: 147, hs: 5, as: 3, abstract: 'Final' })];
  await run({ outDir: dir2, fetch: makeFetch({ ...FULL, games: gm }, {}), now: () => JUL });
  await run({ outDir: dir2, fetch: makeFetch({ ...FULL, games: gm }, {}), now: () => JUL + 86400e3 });
  const t2 = JSON.parse(fs.readFileSync(dir2 + '/trend.json', 'utf8'));
  check('one trend point per day, appended in order', t2.points.length === 2 && t2.points[0].d === '2026-07-15' && t2.points[1].d === '2026-07-16' && t2.points[0].t.TB.w === 90, JSON.stringify(t2.points.map(p => p.d)));
  await run({ outDir: dir2, fetch: makeFetch({ ...FULL, games: gm }, {}), now: () => JUL + 86400e3 + 600e3 });
  check('re-running the same day replaces, not duplicates', JSON.parse(fs.readFileSync(dir2 + '/trend.json', 'utf8')).points.length === 2);
  const before = JSON.parse(fs.readFileSync(dir2 + '/snapshot.json', 'utf8'));
  r = await run({ outDir: dir2, fetch: makeFetch({ ...FULL, games: gm, fail: k => (k === 'standings' ? 500 : null) }, {}), now: () => JUL + 86400e3 + 1200e3 });
  const after = JSON.parse(fs.readFileSync(dir2 + '/snapshot.json', 'utf8'));
  check('standings outage: error recorded, previous standings kept, others refreshed', r.errors.standings && after.sections.standings.at === before.sections.standings.at && after.sections.hitting.at > before.sections.hitting.at, JSON.stringify(r.errors));
  const t3 = JSON.parse(fs.readFileSync(dir2 + '/trend.json', 'utf8'));
  check('no trend point is written from incomplete data', t3.points.length === 2);
  let threw = false;
  try { await run({ outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mlbft-ud-')), fetch: makeFetch({ ...FULL, games: gm, fail: () => 'network' }, {}), now: () => JUL }); } catch (e) { threw = true; }
  check('total MLB outage with no previous data fails the job loudly', threw);
  check('shouldSkip never skips during the season', shouldSkip(before, K.computeContext('2026-07-16', { regularSeasonStartDate: '2026-03-26', regularSeasonEndDate: '2026-09-27', postSeasonEndDate: '2026-11-01' }), JUL) === false);

  console.log(`\n${res.pass} passed, ${res.fail} failed`);
  process.exit(res.fail ? 1 : 0);
})().catch(e => { console.log('HARNESS ERROR', e); process.exit(1); });
