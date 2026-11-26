'use strict';
// assemble the emulator's SBL source for one target/config and hand back the Program + data
const { Program } = require('../sbl/sbl');
const core = require('./core');
const handlers = require('./handlers');
const decode = require('./decode');
const sys = require('./sys');
const devices = require('./devices');
const unpack = require('./unpack');

// cfg.lazy (the scratch.mit.edu build): nothing big may sit in the project file, so every sizeable list starts
// out empty and alloc() fills it with zeros when the flag is clicked. scratch stops growing a list at 200000
// items, which is what the paged memory model (emu/mem.js) is built around.
const LIST_LIMIT = 200000;
function lazySource(prog) {
  const st = prog.targets.get('Stage');
  const lazy = [...st.lists.values()].filter((l) => l.size >= 256 && !l.values && l.dataKey === undefined);
  const bySize = new Map();
  for (const l of lazy) {
    if (l.size > LIST_LIMIT) throw new Error(`list ${l.name} wants ${l.size} items: scratch stops growing lists at ${LIST_LIMIT}`);
    l.lazy = true;
    if (!bySize.has(l.size)) bySize.set(l.size, []);
    bySize.get(l.size).push(l.name);
  }
  const clears = lazy.map((l) => `clear(${l.name});`).join(' ');
  // (lists that only ever grow by push: the tlb's bookkeeping, the uart queues)
  const logs = [...st.lists.values()].filter((l) => l.size === 0 && !l.values && l.dataKey === undefined).map((l) => `clear(${l.name});`).join(' ');
  return `
// ---------------------------------------------------------------- lists that are built when the project starts
proc alloc() {
  ${clears}
${[...bySize].map(([n, names]) => `  repeat (${n}) { ${names.map((x) => `push(${x}, 0);`).join(' ')} }`).join('\n')}
}
// to save the project again after it has run, the lists have to be empty again (5 MB limit)
proc wipe() {
  ${clears}
  ${logs}
}
on broadcast "click me before saving: empties the big lists" { wipe(); stopall; }
// AND8[a * 256 + b + 1] = a & b, each entry from the one for a >> 1 and b >> 1
var a8 = 0, b8 = 0, i8 = 0;
proc and8_init() {
  a8 = 0; b8 = 1; i8 = 2;
  repeat (65535) {
    AND8[i8] = 2 * AND8[floor(a8 / 2) * 256 + floor(b8 / 2) + 1] + (a8 % 2) * (b8 % 2);
    i8 += 1; b8 += 1;
    if (b8 == 256) { b8 = 0; a8 += 1; }
  }
}
`;
}

const DEFAULTS = {
  target: 'js',            // 'js' | 'sb3'
  ramMB: 16,
  blockSlots: 131072,
  traceSize: 524288,
  maxBlock: 48,
  sliceInsns: 512,
  vtPerInsn: 0.125,        // 1 instruction = 1/8 pit tick: a ~9.5 mips machine as far as linux can tell
  repChunk: 4096,
  profile: false,
  lockstep: false,
  strictOpcodes: true,     // unknown opcodes stop the machine instead of raising #UD
  bootEip: 0x100000,
  bootEsi: 0x10000,
};

function tables() {
  const pow2 = []; for (let i = 0; i <= 32; i++) pow2.push(Math.pow(2, i));
  const and8 = new Array(65536); for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) and8[a * 256 + b] = a & b;
  const parity = []; for (let i = 0; i < 256; i++) { let n = 0; for (let b = 0; b < 8; b++) n += (i >> b) & 1; parity.push(n % 2 === 0 ? 1 : 0); }
  const pfx = new Array(256).fill(0);
  Object.assign(pfx, { 0x26: 10, 0x2e: 11, 0x36: 12, 0x3e: 13, 0x64: 14, 0x65: 15, 0x66: 1, 0x67: 2, 0xf0: 3, 0xf2: 4, 0xf3: 5 });
  return { pow2, and8, parity, pfx };
}

// what the decoder needs to fuse instructions: (handler before, handler now) -> fused handler, where the
// operand fields of the new instruction go, and the weight of its byte offset in tO
function fuseTables(h) {
  const n = h.H.length;
  const fuse = new Array(n * n).fill(0);
  for (const [a, b, g] of h.fuseTable) fuse[(a - 1) * n + (b - 1)] = g;
  const fmap = new Array(n * 6).fill(0), fpow = new Array(n).fill(0), ninsn = [];
  for (const hh of h.H) if (hh.fuse) { hh.fuse.map.forEach((d, k) => { fmap[(hh.id - 1) * 6 + k] = d; }); fpow[hh.id - 1] = hh.fuse.pow; }
  return { n, lists: { fuse, fmap, fpow } };
}

function buildEmu(userCfg, image) {
  const cfg = Object.assign({}, DEFAULTS, userCfg);
  const h = handlers(cfg);
  const ft = fuseTables(h);
  cfg.nhandlers = ft.n;
  // trace lists: zeros, or the blocks decoded at build time (cfg.seed from tools/mkseed.js)
  const seed = cfg.seed || { end: 16, P: 61, lists: { sd_eip: new Array(61).fill(0), sd_tp: [0], sd_nw: [0], sd_w0: [0], sd_words: [0] }, trace: null };
  cfg.seedEnd = seed.end; cfg.seedP = seed.P;
  const traceData = {};
  const hasFuse = !!(cfg.fuse && cfg.fuse.patterns && cfg.fuse.patterns.length);
  if (cfg.lazy && (!cfg.paged || cfg.seed || hasFuse)) throw new Error('cfg.lazy needs the paged memory model, and has no seed and no fusion');
  if (cfg.packed && !(cfg.paged && cfg.pack)) throw new Error('cfg.packed needs the paged memory model and cfg.pack (tools/zpack.js)');
  for (const k of cfg.lazy ? [] : ['tH', 'tA', 'tB', 'tC', 'tD', 'tE', 'tF', 'tI'].concat(hasFuse ? ['tO'] : [])) {
    const a = new Float64Array(cfg.traceSize);
    if (seed.trace) a.set(seed.trace[k], 0);
    traceData[k] = a;
  }
  const units = [
    ['core', core(cfg)],
    ['handlers', h.src],
    ['decode', decode(cfg)],
    ['sys', sys(cfg)],
    ['devices', devices(cfg)],
  ];
  const prog = new Program();
  for (const [name, src] of units) prog.add(src, `emu/${name}`);
  if (cfg.lazy) prog.add(lazySource(prog), 'emu/alloc');
  if (cfg.packed) prog.add(unpack(cfg).stage, 'emu/unpack');
  const data = Object.assign(tables(), { img: image ? image.img : [0], imgdir: image ? image.imgdir : [], hmap: h.hmap, wra: h.wra }, hasFuse ? Object.assign({ isunit: h.isunit }, ft.lists) : {}, traceData, seed.lists);
  if (cfg.packed) {
    const p = cfg.pack;
    Object.assign(data, { ztext: p.text, zfreq: p.freq, zval: p.zv, zdir: p.dir, ztab: p.layout.tables.flatMap((t) => [t.off, t.n]) });
  }
  // tools read handler ids back out of the trace: those are dispatch ids
  const nameOf = (did) => (h.byDid[did] ? h.byDid[did].name : '?');
  const dispatchNames = []; for (const hh of h.H) dispatchNames[hh.did - 1] = hh.name;       // index = trace value - 1
  return { prog, data, cfg, handlers: h.H, byDid: h.byDid, nameOf, dispatchNames, units, nfused: h.H.length - h.ninterp, avgDepth: h.avgDepth, ncold: h.ncold };
}

module.exports = { buildEmu, DEFAULTS, tables };
