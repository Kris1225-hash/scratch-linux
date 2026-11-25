'use strict';
// choose the instruction sequences that get fused handlers. input: the profile from tools/unitprof.js.
// output: out/fuse.json = { patterns: [{ seq: [handler names], w }], weights: { handler: dispatches left } }
//   node tools/mkfuse.js [--patterns 200] [--maxlen 4] [--bootw 3]
//
// the decoder fuses greedily from the left: the entry before + the instruction just decoded -> fused handler, if
// that pair exists. so the patterns are grown the same way (like byte pair encoding): keep adding the pair
// (sequence so far, next instruction) that removes the most dispatches under that greedy parse.
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };

const JCC = new Set(['JO', 'JNO', 'JB', 'JAE', 'JZ', 'JNZ', 'JBE', 'JA', 'JS', 'JNS', 'JP', 'JNP', 'JL', 'JGE', 'JLE', 'JG']);
const TERM = new Set(['JMP', 'CALL', 'RET', 'RET_I', 'JMP_R', 'JMP_M_B', 'JMP_M_X', 'CALL_R', 'CALL_M_B', 'CALL_M_X']);
// instructions whose handler body is plain "do it, tp += 1" with every fault going through a marked slow path
const SIMPLE = new RegExp('^(' + [
  'MOV_(RR|RI|RM_[BX]|MR_[BX]|MI_[BX])', 'MOVB_(RR|RI|RM_[BX]|MR_[BX]|MI_[BX])', 'MOV[ZS]X[BW]_(RR|RM_[BX])', 'LEA_[BX]',
  'PUSH_(R|I|M_[BX])', 'POP_R', 'LEAVE', 'ADDSP_I', 'SUBSP_I', 'MOV_RM_SP', 'MOV_MR_SP', '(ADD|OR|ADC|SBB|AND|SUB|XOR|CMP)_(RR|RI|RM_[BX]|MR_[BX]|MI_[BX])', 'TEST_(RR|RI|MR_[BX]|MI_[BX])',
  'ZERO_R', 'TESTSELF_R', 'ANDLO_RI', 'ANDHI_RI', 'TESTLO_RI', 'TESTBIT_RI', 'TESTBIT_MI_[BX]', 'CMPB_(RI|RR|MI_[BX]|RM_[BX]|MR_[BX])', 'TESTB_(RR|RI|MI_[BX])',
  'INC_R', 'DEC_R', 'INC_M_[BX]', 'DEC_M_[BX]', 'NEG_R', 'NOT_R', 'SHL_RI', 'SHR_RI', 'SAR_RI', 'IMUL_(RR|RRI|RM_[BX])',
  'MOVW_(RM|MR|MI)_[BX]', 'XCHG_AR', 'SHL_RC', 'SHR_RC', 'BT_RI', 'BTS_RI', 'BTR_RI', 'ANDB_RI',
  'CLC', 'STC', 'CMC', 'CLD', 'STD', 'CWDE', 'CBW', 'CDQ', 'CWD', 'BSWAP', 'NOP',
].join('|') + ')$');

function select(profile, o = {}) {
  const NPAT = o.patterns !== undefined ? o.patterns : 200, MAXLEN = o.maxlen || 4, bootw = o.bootw !== undefined ? o.bootw : 3;
  const handlers = require('../emu/handlers')({});
  const nf = new Map();
  for (const h of handlers.H) nf.set(h.name, ['A', 'B', 'C', 'D', 'E', 'F'].filter((f) => h.body.includes(`t${f}[tp]`)).length);
  const wOf = (e) => e.cb * bootw + (e.c - e.cb);
  // runs of fusable instructions, merged by their handler sequence
  const runMap = new Map(); const weights = {}; let total = 0;
  let cur = null, curW = 0, prev = null;
  const flush = () => { if (cur && cur.length) { const k = cur.join(' '); runMap.set(k, (runMap.get(k) || 0) + curW); } cur = null; };
  for (const e of profile.ent) {
    const w = wOf(e); total += w;
    if (prev && e.i !== prev.i + 1) flush();
    const lowered = (prev && prev.i === e.i - 1 && prev.eip === e.eip) || !e.len;
    const ok = !lowered && (SIMPLE.test(e.name) || JCC.has(e.name) || TERM.has(e.name));
    if (!ok) { flush(); weights[e.name] = (weights[e.name] || 0) + w; }
    else {
      // every instruction of a run runs as often as its first one, except after a fault: close enough, but a run
      // is cut where the counts disagree badly (a jump into the middle of a block)
      if (cur && Math.abs(w - curW) > 0.05 * Math.max(w, curW)) flush();
      if (!cur) { cur = []; curW = w; }
      cur.push(e.name);
      if (JCC.has(e.name) || TERM.has(e.name)) flush();
    }
    prev = e;
  }
  flush();
  const runs = [...runMap].map(([k, w]) => ({ seq: k.split(' '), w })).filter((r) => r.w > 0);
  const pats = new Map();                       // "A+B" -> { seq, fields }
  const fieldsOf = (name) => (pats.has(name) ? pats.get(name).fields : nf.get(name));
  // greedy left-to-right parse of one run -> token names
  const parse = (seq) => {
    const out = []; let tok = null;
    for (const name of seq) {
      if (tok !== null) { const k = tok + '+' + name; if (pats.has(k)) { tok = k; continue; } out.push(tok); }
      tok = name;
    }
    if (tok !== null) out.push(tok);
    return out;
  };
  const cost = () => { let c = 0; for (const r of runs) c += r.w * parse(r.seq).length; return c; };
  let dispatches = cost();
  const base = dispatches;
  const rejected = new Set();
  while (pats.size < NPAT) {
    // count (token, next instruction) over the current parse
    const cand = new Map();
    for (const r of runs) {
      const toks = parse(r.seq);
      let pos = 0;
      for (let t = 0; t < toks.length - 1; t++) {
        const a = toks[t]; const len = a.split('+').length; pos += len;
        const b = r.seq[pos];
        const last = a.split('+').pop();
        if (!SIMPLE.test(last) || len >= MAXLEN) continue;
        const k = a + '+' + b;
        if (rejected.has(k) || fieldsOf(a) + nf.get(b) > 6) continue;
        cand.set(k, (cand.get(k) || 0) + r.w);
      }
    }
    if (!cand.size) break;
    const best = [...cand].sort((x, y) => y[1] - x[1]).slice(0, 3);
    let took = false;
    for (const [k] of best) {
      const seq = k.split('+');
      pats.set(k, { seq, fields: fieldsOf(seq.slice(0, -1).join('+')) + nf.get(seq[seq.length - 1]) });
      const c = cost();
      if (c < dispatches) { dispatches = c; took = true; break; }
      pats.delete(k); rejected.add(k);
    }
    if (!took && best.length === 0) break;
  }
  // final dispatch counts per handler
  const pw = new Map();
  for (const r of runs) for (const t of parse(r.seq)) { if (pats.has(t)) pw.set(t, (pw.get(t) || 0) + r.w); else weights[t] = (weights[t] || 0) + r.w; }
  const patterns = [...pats.values()].map((p) => ({ seq: p.seq, w: pw.get(p.seq.join('+')) || 0 }));
  const inRuns = runs.reduce((s, r) => s + r.w * r.seq.length, 0);
  return { patterns, weights, stats: { patterns: patterns.length, total, inRuns, before: total, after: total - base + dispatches } };
}

module.exports = { select, SIMPLE, JCC, TERM };
if (require.main === module) {
  const IN = opt('--in', path.join(__dirname, '..', 'out', 'units.json'));
  const OUT = opt('--out', path.join(__dirname, '..', 'out', 'fuse.json'));
  const profile = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const r = select(profile, { patterns: +opt('--patterns', 200), maxlen: +opt('--maxlen', 4), bootw: +opt('--bootw', 3) });
  fs.writeFileSync(OUT, JSON.stringify({ patterns: r.patterns, weights: r.weights }));
  const s = r.stats;
  console.log(`${s.patterns} fused sequences: dispatches per instruction ${(s.after / s.before).toFixed(3)} (${(100 * s.inRuns / s.total).toFixed(1)}% of instructions are fusable at all) -> ${OUT}`);
  console.log('top: ' + r.patterns.slice().sort((a, b) => b.w - a.w).slice(0, 14).map((p) => `${p.seq.join('+')} ${(100 * p.w / s.after).toFixed(1)}%`).join(', '));
}
