// micro-benchmark: how fast is the vanilla scratch-vm interpreter per block?
const VM = require('@scratch/scratch-vm');
const JSZip = require('jszip');

function project(N) {
  const b = {};
  let n = 0; const id = () => 'b' + (n++);
  const num = v => [1, [4, String(v)]];
  // proc def
  const def = id(), proto = id(), rep = id(), set = id(), mod = id(), add = id(), set2 = id(), item = id(), add2 = id(), rpl = id();
  b[def] = { opcode: 'procedures_definition', next: rep, parent: null, inputs: { custom_block: [1, proto] }, fields: {}, shadow: false, topLevel: true, x: 0, y: 0 };
  b[proto] = { opcode: 'procedures_prototype', next: null, parent: def, inputs: {}, fields: {}, shadow: true, topLevel: false,
    mutation: { tagName: 'mutation', children: [], proccode: 'bench', argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]', warp: 'true' } };
  b[rep] = { opcode: 'control_repeat', next: null, parent: def, inputs: { TIMES: [1, [6, String(N)]], SUBSTACK: [2, set] }, fields: {}, shadow: false, topLevel: false };
  // set x to ((x + 7) mod 1000)
  b[set] = { opcode: 'data_setvariableto', next: set2, parent: rep, inputs: { VALUE: [3, mod, [10, '']] }, fields: { VARIABLE: ['x', 'vx'] }, shadow: false, topLevel: false };
  b[mod] = { opcode: 'operator_mod', next: null, parent: set, inputs: { NUM1: [3, add, [4, '']], NUM2: num(1000) }, fields: {}, shadow: false, topLevel: false };
  b[add] = { opcode: 'operator_add', next: null, parent: mod, inputs: { NUM1: [3, [12, 'x', 'vx'], [4, '']], NUM2: num(7) }, fields: {}, shadow: false, topLevel: false };
  // set y to item (x+1) of L
  b[set2] = { opcode: 'data_setvariableto', next: rpl, parent: set, inputs: { VALUE: [3, item, [10, '']] }, fields: { VARIABLE: ['y', 'vy'] }, shadow: false, topLevel: false };
  b[item] = { opcode: 'data_itemoflist', next: null, parent: set2, inputs: { INDEX: [3, add2, [7, '']] }, fields: { LIST: ['L', 'lL'] }, shadow: false, topLevel: false };
  b[add2] = { opcode: 'operator_add', next: null, parent: item, inputs: { NUM1: [3, [12, 'x', 'vx'], [4, '']], NUM2: num(1) }, fields: {}, shadow: false, topLevel: false };
  // replace item 1 of L with y
  b[rpl] = { opcode: 'data_replaceitemoflist', next: null, parent: set2, inputs: { INDEX: [1, [7, '1']], ITEM: [3, [12, 'y', 'vy'], [10, '']] }, fields: { LIST: ['L', 'lL'] }, shadow: false, topLevel: false };
  // flag -> call -> set done
  const hat = id(), call = id(), done = id();
  b[hat] = { opcode: 'event_whenflagclicked', next: call, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 300, y: 0 };
  b[call] = { opcode: 'procedures_call', next: done, parent: hat, inputs: {}, fields: {}, shadow: false, topLevel: false,
    mutation: { tagName: 'mutation', children: [], proccode: 'bench', argumentids: '[]', warp: 'true' } };
  b[done] = { opcode: 'data_setvariableto', next: null, parent: call, inputs: { VALUE: [1, [10, '1']] }, fields: { VARIABLE: ['done', 'vd'] }, shadow: false, topLevel: false };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>';
  const md5 = require('crypto').createHash('md5').update(svg).digest('hex');
  return { json: {
    targets: [{ isStage: true, name: 'Stage', variables: { vx: ['x', 0], vy: ['y', 0], vd: ['done', 0] }, lists: { lL: ['L', Array.from({length: 1000}, (_, i) => i)] }, broadcasts: {}, blocks: b, comments: {}, currentCostume: 0,
      costumes: [{ name: 'bg', dataFormat: 'svg', assetId: md5, md5ext: md5 + '.svg', rotationCenterX: 1, rotationCenterY: 1 }], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null }],
    monitors: [], extensions: [], meta: { semver: '3.0.0', vm: '0.2.0', agent: 'sbl' } }, assets: { [md5 + '.svg']: svg } };
}

(async () => {
  const N = 2000000;
  const { json, assets } = project(N);
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(json));
  for (const [k, v] of Object.entries(assets)) zip.file(k, v);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const vm = new VM();
  await vm.loadProject(buf);
  const stage = vm.runtime.getTargetForStage();
  vm.runtime.currentStepTime = 1000 / 30; vm.greenFlag();
  const t0 = process.hrtime.bigint();
  let steps = 0;
  while (stage.lookupVariableById('vd').value != 1) { vm.runtime._step(); steps++; if (steps > 100000) throw new Error('stuck'); }
  const dt = Number(process.hrtime.bigint() - t0) / 1e9;
  // per iteration: repeat(1) + set,mod,add,var(4) + set,item,add,var(4) + replace,var(2) = 11 ops
  const ops = N * 11;
  console.log(`iterations=${N} steps=${steps} time=${dt.toFixed(3)}s  ->  ${(ops / dt / 1e6).toFixed(2)}M ops/s, ${(dt / ops * 1e9).toFixed(1)} ns/op, x=${stage.lookupVariableById('vx').value}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
