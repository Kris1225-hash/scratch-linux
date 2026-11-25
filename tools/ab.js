#!/usr/bin/env node
'use strict';
// boot-time A/B of several .sb3 builds in the vanilla vm: best of N runs each, interleaved so that background
// load hits every variant alike.   node tools/ab.js [-n 3] out/a.sb3 out/b.sb3 ...
const { execFileSync } = require('child_process');
const path = require('path');
const args = process.argv.slice(2);
let N = 3; if (args[0] === '-n') { N = +args[1]; args.splice(0, 2); }
const best = new Map();
for (let i = 0; i < N; i++) for (const f of args) {
  let out = '';
  const r = require('child_process').spawnSync('node', [path.join(__dirname, 'run_sb3.js'), '--sb3', f, '--secs', '150', '--until-prompt'], { encoding: 'utf8' });
  out = (r.stdout || '') + (r.stderr || '');
  const m = /after ([0-9.]+)s \(cpu ([0-9.]+)s\)/.exec(out + '');
  // stderr carries the line; execFileSync only returns stdout, so rerun through a shell if needed
  if (!m) { console.log(`  ${f} run ${i + 1}: no prompt`); continue; }
  const w = +m[1], c = +m[2];
  console.log(`  ${path.basename(f)} run ${i + 1}: wall ${w} cpu ${c}`);
  const b = best.get(f) || { w: Infinity, c: Infinity };
  best.set(f, { w: Math.min(b.w, w), c: Math.min(b.c, c) });
}
for (const [f, b] of best) console.log(`${path.basename(f).padEnd(18)} best wall ${b.w.toFixed(1)}s  best cpu ${b.c.toFixed(1)}s`);
