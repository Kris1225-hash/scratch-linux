#!/usr/bin/env node
'use strict';
// differential run: the reference interpreter (A: one handler per instruction, nothing pre-decoded, the build
// that tools/lockstep.js checks against qemu) next to the configuration the scratch project ships with
// (B: block cache seeded at build time, and with --fuse also fused instruction sequences). after every dispatch
// of B, A executes the same instructions and the complete cpu state is compared; memory is compared every so
// often and at the end. the workload is a boot and a few shell lines.
//   node tools/diffrun.js [--max N] [--fuse out/fuse.json] [--no-seed] [--mem-every N] [--show]
const fs = require('fs');
const path = require('path');
const { makeMachine } = require('./run');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const MAX = +opt('--max', 40e6);
const MEMEVERY = +opt('--mem-every', 400000);
const WORK = opt('--work', '') ? opt('--work', '').split('\\n') : [
  'uname -a; ls -l / | head -4; free; ps | tail -2',
  'echo hello | tr a-z A-Z; seq 1 80 | sort -rn | tail -2; head -c 3000 /bin/busybox | md5sum',
  'for i in 1 2 3 4 5; do echo $((i*i)); done; x=0; while [ $x -lt 30 ]; do x=$((x+1)); done; echo $x',
  'echo "3.5 2" | awk "{print \\$1*\\$2, sqrt(\\$1)}"; echo "2^64" | bc; factor 360360',
  'mkdir /tmp/a; cd /tmp/a; echo hi > f; cat f f | uniq -c; ls -la; cd /; rm -r /tmp/a; nosuch; cat /proc/uptime',
  'find /etc -type f | xargs grep -c root; sed -n "s/root/toor/p" /etc/passwd; date +%Y; sleep 1; echo done',
];

const A = makeMachine({ ramMB: 16, cfg: { sliceInsns: 1 } });
const B = makeMachine({ ramMB: 16, fuse: opt('--fuse', false), seed: !process.argv.includes('--no-seed'), cfg: { sliceInsns: 1 } });
const a = A.inst, b = B.inst;
const VT = 0.125;
const unitN = new Map();                 // dispatch id -> instructions in the fused sequence
for (const h of B.built.handlers) if (h.fuse) unitN.set(h.did, h.fuse.n);
const hx = (x) => (x >>> 0).toString(16).padStart(8, '0');

const PAR = []; for (let i = 0; i < 256; i++) { let n = 0; for (let k = 0; k < 8; k++) n += (i >> k) & 1; PAR.push(n % 2 === 0 ? 1 : 0); }
function eflags(v) {
  const fk = v.fk, fz = v.fz, fx = v.fx, fy = v.fy, SMAX = 2147483647;
  let of, af, sf, pf;
  if (fk === 64) { of = +v.fo; af = +v.fa; sf = +v.xs; pf = +v.xp; }
  else {
    const k = fk % 4, sc = Math.floor(fk / 8), sh = [1, 65536, 16777216][sc];
    if (k === 3) { of = +v.fo; af = +v.fa; }
    else if (k === 0) { of = 0; af = 0; }
    else {
      const sa = fx > SMAX, sb = fy > SMAX, sr = fz > SMAX;
      of = k === 1 ? +(sa === sb && sr !== sa) : +(sa !== sb && sr !== sa);
      af = (Math.floor(fx / (sh * 16)) + Math.floor(fy / (sh * 16)) + Math.floor(fz / (sh * 16))) % 2;
    }
    sf = +(fz > SMAX); pf = PAR[Math.floor(fz / sh) % 256];
  }
  return (+v.cf) + 2 + pf * 4 + af * 16 + (fz === 0 ? 64 : 0) + sf * 128 + v.fl_tf * 256 + v.fl_if * 512 + v.fl_df * 1024 + of * 2048
    + v.fl_iopl * 4096 + v.fl_nt * 16384 + v.fl_ac * 262144 + v.fl_id * 2097152;
}
const eipOf = (m) => m.lists.tI[m.vars.tp - 1];
function diffState() {
  const d = [];
  const RN = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
  for (let i = 0; i < 8; i++) if (a.lists.reg[i] !== b.lists.reg[i]) d.push(`${RN[i]}: reference ${hx(a.lists.reg[i])} shipped ${hx(b.lists.reg[i])}`);
  for (let i = 9; i < 15; i++) if (a.lists.reg[i] !== b.lists.reg[i]) d.push(`segbase${i - 9}: reference ${hx(a.lists.reg[i])} shipped ${hx(b.lists.reg[i])}`);
  for (let i = 0; i < 6; i++) if (a.lists.segsel[i] !== b.lists.segsel[i]) d.push(`seg${i}: reference ${a.lists.segsel[i]} fused ${b.lists.segsel[i]}`);
  if (eipOf(a) !== eipOf(b)) d.push(`eip: reference ${hx(eipOf(a))} shipped ${hx(eipOf(b))}`);
  const ea = eflags(a.vars), eb = eflags(b.vars);
  if (ea !== eb) d.push(`eflags: reference ${hx(ea)} shipped ${hx(eb)}`);
  for (const k of ['cpl', 'cr0', 'cr2', 'cr3', 'halted', 'halt_code', 'fl_if', 'irq_out']) if (a.vars[k] !== b.vars[k]) d.push(`${k}: reference ${a.vars[k]} fused ${b.vars[k]}`);
  return d;
}
function diffMem() {
  const ma = a.lists.memw, mb = b.lists.memw;
  for (let i = 0; i < ma.length; i++) if (ma[i] !== mb[i]) return `memory word at phys ${hx(i * 4)}: reference ${hx(ma[i])} shipped ${hx(mb[i])}`;
  return null;
}

a.procs.reset(); b.procs.reset();
let n = 0, insns = 0, unitRuns = 0, unitInsns = 0, faultsInUnits = 0, line = 0, outA = '', outB = '', lastMem = 0, idle = 0;
const t0 = Date.now();
const fail = (msg, extra) => {
  console.log(`\n=== MISMATCH after ${n} dispatches (${insns} instructions): ${msg}`);
  for (const x of extra || []) console.log('  ' + x);
  process.exit(1);
};
const HN = B.built.dispatchNames;
let last = '';
while (n < MAX) {
  if (b.vars.halted === 2 || a.vars.halted === 2) { if (a.vars.halted !== b.vars.halted) fail('one machine stopped'); break; }
  if (b.vars.halted === 1) {
    if (a.vars.halted !== 1) fail('fused halted, interp not');
    // idle: type the next line once the shell is at its prompt, then jump to the next timer tick on both
    if (b.vars.irq_out === 0) {
      if (/(# |\n> )$/.test(outB.slice(-40)) && b.lists.uart_rx.length === 0) {
        if (line < WORK.length) { for (const c of Buffer.from(WORK[line++] + '\r')) { a.lists.uart_rx.push(c); b.lists.uart_rx.push(c); } outB += '\0'; }
        else if (++idle > 20) break;
      }
      a.procs.idle_skip(); b.procs.idle_skip();
    }
    a.procs.machine_poll(); b.procs.machine_poll();
  } else {
    const did = b.lists.tH[b.vars.tp - 1];
    const un = unitN.get(did);
    const e0 = b.vars.nexc;
    last = `${HN[did - 1]} at ${hx(eipOf(b))}`;
    b.vars.flt = 0; b.procs.run(1);
    let k = 1;
    if (un === undefined) { a.vars.flt = 0; a.procs.run(1); }
    else {
      unitRuns++;
      if (b.vars.nexc !== e0) {
        // a fault inside the unit: the interpreter must hit the same one within the unit's instructions
        faultsInUnits++;
        const a0 = a.vars.nexc; k = 0;
        while (a.vars.nexc === a0 && k < un) { a.vars.flt = 0; a.procs.run(1); k++; }
        if (a.vars.nexc === a0) fail(`fused faulted in ${last}, the interpreter did not`, diffState());
      } else {
        const a0 = a.vars.nexc;
        for (k = 0; k < un; k++) { a.vars.flt = 0; a.procs.run(1); }
        if (a.vars.nexc !== a0) fail(`the interpreter faulted inside ${last}, fused did not`, diffState());
      }
      unitInsns += k;
    }
    n++; insns += k;
    const d = diffState();
    if (d.length) fail(`after ${last}`, d);
    // same clock for both
    a.vars.icount += k; b.vars.icount += k; a.vars.vt += k * VT; b.vars.vt += k * VT;
    a.procs.machine_poll(); b.procs.machine_poll();
    const d2 = diffState();
    if (d2.length) fail(`after interrupt delivery following ${last}`, d2);
  }
  if (a.lists.uart_tx.length || b.lists.uart_tx.length) {
    outA += Buffer.from(a.lists.uart_tx).toString('latin1'); outB += Buffer.from(b.lists.uart_tx).toString('latin1');
    a.lists.uart_tx.length = 0; b.lists.uart_tx.length = 0;
    if (outA !== outB.replace(/\0/g, '')) fail('console output differs');
  }
  if (n - lastMem >= MEMEVERY) { lastMem = n; const md = diffMem(); if (md) fail(md, [`last: ${last}`]); }
}
const md = diffMem();
if (md) fail(md);
const dt = (Date.now() - t0) / 1000;
console.log(`[diffrun] blocks: ${b.vars.nblocks} looked up, ${b.vars.n_seeded} of them came from the seed`);
console.log(`[diffrun] OK: ${n} dispatches = ${insns} instructions compared in ${dt.toFixed(1)}s; ${unitRuns} fused dispatches covering ${unitInsns} instructions (${(100 * unitInsns / insns).toFixed(1)}%), ${faultsInUnits} faults inside fused sequences, ${line}/${WORK.length} shell lines, memory identical`);
if (process.argv.includes('--show')) process.stdout.write(outB.replace(/\0/g, '').slice(-1500) + '\n');
