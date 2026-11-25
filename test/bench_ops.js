'use strict';
// what do individual scratch constructs cost in the stock interpreter? (ns per iteration, minus the empty loop)
const { Program } = require('../sbl/sbl');
const { Project, svgCostume, genSb3 } = require('../sbl/backend_sb3');
const { boot } = require('../sbl/vmrun');
const N = 400000;
const cases = {
  empty: ``,
  'set x = y': `x = y;`,
  'x += 1': `x += 1;`,
  'x = L[i]': `x = L[i];`,
  'L[i] = x': `L[i] = x;`,
  'x = (y + 7) % 1000': `x = (y + 7) % 1000;`,
  'x = floor(y / 4096) + z': `x = floor(y / 4096) + z;`,
  'if (y == 3) {} (false)': `if (y == 3) { x = 1; }`,
  'if (y == 5) { x = 1 } (true)': `if (y == 5) { x = 1; }`,
  'if/else true': `if (y == 5) { x = 1; } else { x = 2; }`,
  'if depth 5 + set': `if (y < 100) { if (y < 50) { if (y < 25) { if (y < 12) { if (y < 6) { x = 1; } } } } }`,
  'if/else depth 5 + set': `if (y < 100) { if (y < 50) { if (y < 25) { if (y < 12) { if (y < 6) { x = 1; } else { x = 2; } } else { x = 2; } } else { x = 2; } } else { x = 2; } } else { x = 2; }`,
  '5 flat ifs (all false)': `if (y == 1) { x = 1; } if (y == 2) { x = 1; } if (y == 3) { x = 1; } if (y == 4) { x = 1; } if (y == 6) { x = 1; }`,
  'call p0()': `p0();`,
  'call p2(y, z)': `p2(y, z);`,
  '10 sets': `x = y; x = y; x = y; x = y; x = y; x = y; x = y; x = y; x = y; x = y;`,
  'one big expr (10 ops)': `x = ((y + z) * 3 + (y - z) * 5 + y * z) % 977 + 1;`,
  'repeat (4) { x += 1 }': `repeat (4) { x += 1; }`,
  'until loop x4': `i2 = 0; until (i2 == 4) { i2 += 1; }`,
};
let src = `var x = 0, y = 5, z = 9, i = 3, i2 = 0, done = 0;\nlist L[100];\nproc p0() { x = 1; }\nproc p2(a, b) { x = a; }\n`;
const names = Object.keys(cases);
names.forEach((n, k) => { src += `proc b${k}() { repeat (${N}) { ${cases[n]} } }\n`; });
src += `var which = 0;\nproc go(k) {\n${names.map((n, k) => `  if (k == ${k}) { b${k}(); }`).join('\n')}\n}\non broadcast "go" { go(which); done = 1; }\n`;
(async () => {
  const prog = new Program().add(src, 'bench.sbl');
  const proj = new Project();
  proj.stage.costumes.push(svgCostume('bg', '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>', 1, 1));
  genSb3(prog, proj, {});
  const m = await boot(await proj.toSb3());
  const res = [];
  for (let rep = 0; rep < 2; rep++) for (let k = 0; k < names.length; k++) {
    m.setVar('which', k); m.setVar('done', 0);
    const t0 = process.hrtime.bigint();
    m.vm.runtime.startHats('event_whenbroadcastreceived', { BROADCAST_OPTION: 'go' });
    m.run(() => m.getVar('done') == 1, 100000);
    const ns = Number(process.hrtime.bigint() - t0) / N;
    res[k] = Math.min(res[k] || Infinity, ns);
  }
  for (let k = 0; k < names.length; k++) console.log(`${names[k].padEnd(30)} ${(res[k] - (k ? res[0] : 0)).toFixed(0).padStart(6)} ns${k ? '' : ' (loop overhead)'}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
