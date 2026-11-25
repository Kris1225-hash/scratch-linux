'use strict';
// where does the boot spend its instructions? sample eip once per slice and bucket by kernel symbol
const fs = require('fs');
const { makeMachine } = require('./run');
const path = require('path');
const KDIR = process.env.KDIR || path.join(__dirname, '..', 'out', 'kernel');
const syms = fs.readFileSync(path.join(KDIR, 'System.map'), 'utf8').split('\n').map((l) => l.split(' ')).filter((p) => p.length === 3).map((p) => [parseInt(p[0], 16), p[2]]).sort((a, b) => a[0] - b[0]);
function sym(a) { if (a < syms[0][0]) return a < 0xc0000000 ? '<user>' : '?'; let lo = 0, hi = syms.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (syms[m][0] <= a) lo = m; else hi = m - 1; } return syms[lo][1]; }
const m = makeMachine({ ramMB: +(process.env.RAM || 16), vmlinux: path.join(KDIR, 'vmlinux') });
const { vars: v, lists: L, procs: P } = m.inst;
P.reset();
const hist = new Map(); let out = '', n = 0;
const phases = [];
while (v.halted < 2 && v.icount < 60e6) {
  P.machine_step();
  if (v.halted === 1 && v.irq_out === 0) P.idle_skip();
  const s = sym(L.tI[v.tp - 1] >>> 0); hist.set(s, (hist.get(s) || 0) + 1); n++;
  if (L.uart_tx.length) { const t = Buffer.from(L.uart_tx).toString('latin1'); L.uart_tx.length = 0; out += t;
    for (const line of t.split('\n')) if (/\] (Memory:|devtmpfs|Serial:|Freeing|Run \/init|workingset|sched_clock|pid_max|printk: legacy console)/.test(line)) phases.push(`${(v.icount / 1e6).toFixed(2)}M ${line.trim().slice(0, 70)}`); }
  if (/# $/.test(out)) break;
}
console.log(`prompt at ${(v.icount / 1e6).toFixed(2)}M instructions`);
console.log(phases.join('\n'));
console.log([...hist].sort((a, b) => b[1] - a[1]).slice(0, 28).map(([k, c]) => `${(100 * c / n).toFixed(1).padStart(5)}% ${k}`).join('\n'));
