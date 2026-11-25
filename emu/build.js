'use strict';
// assemble the emulator's SBL source for one target/config and hand back the Program + data
const { Program } = require('../sbl/sbl');
const core = require('./core');
const handlers = require('./handlers');
const decode = require('./decode');
const sys = require('./sys');
const devices = require('./devices');

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
  for (const k of ['tH', 'tA', 'tB', 'tC', 'tD', 'tE', 'tF', 'tI'].concat(hasFuse ? ['tO'] : [])) {
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
  const data = Object.assign(tables(), { img: image ? image.img : [0], imgdir: image ? image.imgdir : [], hmap: h.hmap, wra: h.wra }, hasFuse ? Object.assign({ isunit: h.isunit }, ft.lists) : {}, traceData, seed.lists);
  // tools read handler ids back out of the trace: those are dispatch ids
  const nameOf = (did) => (h.byDid[did] ? h.byDid[did].name : '?');
  const dispatchNames = []; for (const hh of h.H) dispatchNames[hh.did - 1] = hh.name;       // index = trace value - 1
  return { prog, data, cfg, handlers: h.H, byDid: h.byDid, nameOf, dispatchNames, units, nfused: h.H.length - h.ninterp, avgDepth: h.avgDepth };
}

module.exports = { buildEmu, DEFAULTS, tables };
