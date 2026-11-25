#!/usr/bin/env node
'use strict';
// build out/linux.sb3: the emulator compiled to scratch blocks + the kernel image + the terminal sprite
const fs = require('fs');
const path = require('path');
const { buildEmu } = require('../emu/build');
const ui = require('../emu/ui');
const font = require('../emu/font');
const { mkimage } = require('./mkimage');
const { Project, svgCostume, genSb3 } = require('../sbl/backend_sb3');

async function build(opts = {}) {
  const root = path.join(__dirname, '..');
  const cfg0 = Object.assign({ target: 'sb3', ramMB: 16, strictOpcodes: false }, opts.cfg || {});
  const vt = cfg0.vtPerInsn || 0.125;
  const lpj = Math.round(11931.82 / vt / 2);
  const cmdline = opts.cmdline || `console=ttyS0 clocksource=jiffies lpj=${lpj}`;
  const image = mkimage(opts.vmlinux || path.join(root, 'out', 'kernel', 'vmlinux'), { ramMB: cfg0.ramMB, cmdline });
  let weights, fuse;
  try { weights = JSON.parse(fs.readFileSync(path.join(root, 'emu', 'weights.json'), 'utf8')); } catch (e) { /* no profile: the guesses in handlers.js */ }
  // --fuse file: give common instruction sequences handlers of their own (tools/unitprof.js + tools/mkfuse.js).
  // off by default: in the stock scratch vm the extra blocks cost more than the saved dispatches bring (README)
  if (opts.fuse) { fuse = JSON.parse(fs.readFileSync(opts.fuse, 'utf8')); weights = fuse.weights; }
  const cfg1 = Object.assign({ bootEip: image.entry, bootEsi: image.bootParams, weights: opts.noProfile ? undefined : weights, fuse }, cfg0);
  // boot once on the js build and keep the decoder's output: the project starts with its kernel already decoded
  let seedStats = null;
  if (!opts.noSeed) { cfg1.seed = require('./mkseed').makeSeed(cfg1, image); seedStats = cfg1.seed.stats; }
  const built = buildEmu(cfg1, image);
  built.prog.add(ui(built.cfg), 'emu/ui');

  const proj = new Project();
  proj.meta.agent = 'scratch-linux (sbl)';
  proj.stage.costumes.push(svgCostume('screen', `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><rect width="480" height="360" fill="${font.BG}"/></svg>`, 240, 180));
  proj.addSprite('term', { costumes: font.costumes(svgCostume), x: -240, y: 180, currentCostume: 95 });
  const stats = genSb3(built.prog, proj, { data: built.data });
  const sb3 = await proj.toSb3();
  const out = opts.out || path.join(root, 'out', 'linux.sb3');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, sb3);
  return { out, stats, bytes: sb3.length, cmdline, built, proj, seedStats };
}

if (require.main === module) {
  const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
  const ram = +arg('--ram', 16);
  const t0 = Date.now();
  build({ cfg: { ramMB: ram }, noSeed: process.argv.includes('--no-seed'), fuse: arg('--fuse', undefined), out: arg('--out', undefined) }).then((r) => {
    const json = r.proj.projectJsonChunks().reduce((n, c) => n + c.length, 0);
    console.log(`${path.relative(process.cwd(), r.out)}: ${(r.bytes / 1048576).toFixed(2)} MB zipped, project.json ${(json / 1048576).toFixed(1)} MB, ${r.stats.blocks} blocks, ${r.built.handlers.length} handlers (${r.built.nfused} fused sequences), tree depth ${r.built.avgDepth.toFixed(2)}, ${Date.now() - t0} ms`);
    if (r.seedStats) console.log(`seed: ${r.seedStats.blocks} pre-decoded blocks, ${r.seedStats.entries} trace entries, ${r.seedStats.words} memory words to check them against`);
    console.log(`kernel cmdline: ${r.cmdline}`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { build };
