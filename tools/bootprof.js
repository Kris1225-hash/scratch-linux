'use strict';
// where do the scratch blocks of a boot go? counts executed blocks per handler on the js build (which mirrors the
// scratch build block for block) and splits them into dispatch (fetch + if-tree + loop) and handler bodies.
//   node tools/bootprof.js
const { makeMachine } = require('./run');
const m = makeMachine({ ramMB: 16, countOps: true, seed: true, cfg: { sliceInsns: 1 } });
const { vars: v, lists: L, procs: P } = m.inst;
const HN = m.built.dispatchNames;
const depth = new Map(m.built.handlers.map((h) => [h.name, h.depth]));
P.reset();
// harness overhead per machine_step at slice 1: measure on a NOP-ish dispatch later; estimate from MOV_RR
const byH = new Map(); let out = '', n = 0, nb0 = v.nblocks, decodeOps = 0, decodes = 0;
while (v.halted < 2) {
  if (v.halted === 1) { P.machine_step(); if (v.halted === 1 && v.irq_out === 0) P.idle_skip(); continue; }
  const name = HN[L.tH[v.tp - 1] - 1];
  const o0 = m.inst.ops();
  P.machine_step(); n++;
  const d = m.inst.ops() - o0;
  if (v.nblocks !== nb0) { decodeOps += d; decodes += v.nblocks - nb0; nb0 = v.nblocks; }
  let e = byH.get(name); if (!e) byH.set(name, e = [0, 0]); e[0]++; e[1] += d;
  if (L.uart_tx.length) { out += Buffer.from(L.uart_tx).toString('latin1'); L.uart_tx.length = 0; if (/# $/.test(out)) break; }
}
// machine_step overhead at slice 1 = MOV_RR total - (dispatch + body 7)
const mr = byH.get('MOV_RR'); const perStep = mr[1] / mr[0] - (5 + 3 * depth.get('MOV_RR')) - 7;
let tot = 0, disp = 0, body = 0;
const rows = [];
for (const [k, [c, o]] of byH) { const dsp = c * (5 + 3 * depth.get(k)); const b = o - c * perStep - dsp; tot += o - c * perStep; disp += dsp; body += b; rows.push([k, c, b / c, b]); }
console.log(`boot: ${n} dispatches, ${(tot / 1e6).toFixed(0)}M blocks (${(tot / n).toFixed(1)}/insn); harness overhead removed ${perStep.toFixed(1)}/step`);
console.log(`dispatch (fetch+tree+loop): ${(100 * disp / tot).toFixed(1)}%   bodies: ${(100 * body / tot).toFixed(1)}%   (of which block decoding ~${(100 * decodeOps / tot).toFixed(1)}%, ${decodes} blocks decoded)`);
const cat = (k) => /^G_/.test(k) ? 'generic lane (G_*)' : /^STR_/.test(k) ? 'string ops' : /^(MOV_RM|MOV_MR|MOV_MI|MOVB_.M|MOVB_M|MOVZX._RM|MOVSX._RM|PUSH|POP|LEAVE|CALL|RET)/.test(k) ? 'memory/stack moves, call, ret' : /^J|^LOOPX/.test(k) ? 'jumps' : /^(ADD|OR|ADC|SBB|AND|SUB|XOR|CMP|TEST|INC|DEC|NEG|CMPB|TESTB|ZERO|TESTSELF|ANDLO|ANDHI|TESTLO|TESTBIT|SHL|SHR|SAR|IMUL)/.test(k) ? 'alu' : /^(MOV_RR|MOV_RI|LEA|MOVZX|MOVSX|MOVB_R|NOT|NOP|CDQ|CWDE)/.test(k) ? 'reg moves / lea' : 'system & other';
const cats = new Map();
for (const [k, c, , b] of rows) { const e = cats.get(cat(k)) || [0, 0, 0]; e[0] += c; e[1] += b; e[2] += c * (5 + 3 * depth.get(k)); cats.set(cat(k), e); }
console.log('category                        insns%   body blocks/insn   body share   +dispatch share');
for (const [k, [c, b, d]] of [...cats].sort((x, y) => y[1][1] - x[1][1])) console.log(`${k.padEnd(30)} ${(100 * c / n).toFixed(1).padStart(6)}%  ${(b / c).toFixed(1).padStart(10)}  ${(100 * b / tot).toFixed(1).padStart(12)}%  ${(100 * (b + d) / tot).toFixed(1).padStart(10)}%`);
console.log('top bodies: ' + rows.sort((x, y) => y[3] - x[3]).slice(0, 22).map(([k, c, per, b]) => `${k} ${(100 * b / tot).toFixed(1)}% (${per.toFixed(0)}/x)`).join(', '));
