'use strict';
// true average scratch blocks per emulated instruction (normal slice size), boot + a few commands
const { makeMachine } = require('./run');
const INPUT = 'uname -a; ls -l /bin | head -3; free; ps | wc -l\necho hello | tr a-z A-Z; seq 1 200 | sort -r | tail -2; md5sum /bin/busybox\n';
const m = makeMachine({ ramMB: +(process.env.RAM || 16), countOps: true });
const { vars: v, lists: L, procs: P } = m.inst;
P.reset();
let out = '', typed = false, bootI = 0, bootO = 0, bootN = 0, idle = 0;
while (v.halted < 2 && v.icount < 14e6) {
  P.machine_step();
  if (v.halted === 1 && v.irq_out === 0) { P.idle_skip(); idle++; }
  if (L.uart_tx.length) { out += Buffer.from(L.uart_tx).toString('latin1'); L.uart_tx.length = 0;
    if (/# $/.test(out)) { if (!bootI) { bootI = v.icount; bootO = m.inst.ops(); bootN = m.inst.ns(); } if (!typed) { typed = true; for (const c of Buffer.from(INPUT.replace(/\\n/g, '\n'))) L.uart_rx.push(c); } } }
}
const o = m.inst.ops();
console.log(`boot: ${(bootI / 1e6).toFixed(2)}M insns, ${(bootO / 1e6).toFixed(0)}M blocks = ${(bootO / bootI).toFixed(1)} blocks/insn (${m.inst.calls()} calls total)`);
const ns = m.inst.ns();
console.log(`predicted stock-scratch speed: boot ${(bootN / bootI).toFixed(0)} ns/insn = ${(1e6 * bootI / bootN).toFixed(0)}k insn/s (boot in ${(bootN / 1e9).toFixed(0)}s), after boot ${((ns - bootN) / (v.icount - bootI)).toFixed(0)} ns/insn = ${(1e6 * (v.icount - bootI) / (ns - bootN)).toFixed(0)}k insn/s`);
console.log(`after boot: ${((o - bootO) / (v.icount - bootI)).toFixed(1)} blocks/insn; overall ${(o / v.icount).toFixed(1)}; blocks decoded ${v.nblocks}, trace ${v.tnext}`);
