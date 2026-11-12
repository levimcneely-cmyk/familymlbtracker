#!/usr/bin/env node
/* Scheduled data job (run by .github/workflows/update-data.yml).
   Fetches MLB data once, then writes three files to the output folder:
     snapshot.json  everything the page needs (standings, stats, schedules)
     trend.json     one wins-minus-losses point per day for the season chart
     history.json   finished seasons for the "Past Seasons" panel
   Usage: node scripts/update-data.js [outDir]                                   */
'use strict';
const fs = require('fs');
const path = require('path');
const CFG = require('../js/config.js');
const K = require('../js/core.js');

const SKIP_WHEN_QUIET_MS = 6 * 3600e3;          // off-season: don't rewrite more often than this

function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }
function writeJSON(file, v) { fs.writeFileSync(file, JSON.stringify(v)); }

/* True when there's nothing worth refreshing (no games are being played and we already have today's data). */
function shouldSkip(prev, ctx, nowMs) {
  if (!prev || prev.v !== 3 || !prev.ctx) return false;
  if (ctx.phase !== 'after' && ctx.phase !== 'before') return false;
  const live = Object.values((prev.sections.schedule && prev.sections.schedule.data) || {}).some(t => t && t.live);
  return !live && prev.ctx.today === ctx.today && prev.ctx.statsSeason === ctx.statsSeason && nowMs - prev.generatedAt < SKIP_WHEN_QUIET_MS && Object.keys(prev.errors || {}).length === 0;
}

async function run(opts) {
  const outDir = opts.outDir;
  const nowMs = opts.now || (() => Date.now());
  fs.mkdirSync(outDir, { recursive: true });
  const prev = readJSON(path.join(outDir, 'snapshot.json'));
  const C = K.create({ teams: CFG.TEAMS, base: CFG.MLB_BASE, fetch: opts.fetch, now: nowMs, log: opts.log || (() => {}) });

  const today = K.etDay(new Date(nowMs()));
  if (prev && prev.ctx && opts.quickCheck !== false) {
    const info = prev.seasonInfo || null;
    if (shouldSkip(prev, K.computeContext(today, info), nowMs())) return { skipped: true };
  }
  const snap = await C.buildSnapshot(prev);
  if (!Object.keys(snap.sections).length) throw new Error('MLB returned nothing: ' + JSON.stringify(snap.errors));
  writeJSON(path.join(outDir, 'snapshot.json'), snap);

  const model = C.buildModel(snap.sections);
  const ctx = snap.ctx;
  const complete = ['standings', 'hitting', 'pitching'].every(k => snap.sections[k] && snap.sections[k].season === ctx.statsSeason && !snap.errors[k]);

  // trend.json: reset when the season changes; one point per day
  let trend = readJSON(path.join(outDir, 'trend.json')) || { season: ctx.statsSeason, points: [] };
  if (String(trend.season) !== String(ctx.statsSeason)) trend = { season: ctx.statsSeason, points: [] };
  if (complete && (ctx.phase === 'regular' || ctx.phase === 'postseason')) {
    const pt = C.makeTrendPoint(ctx, model);
    if (pt) trend.points = trend.points.filter(p => p.d !== pt.d).concat(pt).sort((a, b) => (a.d < b.d ? -1 : 1));
  }
  writeJSON(path.join(outDir, 'trend.json'), trend);

  // history.json: only finished seasons
  const history = readJSON(path.join(outDir, 'history.json')) || {};
  if (complete && (ctx.phase === 'after' || ctx.phase === 'before')) {
    const entry = C.makeHistoryEntry(ctx, model);
    if (entry) history[ctx.statsSeason] = entry;
  }
  writeJSON(path.join(outDir, 'history.json'), history);
  return { skipped: false, errors: snap.errors, phase: ctx.phase, trendPoints: trend.points.length, seasons: Object.keys(history) };
}

module.exports = { run, shouldSkip };

if (require.main === module) {
  const outDir = path.resolve(process.argv[2] || 'data-out');
  run({ outDir, fetch: globalThis.fetch }).then(r => {
    console.log(JSON.stringify(r));
    if (r.errors && Object.keys(r.errors).length) console.warn('Partial errors:', r.errors);
  }).catch(e => { console.error(e); process.exit(1); });
}
