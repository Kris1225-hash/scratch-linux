'use strict';
// does the stock interpreter slow down when the same work is spread over more distinct blocks?
// K copies of one handler-like body behind a binary if-tree, picked round robin: ns per body for growing K.
const { Program } = require('../sbl/sbl');
const { Project, svgCostume, genSb3 } = require('../sbl/backend_sb3');
const { boot } = require('../sbl/vmrun');
const N = 300000;
const body = `ea = (reg[tB[tp]] + tE[tp]) % 4294967296; if (ea % 4 == 0) { q = tl[floor(ea / 4096) + 1]; if (q == 0) { x = 1; } reg[tA[tp]] = memw[q + ea / 4]; } else { x = 2; } tp += 1;`;
const tree = (lo, hi) => (hi - lo === 1 ? body : `if (h < ${(lo + hi) >> 1}) { ${tree(lo, (lo + hi) >> 1)} } else { ${tree((lo + hi) >> 1, hi)} }`);
const KS = [1, 4, 16, 64, 256, 1024, 4096];
let src = `var x = 0, ea = 0, q = 0, tp = 1, h = 0, k = 0, done = 0, which = 0;\nlist reg[16]; list tA[64]; list tB[64]; list tE[64]; list tl[1100000]; list memw[70000];\n`;
KS.forEach((K, i) => {
  // same tree depth for every K (pad the tree to 4096 leaves' depth by nesting dummy levels) would hide the effect we
  // want to separate, so report depth too: the body cost is what is left after subtracting the K=1 tree of equal depth
  src += `proc b${i}() { tp = 1; k = 0; repeat (${N}) { h = k % ${K}; k += 1; tp = 1 + k % 32; ${tree(0, K)} } }\n`;
});
// control: one body, but a tree of the same depth as K (all leaves except one are trivial)
const fake = (lo, hi) => (hi - lo === 1 ? (lo === 0 ? body : 'x = 3;') : `if (h < ${(lo + hi) >> 1}) { ${fake(lo, (lo + hi) >> 1)} } else { ${fake((lo + hi) >> 1, hi)} }`);
KS.forEach((K, i) => { src += `proc c${i}() { tp = 1; k = 0; repeat (${N}) { h = 0; k += 1; tp = 1 + k % 32; ${fake(0, Math.min(K, 4096))} } }\n`; });
src += `proc go(w) {\n${KS.map((K, i) => `  if (w == ${i}) { b${i}(); }\n  if (w == ${100 + i}) { c${i}(); }`).join('\n')}\n}\non broadcast "go" { go(which); done = 1; }\n`;
(async () => {
  const prog = new Program().add(src, 'bench.sbl');
  const proj = new Project();
  proj.stage.costumes.push(svgCostume('bg', '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>', 1, 1));
  const st = genSb3(prog, proj, {});
  const m = await boot(await proj.toSb3());
  // registers / trace fields with plausible values
  const reg = m.getList('reg'), tA = m.getList('tA'), tB = m.getList('tB'), tE = m.getList('tE'), tl = m.getList('tl');
  for (let i = 0; i < 16; i++) reg[i] = 4096 * 3 + 64 * i;
  for (let i = 0; i < 64; i++) { tA[i] = 1 + i % 8; tB[i] = 1 + (i * 5) % 8; tE[i] = 4 * (i % 50); }
  for (let i = 0; i < tl.length; i++) tl[i] = 1;
  console.log(`${st.blocks} blocks in the project`);
  const time = (w) => {
    let best = Infinity;
    for (let rep = 0; rep < 3; rep++) {
      m.setVar('which', w); m.setVar('done', 0);
      const t0 = process.hrtime.bigint();
      m.vm.runtime.startHats('event_whenbroadcastreceived', { BROADCAST_OPTION: 'go' });
      m.run(() => m.getVar('done') == 1, 100000);
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / N);
    }
    return best;
  };
  for (let i = 0; i < KS.length; i++) {
    const t = time(i), c = time(100 + i);
    console.log(`K=${String(KS[i]).padStart(4)} distinct bodies (tree depth ${Math.log2(KS[i])}): ${t.toFixed(0)} ns/iteration   |   1 body behind the same tree: ${c.toFixed(0)} ns   |   spread penalty ${(t - c).toFixed(0)} ns`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
