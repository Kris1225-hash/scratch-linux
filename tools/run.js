#!/usr/bin/env node
'use strict';
// boot the kernel on the js build of the emulator (same SBL source as the scratch build)
const fs = require('fs');
const path = require('path');
const { buildEmu } = require('../emu/build');
const { mkimage } = require('./mkimage');
const { instantiate } = require('../sbl/backend_js');
// how often each handler runs (boot + a shell session), recorded with --profile: it shapes the dispatch tree
const WEIGHTS = path.join(__dirname, '..', 'emu', 'weights.json');

function parseArgs(argv) {
  const o = { ramMB: 16, strict: false, maxInsns: Infinity, extra: '', input: null, quiet: false, profile: false, earlyprintk: false, timeLimit: Infinity, inputAt: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') o.strict = true;
    else if (a === '--profile') o.profile = true;
    else if (a === '--early') o.earlyprintk = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--until-prompt') o.untilPrompt = true;
    else if (a === '--fuse') o.fuse = true;
    else if (a === '--seed') o.seed = true;
    else if (a === '--paged') o.paged = true;         // the memory model of the scratch.mit.edu build (emu/mem.js)
    else if (a === '--compact') o.compact = +argv[++i]; // rare handlers in their compact form (emu/handlers.js)
    else if (a === '--ram') o.ramMB = +argv[++i];
    else if (a === '--max') o.maxInsns = +argv[++i];
    else if (a === '--secs') o.timeLimit = +argv[++i];
    else if (a === '--append') o.extra = argv[++i];
    else if (a === '--input') o.input = argv[++i];          // text typed at the console once the prompt shows up
    else throw new Error('unknown arg ' + a);
  }
  return o;
}

function makeMachine(opts) {
  const base = { target: 'js', ramMB: opts.ramMB, profile: !!opts.profile };
  const cfg0 = Object.assign(base, opts.cfg || {});
  if (opts.paged) cfg0.paged = true;
  if (opts.compact) cfg0.compact = opts.compact;
  // fused instruction sequences (out/fuse.json from tools/mkfuse.js) only on request: the plain interpreter,
  // one handler per instruction, is the reference that gets checked against qemu
  if (opts.fuse) {
    const fuse = typeof opts.fuse === 'object' ? opts.fuse : JSON.parse(fs.readFileSync(typeof opts.fuse === 'string' ? opts.fuse : path.join(__dirname, '..', 'out', 'fuse.json'), 'utf8'));
    // (out/fuse.json is what tools/mkfuse.js writes)
    cfg0.fuse = fuse; cfg0.weights = fuse.weights;
  }
  // dispatch tree shaped by the last recorded handler profile, same as the scratch build
  if (!cfg0.weights && !opts.noProfile) { try { cfg0.weights = JSON.parse(fs.readFileSync(WEIGHTS, 'utf8')); } catch (e) { /* none yet */ } }
  const vt = cfg0.vtPerInsn || 0.125;
  const lpj = Math.round(11931.82 / vt / 2);
  const cmdline = `console=ttyS0 ${opts.earlyprintk ? 'earlyprintk=serial,ttyS0 ' : ''}clocksource=jiffies lpj=${lpj}${opts.extra ? ' ' + opts.extra : ''}`;
  const image = mkimage(opts.vmlinux || path.join(__dirname, '..', 'out', 'kernel', 'vmlinux'), { ramMB: cfg0.ramMB, cmdline });
  // the pre-decoded block cache the scratch build ships with (only on request, like fusion)
  if (opts.seed) cfg0.seed = require('./mkseed').makeSeed(Object.assign({ bootEip: image.entry, bootEsi: image.bootParams }, cfg0), image, typeof opts.seed === 'object' ? opts.seed : {});
  const built = buildEmu(Object.assign({ bootEip: image.entry, bootEsi: image.bootParams }, cfg0), image);
  const t = new Date(2026, 10, 25, 12, 0, 0);
  const host = Object.assign({
    rtc: (k) => [t.getSeconds(), t.getMinutes(), t.getHours(), t.getDay() + 1, t.getDate(), t.getMonth() + 1, t.getFullYear()][k],
    stopall() {},
  }, opts.host || {});
  const { inst, src } = instantiate(built.prog, host, built.data, { strict: !!opts.strict, countOps: !!opts.countOps });
  return { inst, src, image, cmdline, built };
}

const HALT = { 1: 'double fault', 2: 'interrupt delivery failed', 3: 'non-flat segment', 4: '16-bit code segment', 5: 'unsupported gate type',
  6: 'bad code segment in gate', 7: 'iret with NT', 8: 'iret to vm86', 11: 'page directory entry outside ram', 12: 'cr3 outside ram',
  20: 'unimplemented opcode', 21: 'enter with nesting', 50: 'stack window out of sync (emulator bug)', 22: 'retf to another privilege level', 23: 'verr/verw', 30: 'reset requested',
  40: 'hlt with interrupts disabled (system halted)', 41: 'idle with no timer armed' };

function dumpState(m, log = console.error) {
  const { vars: v, lists: L } = m.inst;
  const hx = (x) => (x >>> 0).toString(16).padStart(8, '0');
  const r = L.reg;
  log(`  eip=${hx(L.tI[v.tp - 1])} (block eip ${hx(v.eip)}) cpl=${v.cpl} tp=${v.tp} handler=${m.built.nameOf(L.tH[v.tp - 1])}`);
  log(`  eax=${hx(r[0])} ecx=${hx(r[1])} edx=${hx(r[2])} ebx=${hx(r[3])} esp=${hx(r[4])} ebp=${hx(r[5])} esi=${hx(r[6])} edi=${hx(r[7])}`);
  log(`  cr0=${hx(v.cr0)} cr2=${hx(v.cr2)} cr3=${hx(v.cr3)} if=${v.fl_if} halted=${v.halted} code=${v.halt_code} (${HALT[v.halt_code] || '?'}) info=0x${(v.halt_info >>> 0).toString(16)}`);
  log(`  icount=${v.icount} blocks=${v.nblocks} trace=${v.tnext} inval=${v.ninval} flush=${v.nflush}`);
}

function main() {
  const o = parseArgs(process.argv);
  const m = makeMachine(o);
  const { vars: v, lists: L, procs: P } = m.inst;
  if (!o.quiet) console.error(`[run] cmdline: ${m.cmdline}`);
  const t0 = Date.now();
  P.reset();
  let out = '';
  let typed = false;
  let lastOut = Date.now();
  const flush = () => {
    if (L.uart_tx.length) {
      const s = Buffer.from(L.uart_tx).toString('latin1');
      L.uart_tx.length = 0;
      out += s;
      if (!o.quiet) process.stdout.write(s);
      lastOut = Date.now();
    }
  };
  try {
    while (v.halted < 2 && v.icount < o.maxInsns && (Date.now() - t0) / 1000 < o.timeLimit) {
      for (let i = 0; i < 40 && v.halted < 2; i++) {
        P.machine_step();
        if (v.halted === 1 && v.irq_out === 0) P.idle_skip();
      }
      flush();
      // scripted input: type it once the shell prompt is sitting there
      if (o.untilPrompt && /# $/.test(out)) { console.error(`\n[run] shell prompt after ${v.icount} instructions`); break; }
      if (o.input !== null && !typed && /# $/.test(out)) {
        typed = true;
        for (const c of Buffer.from(o.input.replace(/\\n/g, '\n'), 'latin1')) L.uart_rx.push(c);
      }
    }
  } catch (e) {
    flush();
    console.error('\n[run] emulator threw: ' + e.message);
    dumpState(m);
    process.exit(2);
  }
  flush();
  const dt = (Date.now() - t0) / 1000;
  console.error(`\n[run] stopped after ${v.icount} instructions in ${dt.toFixed(1)}s (${(v.icount / dt / 1e6).toFixed(2)} MIPS)`);
  dumpState(m);
  if (o.profile) {
    const rows = m.built.handlers.map((h) => [h.name, L.prof[h.did - 1]]).filter((r) => r[1] > 0).sort((a, b) => b[1] - a[1]);
    const total = rows.reduce((s, r) => s + r[1], 0);
    fs.writeFileSync(WEIGHTS, JSON.stringify(Object.fromEntries(rows), null, 1) + '\n');
    console.error(rows.slice(0, 40).map((r) => `${r[0].padEnd(16)} ${(100 * r[1] / total).toFixed(2)}%`).join('\n'));
  }
}

if (require.main === module) main();
module.exports = { makeMachine, dumpState, HALT };
