'use strict';
// differential test: same SBL program through the JS backend and the real scratch-vm
const { Program } = require('../sbl/sbl');
const { instantiate } = require('../sbl/backend_js');
const { Project, svgCostume, genSb3 } = require('../sbl/backend_sb3');
const { boot } = require('../sbl/vmrun');

const SRC = `
const K = 1 << 12;
const BIG = 0xFFFFFFFF;
var a = 0, b = 7, c, done = 0, acc = 0, fibr = 0, cnt = 0;
list L[16];
list T = [5, 4, 3, 2, 1];
list out[40];
list dyn[0];
list D = data("d");

proc fib(n) {
  if (n < 2) { fibr = n; return; }
  fib(n - 1);
  push(dyn, fibr);
  fib(n - 2);
  fibr = fibr + dyn[len(dyn)];
  del(dyn, len(dyn));
}
proc store(i, v) { out[i] = v; }
proc main() {
  a = (0 - 7) % 5;                 store(1, a);            // floored mod -> 3
  a = 7 % (0 - 5);                 store(2, a);            // -3
  a = floor((0 - 7) / 2);          store(3, a);            // -4
  a = (BIG + 5) % 4294967296;      store(4, a);            // 4
  a = BIG * 65536;                 store(5, a);
  a = (a % 4294967296) / K;        store(6, a);
  b = 0; repeat (10) { b += 3; }   store(7, b);
  b -= 4;                          store(8, b);
  c = 0; while (c < 5) { c += 2; } store(9, c);
  c = 0; until (c >= 5) { c += 2; } store(10, c);
  L[3] = 9; L[3] += 4; L[4] = L[3] * 2; store(11, L[3] + L[4]);
  store(12, T[2] + len(T));
  a = 3;
  if (a == 3) { store(13, 1); } else { store(13, 2); }
  if (a != 3) { store(14, 1); } else { store(14, 2); }
  if (a <= 2) { store(15, 1); } else if (a >= 3 && a < 10) { store(15, 2); } else { store(15, 3); }
  if (!(a > 5 || a == 3)) { store(16, 1); } else { store(16, 2); }
  store(17, (a < 5) + (a > 5) * 10 + (a == 3) * 100);       // booleans as numbers
  acc = (a < 5); store(18, acc + 1);
  fib(12); store(19, fibr);
  store(20, itemf(T, 2.75));                                // scratch floors list indices
  store(21, D[2] + D[3]);
  store(22, floor(7.9) + ceil(7.1) + abs(0 - 3) + round(2.5));
  cnt = 0; repeat (3) { repeat (4) { cnt += 1; } } store(23, cnt);
  store(24, 123456789 * 1000 % 4294967296);
  if (K == 4096) { store(25, 77); } else { store(25, 0); }  // const condition folds away
  clear(dyn); push(dyn, 4); push(dyn, 5); insert(dyn, 1, 9); store(26, dyn[1] * 100 + dyn[2] * 10 + dyn[3]);
  store(27, indexof(T, 3));
  a = 10; a += 0 - 3; a -= 2; store(28, a);
  if (a == 5) { if (b > 0) { store(29, 1); } } 
  store(30, (0 - 1) % 4294967296);
  done = 1;
}
on flag { main(); }
`;

(async () => {
  const data = { d: [10, 20, 30] };
  const prog = new Program().add(SRC, 'basic.sbl');
  for (const strict of [true, false]) {
    const { inst } = instantiate(prog, {}, data, { strict });
    inst.procs.main();
    var jsOut = Array.from(inst.lists.out);
    if (strict) var jsStrict = jsOut; else if (JSON.stringify(jsOut) !== JSON.stringify(jsStrict)) throw new Error('strict/fast js mismatch');
  }
  const proj = new Project();
  proj.stage.costumes.push(svgCostume('bg', '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>', 1, 1));
  const stats = genSb3(prog, proj, { data });
  const sb3 = await proj.toSb3();
  require('fs').writeFileSync('out/sbl_basic.sb3', sb3);
  const m = await boot(sb3);
  m.flag();
  m.run(() => m.getVar('done') == 1, 1000);
  const vmOut = m.getList('out').map(Number);
  let bad = 0;
  for (let i = 0; i < jsOut.length; i++) if (jsOut[i] !== vmOut[i]) { bad++; console.log(`MISMATCH out[${i + 1}]: js=${jsOut[i]} scratch=${vmOut[i]}`); }
  console.log(`blocks=${stats.blocks} sb3=${sb3.length}B  out=${jsOut.slice(0, 30).join(',')}`);
  console.log(bad ? `FAIL (${bad} mismatches)` : 'PASS: js backend and real scratch-vm agree');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
