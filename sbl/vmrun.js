'use strict';
// run an .sb3 buffer in the real (vanilla) scratch-vm, headless
const path = require('path');
const fs = require('fs');

function loadVM() {
  // the published node bundle expects jsdom's stylesheet next to itself; make sure it is there
  const nm = path.join(__dirname, '..', 'node_modules');
  const vmDir = path.join(nm, '@scratch', 'scratch-vm');
  const css = path.join(vmDir, 'browser', 'default-stylesheet.css');
  if (!fs.existsSync(css)) {
    fs.mkdirSync(path.dirname(css), { recursive: true });
    fs.copyFileSync(path.join(nm, 'jsdom', 'lib', 'jsdom', 'browser', 'default-stylesheet.css'), css);
  }
  return require('@scratch/scratch-vm');
}

async function boot(sb3, opts = {}) {
  const VM = loadVM();
  const vm = new VM();
  await vm.loadProject(sb3);
  vm.runtime.currentStepTime = 1000 / 30;
  const stage = vm.runtime.getTargetForStage();
  const byName = (target, name, type) => {
    for (const v of Object.values(target.variables)) if (v.name === name && (type === 'list') === (v.type === 'list')) return v;
    return null;
  };
  const api = {
    vm, stage,
    target: (n) => n === 'Stage' ? stage : vm.runtime.targets.find((t) => t.sprite && t.sprite.name === n),
    getVar: (n, t) => { const v = byName(t || stage, n, 'var'); if (!v) throw new Error('no var ' + n); return v.value; },
    setVar: (n, x, t) => { byName(t || stage, n, 'var').value = x; },
    getList: (n, t) => { const v = byName(t || stage, n, 'list'); if (!v) throw new Error('no list ' + n); return v.value; },
    flag: () => vm.greenFlag(),
    step: () => vm.runtime._step(),
    threads: () => vm.runtime.threads.length,
    // step until predicate or no live threads; returns number of steps
    run: (pred, maxSteps = 1e9) => {
      let n = 0;
      while (n < maxSteps) {
        vm.runtime._step(); n++;
        if (pred && pred()) break;
        if (!pred && vm.runtime.threads.length === 0) break;
      }
      return n;
    },
  };
  return api;
}

module.exports = { boot, loadVM };
