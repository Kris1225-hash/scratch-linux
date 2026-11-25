#!/usr/bin/env node
'use strict';
// lockstep: run real qemu (tcg, one instruction per tb, logging cpu state) next to the js build of the
// scratch emulator, feed our emulator qemu's port reads and hardware interrupts, and compare the full
// register state after every single instruction. the first divergence is a bug in our cpu.
//
// needs qemu-system-i386 on the PATH (written against qemu 8.2 and 11.1).
//   node tools/lockstep.js [--max N] [--script "shell commands"] [--input "typed text\n"] [--watch physaddr]
//                          [--strict] [--keep-going] [--ram MB] [--quiet] [--progress N] [--dump-log]
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { mkimage, writeFlat } = require('./mkimage');
const { mkrom } = require('./mkrom');
const { makeMachine, HALT } = require('./run');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i < 0 ? def : (typeof def === 'boolean' ? true : args[i + 1]); };
const MAX = +opt('--max', 1e12);
const STRICT = opt('--strict', false);
const KEEP = opt('--keep-going', false);
const RAM = +opt('--ram', 16);
const QUIET = opt('--quiet', false);
const INPUT = opt('--input', '');           // typed at qemu's serial port when the prompt appears
const PROGRESS = +opt('--progress', 1000000);
const WATCH = opt('--watch', null) === null ? -1 : parseInt(opt('--watch', '0'), 16);
let watchVal = 0;
const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'out', 'lockstep');
fs.mkdirSync(DIR, { recursive: true });

const hx = (x) => (x >>> 0).toString(16).padStart(8, '0');
const LPJ = 47727;
// --script "cmds": run a shell script as init instead of the interactive shell. no typed input, so the whole
// run is deterministic and a divergence can be chased with --watch on a second pass.
const SCRIPT = opt('--script', '');
const CMDLINE = `console=ttyS0 earlyprintk=serial,ttyS0 clocksource=jiffies lpj=${LPJ}` + (SCRIPT ? ` rdinit=/bin/sh -- -c "${SCRIPT}"` : '');

// ---- our machine (lockstep build: port reads come from the host, rep string ops stop where qemu's do)
const m = makeMachine({
  ramMB: RAM, strict: STRICT, earlyprintk: true, extra: SCRIPT ? `rdinit=/bin/sh -- -c "${SCRIPT}"` : '',
  cfg: { lockstep: true, repChunk: 1, spCheck: true },
  host: {
    // qemu only logs accesses that hit a device; ports nobody owns read as all ones and swallow writes
    io_in: (port, size) => {
      let val = 0, got = 0;
      while (got < size) {
        const e = ioq[0];
        if (!e || e.port !== port + got) break;
        ioq.shift();
        val += (e.val >>> 0) * Math.pow(256, got);
        got += e.size;
      }
      if (got === 0) { if (ioq.length) problem(`port read mismatch: ours 0x${port.toString(16)}, qemu 0x${ioq[0].port.toString(16)}`); return Math.pow(256, size) - 1; }
      for (; got < size; got++) val += 255 * Math.pow(256, got);
      return val;
    },
    io_out: (port, size, val) => {
      let got = 0;
      while (got < size) {
        const e = outq[0];
        if (!e || e.port !== port + got) break;
        outq.shift();
        const part = Math.floor(val / Math.pow(256, got)) % Math.pow(256, e.size);
        if ((e.val >>> 0) !== part) problem(`port write mismatch at 0x${e.port.toString(16)}: ours ${hx(part)}, qemu ${hx(e.val)}`);
        got += e.size;
      }
      if (got === 0 && outq.length) problem(`port write mismatch: ours 0x${port.toString(16)}, qemu 0x${outq[0].port.toString(16)}`);
    },
  },
});
const { vars: v, lists: L, procs: P } = m.inst;
const HN = m.built.dispatchNames;
const hid = (name) => m.built.handlers.find((h) => h.name === name).did;
const PSEUDO = new Set([hid('END'), hid('LEA_TMP'), hid('LEA16_TMP'), hid('LOCK_PROBE'), hid('SPSYNC')]);

// qemu side files
const image = m.image;
writeFlat(image, DIR);
const rom = mkrom(image.entry, image.bootParams);
fs.writeFileSync(path.join(DIR, 'rom.bin'), rom);
if (m.cmdline !== CMDLINE) throw new Error(`cmdline mismatch:\n ${m.cmdline}\n ${CMDLINE}`);

// ---- flags, computed here from the lazy state without disturbing it
const PAR = []; for (let i = 0; i < 256; i++) { let n = 0; for (let b = 0; b < 8; b++) n += (i >> b) & 1; PAR.push(n % 2 === 0 ? 1 : 0); }
function ourEflags() {
  const fk = v.fk, fz = v.fz, fx = v.fx, fy = v.fy;
  let of, af, sf, pf;
  const SMAX = 2147483647;
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
const ourEip = () => L.tI[v.tp - 1];

// read guest memory through our page tables (for diagnostics only; no side effects)
function physRead8(pa) { const w = L.memw[pa >>> 2]; return (w >>> ((pa & 3) * 8)) & 255; }
function physRead32(pa) { return L.memw[pa >>> 2] >>> 0; }
function lin2phys(lin) {
  if (!v.pg_on) return lin;
  const pde = physRead32((v.cr3 & ~0xfff) + ((lin >>> 22) << 2));
  if (!(pde & 1)) return -1;
  const pte = physRead32((pde & ~0xfff) + (((lin >>> 12) & 0x3ff) << 2));
  if (!(pte & 1)) return -1;
  return ((pte & ~0xfff) | (lin & 0xfff)) >>> 0;
}
function codeBytes(lin, n = 12) {
  const out = [];
  for (let i = 0; i < n; i++) { const pa = lin2phys((lin + i) >>> 0); if (pa < 0 || pa >= RAM * 1048576) { out.push('??'); continue; } out.push(physRead8(pa).toString(16).padStart(2, '0')); }
  return out.join(' ');
}

// ---- event queues filled by the qemu log parser
let ioq = [], outq = [];
const problems = [];
let fatalProblem = false;
function problem(msg) { problems.push(msg); }

// ---- qemu
const qargs = ['-M', 'pc', '-cpu', '486,-fpu,-vme,-pse', '-m', String(RAM), '-nodefaults', '-vga', 'none', '-display', 'none',
  '-serial', INPUT ? 'stdio' : `file:${path.join(DIR, 'serial.txt')}`, '-bios', path.join(DIR, 'rom.bin'),
  '-device', `loader,file=${path.join(DIR, 'kernel.bin')},addr=0x100000,force-raw=on`,
  '-device', `loader,file=${path.join(DIR, 'bootparams.bin')},addr=0x10000,force-raw=on`,
  '-accel', 'tcg,one-insn-per-tb=on', '-no-reboot',
  // virtual time follows the instruction count (1 insn = 128 ns, about the speed our machine claims to be);
  // with wall-clock time and this much logging the guest would do nothing but service timer ticks
  '-icount', 'shift=7', '-rtc', 'clock=vm,base=2026-11-25T12:00:00',
  '-d', 'cpu,int,trace:memory_region_ops_read,trace:memory_region_ops_write', '-D', path.join(DIR, 'fifo')];
// qemu writes its log to a fifo that we read: keeps the (enormous) trace off the disk and in order
try { fs.unlinkSync(path.join(DIR, 'fifo')); } catch (e) { /* none */ }
require('child_process').execFileSync('mkfifo', [path.join(DIR, 'fifo')]);
const qemu = spawn('qemu-system-i386', qargs, { stdio: ['pipe', 'pipe', 'inherit'] });
const logStream = fs.createReadStream(path.join(DIR, 'fifo'), { highWaterMark: 1 << 20 });
let serialOut = '';
if (INPUT) qemu.stdout.on('data', (d) => { serialOut += d.toString('latin1'); });

// ---- state machine driven by parsed records
let started = false, done = false;
let n = 0;                 // instructions compared
let prev = null;           // previous qemu record (state before the instruction we are about to run)
let events = [];           // events between prev and the next record
let lastName = '', lastEip = 0;
const resyncs = new Map();
const seenResync = new Set();
const t0 = Date.now();
let typed = false;
let repTail = false, repEip = 0, ignoreEip = false;
const ring = new Array(600); let ringN = 0;      // the last raw log lines, for post-mortems

// instruction classes whose flag results are (partly) undefined: adopt qemu's and carry on
const FLAG_UNDEF = /^(G_BT|BT_RI|BTS_RI|BTR_RI|G_BSF|G_BSR|G_MUL|G_IMUL|IMUL_|G_DIV|G_IDIV|G_SHIFT|G_SHLD|G_SHRD|SHL_RI|SHR_RI|SAR_RI|SHL_RC|SHR_RC)/;
const EFL_MASK = 0x00247fd5;

function initFrom(r) {
  P.reset();
  // qemu has the rom mapped below 1M; the kernel may look at it
  for (let i = 0; i < rom.length; i += 4) L.memw[(0xf0000 + i) >>> 2] = rom.readUInt32LE(i);
  for (let i = 0; i < 8; i++) L.reg[i] = r.regs[i];
  v.spw = 1;
  for (let i = 0; i < 6; i++) { L.segsel[i] = r.seg[i]; L.reg[9 + i] = r.segbase[i]; }
  v.cr0 = r.cr0; v.cr2 = r.cr2; v.cr3 = r.cr3; v.cr4 = r.cr4;
  v.gdt_base = r.gdt[0]; v.gdt_limit = r.gdt[1]; v.idt_base = r.idt[0]; v.idt_limit = r.idt[1];
  P.set_aflags(r.efl); P.set_sflags(r.efl, 0);
  v.fl_iopl = (r.efl >> 12) & 3; v.fl_if = (r.efl >> 9) & 1;
  v.eip = r.eip;
  P.find_block();
}

function describe(r) {
  return `eax=${hx(r.regs[0])} ecx=${hx(r.regs[1])} edx=${hx(r.regs[2])} ebx=${hx(r.regs[3])} esp=${hx(r.regs[4])} ebp=${hx(r.regs[5])} esi=${hx(r.regs[6])} edi=${hx(r.regs[7])} eip=${hx(r.eip)} efl=${hx(r.efl)} cpl=${r.cpl}`;
}
function ourRecord() {
  return { regs: Array.from(L.reg.slice(0, 8)), eip: ourEip(), efl: ourEflags(), cpl: v.cpl, cr0: v.cr0, cr2: v.cr2, cr3: v.cr3,
    seg: Array.from(L.segsel) };
}
const RN = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

function compare(r) {
  const diffs = [];
  for (let i = 0; i < 8; i++) if ((L.reg[i] >>> 0) !== r.regs[i] || L.reg[i] !== (L.reg[i] >>> 0)) diffs.push(`${RN[i]}: ours ${typeof L.reg[i] === 'number' ? hx(L.reg[i]) : L.reg[i]} qemu ${hx(r.regs[i])}`);
  const e = ourEip();
  if (e !== r.eip && !ignoreEip) diffs.push(`eip: ours ${hx(e)} qemu ${hx(r.eip)}`);
  ignoreEip = false;
  if (v.cpl !== r.cpl) diffs.push(`cpl: ours ${v.cpl} qemu ${r.cpl}`);
  if ((v.cr0 >>> 0) !== r.cr0) diffs.push(`cr0: ours ${hx(v.cr0)} qemu ${hx(r.cr0)}`);
  if ((v.cr3 >>> 0) !== r.cr3) diffs.push(`cr3: ours ${hx(v.cr3)} qemu ${hx(r.cr3)}`);
  if ((v.cr2 >>> 0) !== r.cr2) diffs.push(`cr2: ours ${hx(v.cr2)} qemu ${hx(r.cr2)}`);
  for (let i = 0; i < 6; i++) if (L.segsel[i] !== r.seg[i]) diffs.push(`${['es', 'cs', 'ss', 'ds', 'fs', 'gs'][i]}: ours ${L.segsel[i].toString(16)} qemu ${r.seg[i].toString(16)}`);
  for (const i of [4, 5]) if ((L.reg[9 + i] >>> 0) !== r.segbase[i]) diffs.push(`${['es', 'cs', 'ss', 'ds', 'fs', 'gs'][i]}.base: ours ${hx(L.reg[9 + i])} qemu ${hx(r.segbase[i])}`);
  const oe = ourEflags();
  if (diffs.length === 0 && ((oe ^ r.efl) & EFL_MASK) !== 0) {
    if (FLAG_UNDEF.test(lastName)) {
      resyncs.set(lastName, (resyncs.get(lastName) || 0) + 1);
      const key = lastName + ':' + hx((oe ^ r.efl) & EFL_MASK);
      if (!seenResync.has(key)) { seenResync.add(key); console.log(`[lockstep] resync #${n} ${lastName} at ${hx(lastEip)} bytes ${codeBytes(lastEip, 6)}: ours ${hx(oe & EFL_MASK)} qemu ${hx(r.efl & EFL_MASK)} diff ${hx((oe ^ r.efl) & EFL_MASK)} ecx=${hx(prev.regs[1])}`); }
      P.set_aflags(r.efl);
      return null;
    }
    diffs.push(`eflags: ours ${hx(oe & EFL_MASK)} qemu ${hx(r.efl & EFL_MASK)} (diff ${hx((oe ^ r.efl) & EFL_MASK)})`);
  }
  return diffs.length ? diffs : null;
}

function report(diffs, r) {
  console.log(`\n=== DIVERGENCE after ${n} instructions ===`);
  console.log(`last instruction: eip=${hx(lastEip)} handler=${lastName} bytes: ${codeBytes(lastEip)}`);
  if (prev) console.log(`before (qemu): ${describe(prev)}   bytes: ${codeBytes(prev.eip)}`);
  console.log(`after  (qemu): ${describe(r)}`);
  console.log(`after  (ours): ${describe(ourRecord())}`);
  for (const d of diffs) console.log('  ' + d);
  for (const p of problems) console.log('  ! ' + p);
  console.log(`  lazy flags: fz=${v.fz} fk=${v.fk} fx=${v.fx} fy=${v.fy} cf=${v.cf} fo=${v.fo} fa=${v.fa}`);
  if (opt('--dump-log', false)) {
    const lines = []; for (let i = Math.max(0, ringN - ring.length); i < ringN; i++) lines.push(ring[i % ring.length]);
    fs.writeFileSync(path.join(DIR, 'last-log.txt'), lines.join('\n') + '\n');
    console.log(`  (last ${lines.length} qemu log lines in out/lockstep/last-log.txt)`);
  }
  // poor man's backtrace: anything on the stack that looks like a kernel text address
  try {
    const syms = fs.readFileSync(path.join(ROOT, 'out', 'kernel', 'System.map'), 'utf8').split('\n').map((l) => l.split(' ')).filter((p) => p.length === 3 && /^[tT]$/.test(p[1])).map((p) => [parseInt(p[0], 16), p[2]]).sort((a, b) => a[0] - b[0]);
    const sym = (a) => { let lo = 0, hi = syms.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (syms[mid][0] <= a) lo = mid; else hi = mid - 1; } return `${syms[lo][1]}+0x${(a - syms[lo][0]).toString(16)}`; };
    const bt = [sym(lastEip)];
    const esp = prev ? prev.regs[4] : L.reg[4];
    for (let i = 0; i < 48 && bt.length < 9; i++) { const pa = lin2phys((esp + i * 4) >>> 0); if (pa < 0) break; const w = physRead32(pa); if (w >= syms[0][0] && w <= syms[syms.length - 1][0]) bt.push(sym(w)); }
    console.log('  stack: ' + bt.join(' <- '));
  } catch (e) { /* no map */ }
}

function finish(code) {
  if (done) return; done = true;
  try { qemu.kill('SIGKILL'); } catch (e) { /* gone */ }
  const dt = (Date.now() - t0) / 1000;
  console.log(`\n[lockstep] ${n} instructions compared in ${dt.toFixed(1)}s (${(n / dt / 1000).toFixed(0)}k/s)`);
  if (resyncs.size) console.log('[lockstep] flag resyncs after undefined-flag instructions: ' + [...resyncs].map(([k, c]) => `${k}:${c}`).join(' '));
  try { fs.unlinkSync(path.join(DIR, 'fifo')); } catch (e) { /* gone */ }
  if (L.uart_tx.length && !QUIET) console.log('[lockstep] our console tail: ' + JSON.stringify(Buffer.from(L.uart_tx.slice(-300)).toString('latin1')));
  process.exit(code);
}

// run one real instruction on our side (pseudo trace entries are free)
function ourStep() {
  for (let guard = 0; guard < 8; guard++) {
    const h = L.tH[v.tp - 1];
    lastName = HN[h - 1]; lastEip = L.tI[v.tp - 1];
    v.flt = 0;
    P.run(1);
    if (!PSEUDO.has(h) || v.flt === 1) return;      // (a pseudo entry can fault too: the lock probe)
  }
  throw new Error('pseudo-op loop');
}

function onRecord(r) {
  if (!started) {
    if (r.eip === image.entry && (r.cr0 & 1) && r.seg[1] === 8) {
      started = true; initFrom(r); prev = r; events = [];
      const d = compare(r);
      if (d) { report(d, r); finish(1); }
      if (!QUIET) console.log(`[lockstep] in sync at kernel entry ${hx(r.eip)}`);
    }
    return;
  }
  // events between prev and r: port i/o done by the instruction, then interrupts taken after it
  ioq = []; outq = [];
  const hw = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.t === 'in') ioq.push(e); else if (e.t === 'out') outq.push(e);
    else if (e.t === 'hw') { const x = events[i + 1]; hw.push({ vec: e.vec, state: x && x.t === 'exc' ? x.state : null }); }
  }
  const hadEvents = events.length > 0;
  events = [];
  problems.length = 0;
  const sameState = (x) => {
    if (ourEip() !== x.eip) return false;
    for (let i = 0; i < 8; i++) if ((L.reg[i] >>> 0) !== x.regs[i]) return false;
    return true;
  };
  // run the instruction at prev, following a rep string op for as many iterations as qemu did (target = its ecx)
  const stepTo = (ecx) => {
    ourStep();
    if (lastName.startsWith('STR_')) {
      let guard = 0;
      while (v.halted === 0 && L.tI[v.tp - 1] === lastEip && HN[L.tH[v.tp - 1] - 1] === lastName && (L.reg[1] >>> 0) !== ecx) {
        v.flt = 0; P.run(1);
        if (++guard > 5e6) throw new Error('rep did not converge on qemu ecx');
      }
    }
  };
  try {
    if (hw.length) {
      // qemu logs a record before it enters a tb, but may then take an interrupt instead of running it.
      // the state dumped with the interrupt tells us whether the instruction ran.
      const s0 = hw[0].state;
      // a rep instruction that has done its last iteration still sits at its own eip in qemu (it has yet to
      // notice ecx == 0), and that is the return address an interrupt taken right there gets. we are already past it.
      let ret = null;
      if (v.halted === 1) { v.halted = 0; }
      else if (repTail) {
        // (it may also have stepped over the finished rep first: the state dumped with the interrupt says which)
        repTail = false;
        if (!s0 || s0.eip === repEip) ret = repEip;
      }
      else if (s0 && !sameState(s0)) {
        stepTo(s0.regs[1]);
        if (lastName.startsWith('STR_') && s0.eip === lastEip && ourEip() !== s0.eip && (L.reg[1] >>> 0) === 0 && s0.regs[1] === 0) ret = lastEip;
      }
      for (const e of hw) {
        v.halted = 0;
        const eip = ret !== null ? ret : ourEip();
        ret = null;
        v.flt = 0;
        P.do_interrupt(e.vec, 0, 0, 0, eip);
        v.flt = 0;
        lastName = 'hwint';
      }
    } else if (v.halted === 1) {
      problem('we are halted but qemu executed an instruction');
    } else if (!hadEvents && r.eip === prev.eip && r.efl === prev.efl && r.regs.every((x, i) => x === prev.regs[i])) {
      // identical record twice: qemu was kicked out of the tb before running it (or it is a jump-to-self). nothing to do
      return;
    } else if (repTail) {
      // qemu re-entered a finished rep instruction just to see ecx == 0 and fall through: we are already past it
      repTail = false;
    } else {
      stepTo(r.regs[1]);
      if (lastName.startsWith('STR_') && r.eip === lastEip && ourEip() !== r.eip && (L.reg[1] >>> 0) === 0 && r.regs[1] === 0) { repTail = true; repEip = lastEip; ignoreEip = true; }
    }
    if (ioq.length) problem(`qemu read port 0x${ioq[0].port.toString(16)} here but we did not`);
    if (outq.length) problem(`qemu wrote port 0x${outq[0].port.toString(16)} here but we did not`);
  } catch (e) {
    console.log(`\n=== OUR EMULATOR THREW after ${n} instructions: ${e.message}`);
    console.log(`last instruction: eip=${hx(lastEip)} handler=${lastName} bytes: ${codeBytes(lastEip)}`);
    console.log(`before (qemu): ${describe(prev)}`);
    finish(2);
    return;
  }
  n++;
  if (WATCH >= 0) {
    const w = L.memw[WATCH >>> 2];
    if (w !== watchVal) { console.log(`[watch] #${n} phys ${hx(WATCH)}: ${hx(watchVal)} -> ${hx(w)} by ${lastName} at ${hx(lastEip)} (cr3=${hx(v.cr3)} cpl=${v.cpl})`); watchVal = w; }
  }
  if (v.halted === 2) {
    console.log(`\n=== our machine stopped: code ${v.halt_code} (${HALT[v.halt_code] || '?'}) info 0x${(v.halt_info >>> 0).toString(16)} after ${n} instructions`);
    console.log(`last instruction: eip=${hx(lastEip)} handler=${lastName} bytes: ${codeBytes(lastEip)}`);
    finish(3); return;
  }
  const d = compare(r) || (problems.length ? ['i/o mismatch'] : null);
  if (d) {
    report(d, r);
    if (!KEEP) { finish(1); return; }
    // adopt qemu's state and continue
    for (let i = 0; i < 8; i++) L.reg[i] = r.regs[i];
    v.spw = 1;
    P.set_aflags(r.efl);
    if (ourEip() !== r.eip) { v.eip = r.eip; P.find_block(); }
  }
  prev = r;
  if (n % PROGRESS === 0 && !QUIET) console.log(`[lockstep] ${n} ok, eip=${hx(r.eip)}, ${((Date.now() - t0) / 1000).toFixed(0)}s, blocks=${v.nblocks}`);
  if (n >= MAX) { console.log(`[lockstep] reached --max ${MAX} with no divergence`); finish(0); }
}

// ---- log parser
let cur = null, attach = null, carry = '';
const SEGN = { 'ES ': 0, 'CS ': 1, 'SS ': 2, 'DS ': 3, 'FS ': 4, 'GS ': 5 };
function onLine(line) {
  ring[ringN++ % ring.length] = line;
  const c0 = line.charCodeAt(0);
  if (c0 === 69) {                                   // 'E'
    if (line.startsWith('EAX=')) {
      cur = { regs: new Array(8), seg: new Array(6), segbase: new Array(6), gdt: [0, 0], idt: [0, 0] };
      cur.regs[0] = parseInt(line.substr(4, 8), 16); cur.regs[3] = parseInt(line.substr(17, 8), 16);
      cur.regs[1] = parseInt(line.substr(30, 8), 16); cur.regs[2] = parseInt(line.substr(43, 8), 16);
      return;
    }
    if (cur && line.startsWith('ESI=')) {
      cur.regs[6] = parseInt(line.substr(4, 8), 16); cur.regs[7] = parseInt(line.substr(17, 8), 16);
      cur.regs[5] = parseInt(line.substr(30, 8), 16); cur.regs[4] = parseInt(line.substr(43, 8), 16);
      return;
    }
    if (cur && line.startsWith('EIP=')) {
      cur.eip = parseInt(line.substr(4, 8), 16); cur.efl = parseInt(line.substr(17, 8), 16);
      cur.cpl = +line.substr(line.indexOf('CPL=') + 4, 1);
      cur.hlt = +line.substr(line.indexOf('HLT=') + 4, 1);
      return;
    }
    if (cur && line.startsWith('ES =')) { cur.seg[0] = parseInt(line.substr(4, 4), 16); cur.segbase[0] = parseInt(line.substr(9, 8), 16); return; }
    if (cur && line.startsWith('EFER=')) {
      const r = cur; cur = null;
      if (attach) { attach.state = r; attach = null; return; }   // this dump belongs to an interrupt/exception line
      if (!done) onRecord(r);
      return;
    }
    return;
  }
  if (cur) {
    const k = SEGN[line.substr(0, 3)];
    if (k !== undefined && line[3] === '=') { cur.seg[k] = parseInt(line.substr(4, 4), 16); cur.segbase[k] = parseInt(line.substr(9, 8), 16); return; }
    if (line.startsWith('GDT=')) { cur.gdt = [parseInt(line.substr(9, 8), 16), parseInt(line.substr(18, 8), 16)]; return; }
    if (line.startsWith('IDT=')) { cur.idt = [parseInt(line.substr(9, 8), 16), parseInt(line.substr(18, 8), 16)]; return; }
    if (line.startsWith('CR0=')) {
      cur.cr0 = parseInt(line.substr(4, 8), 16); cur.cr2 = parseInt(line.substr(17, 8), 16);
      cur.cr3 = parseInt(line.substr(30, 8), 16); cur.cr4 = parseInt(line.substr(43, 8), 16);
      return;
    }
    return;
  }
  if (line.startsWith('memory_region_ops_')) {
    const mm = /^memory_region_ops_(read|write) cpu \d+ mr \S+ addr 0x([0-9a-f]+) value 0x([0-9a-f]+) size (\d+)/.exec(line);
    if (mm && started) {
      const addr = parseInt(mm[2], 16);
      if (addr < 65536) events.push({ t: mm[1] === 'read' ? 'in' : 'out', port: addr, size: +mm[4], val: parseInt(mm[3], 16) });
    }
    return;
  }
  if (line.startsWith('Servicing hardware INT=')) { if (started) events.push({ t: 'hw', vec: parseInt(line.slice(23), 16) }); return; }
  if (/^\s*\d+: v=/.test(line)) {
    const mm = /v=([0-9a-f]+) e=([0-9a-f]+) i=(\d) cpl=(\d) IP=[0-9a-f]+:([0-9a-f]+)/.exec(line);
    attach = { t: 'exc', vec: parseInt(mm[1], 16), soft: +mm[3], ip: parseInt(mm[5], 16), state: null, line };
    if (started) events.push(attach);
    return;
  }
}

logStream.on('data', (chunk) => {
  if (done) return;
  const s = carry + chunk.toString('latin1');
  let pos = 0;
  for (;;) {
    const nl = s.indexOf('\n', pos);
    if (nl < 0) break;
    onLine(s.substring(pos, nl));
    if (done) return;
    pos = nl + 1;
  }
  carry = s.substring(pos);
  if (INPUT && !typed && /# $/.test(serialOut)) { typed = true; qemu.stdin.write(INPUT.replace(/\\n/g, '\n')); }
});
logStream.on('end', () => { if (!done) { console.log('[lockstep] qemu log ended'); finish(0); } });
qemu.on('exit', (code) => { if (!done) setTimeout(() => { if (!done) { console.log(`[lockstep] qemu exited (${code})`); finish(0); } }, 500); });
process.on('SIGINT', () => finish(130));
