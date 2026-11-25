'use strict';
// does the emulator's SBL source compile (strict js build, no kernel image needed)?
const { buildEmu } = require('../emu/build');
const { genJS } = require('../sbl/backend_js');
const t0 = Date.now();
const { prog, handlers } = buildEmu({ target: 'js' });
const src = genJS(prog, { strict: true });
// the generated source is handy to read when something looks off
const path = require('path');
require('fs').mkdirSync(path.join(__dirname, '..', 'out'), { recursive: true });
require('fs').writeFileSync(path.join(__dirname, '..', 'out', 'emu_strict.js'), src);
const st = prog.targets.get('Stage');
console.log(`ok: ${handlers.length} handlers, ${st.procs.size} procs, ${st.vars.size} vars, ${st.lists.size} lists, js ${(src.length / 1024).toFixed(0)} KB, ${Date.now() - t0} ms`);
