'use strict';
// i486SX core, part 2: the instruction handlers and the dispatch loop.
//
// Decoded instructions live in the trace lists: tH[tp] = handler id, tA..tF[tp] = operands, tI[tp] = eip.
// A handler is the body of one leaf of the dispatch tree in run(). Conventions:
//   - a handler advances tp itself (tp += 1) or jumps (sets tp to another trace entry)
//   - anything that can fault happens before architectural state is changed; on a fault the slow-path proc
//     has already delivered the exception (tp -> handler) and set flt, and the handler just returns
//   - operand fields: tA = reg operand (index into reg[]), tB/tC/tD/tE = base / index / scale / disp of a
//     memory operand ("_B" handlers ignore index and scale), tF = immediate
//
// "G_" handlers are the generic slow lane: operand size in tD, r/m operand is a register when tC > 0
// (tC = register code + 1) and otherwise memory at reg[tB] + tE (the decoder lowers fancier addressing
// through LEA_TMP first).

module.exports = function handlers(cfg) {
  const H = [];
  const byName = new Map();
  const def = (name, w, body) => {
    if (byName.has(name)) throw new Error('duplicate handler ' + name);
    const h = { name, w, body, id: H.length + 1 };
    H.push(h); byName.set(name, h);
    return h;
  };
  const A = 'tA[tp]', B = 'tB[tp]', C = 'tC[tp]', D = 'tD[tp]', E = 'tE[tp]', F = 'tF[tp]';
  const RA = `reg[${A}]`, RB = `reg[${B}]`;
  const NEXT = 'tp += 1;';
  const FAULT = 'if (flt == 1) { return; }';
  // effective address variants
  const EAS = [['_B', `ea = (reg[${B}] + ${E}) % 4294967296;`], ['_X', `ea = (reg[${B}] + reg[${C}] * ${D} + ${E}) % 4294967296;`]];
  const EA_B = EAS[0][1];
  const forEA = (fn) => { for (const [suf, eaCode] of EAS) fn(suf, eaCode); };

  // ---- inline memory fast paths (operate on linear address in `ea`)
  // @P@ marks the spots where a slow path (which may raise a fault) is entered: compiled units record which of
  // their instructions is running there, the plain interpreter drops the marker
  const TLBR = `q = itemf(tlbR, ea / 4096 + tlbOff); if (q == 0) { @P@ tlb_fill(ea, 0); ${FAULT} }`;
  const TLBW = `q = itemf(tlbW, ea / 4096 + tlbOff); if (q == 0) { @P@ tlb_fill(ea, 1); ${FAULT} }`;
  const RD32 = (dst) => `if (ea % 4 == 0) { ${TLBR} ${dst} = memw[q + ea / 4]; } else { @P@ rd32u(ea); ${FAULT} ${dst} = rv; }`;
  const WR32 = (val) => `if (ea % 4 == 0) { ${TLBW} memw[q + ea / 4] = ${val}; } else { @P@ wr32u(ea, ${val}); ${FAULT} }`;
  const TLBRW = `q = itemf(tlbW, ea / 4096 + tlbOff); if (q == 0) { @P@ rwchk(ea); ${FAULT} }`;
  const RMW32 = (dst) => `if (ea % 4 == 0) { ${TLBRW} mi = q + ea / 4; ${dst} = memw[mi]; } else { @P@ rmw32u(ea); ${FAULT} ${dst} = rv; mi = 0; }`;
  const RMW32_END = (val) => `if (mi == 0) { wr32u(ea, ${val}); } else { memw[mi] = ${val}; }`;
  const RD8 = (dst) => `${TLBR} ${dst} = floor(itemf(memw, q + ea / 4) / POW256[ea % 4 + 1]) % 256;`;
  const RMW8 = (dst) => `${TLBRW} mi = q + floor(ea / 4); sh = POW256[ea % 4 + 1]; mw = memw[mi]; ${dst} = floor(mw / sh) % 256;`;
  const RMW8_END = (old, val) => `memw[mi] = mw + (${val} - ${old}) * sh;`;
  const WR8 = (val) => `${TLBW} mi = q + floor(ea / 4); sh = POW256[ea % 4 + 1]; mw = memw[mi]; memw[mi] = mw + (${val} - floor(mw / sh) % 256) * sh;`;
  const WR16 = (val) => `if (ea % 4 == 3) { @P@ wr16(ea, ${val}); ${FAULT} } else { ${TLBW} mi = q + floor(ea / 4); sh = POW256[ea % 4 + 1]; mw = memw[mi]; memw[mi] = mw + (${val} - floor(mw / sh) % 65536) * sh; }`;
  const RD16 = (dst) => `if (ea % 4 == 3) { @P@ rd16(ea); ${FAULT} ${dst} = rv; } else { ${TLBR} ${dst} = floor(itemf(memw, q + ea / 4) / POW256[ea % 4 + 1]) % 65536; }`;
  // ---- the stack window. spw is the memw index of the word esp points at, kept up to date by push / pop / call /
  // ret and friends so that they need no address translation at all. it is only trusted while esp sits strictly
  // inside a page it can write (word offset 1..1022: "spw % 1024 < 2" is false); 1 means "unknown". everything
  // that could make it stale (other writes to esp, tlb flushes, privilege changes) resets it to 1 or calls
  // sp_sync(), which works it out again from the write tlb.
  const SPSLOW = `spw % 1024 < 2`;
  const PUSH32 = (val) => `if (${SPSLOW}) { sp = (reg[5] - 4) % 4294967296; ea = sp; ${WR32(val)} reg[5] = sp; sp_sync(); } else { spw -= 1; memw[spw] = ${val}; reg[5] = reg[5] - 4; }`;
  // pop into a variable or register (never esp itself: the decoder sends "pop esp" down the generic lane)
  const POP32 = (dst) => `if (${SPSLOW}) { sp = reg[5]; ea = sp; ${RD32('t0')} reg[5] = (sp + 4) % 4294967296; ${dst} = t0; sp_sync(); } else { ${dst} = memw[spw]; spw += 1; reg[5] = reg[5] + 4; }`;

  // 32-bit and through the byte table: bw = x & y   (x, y: variable names)
  const AND32 = (x, y) => `bw = AND8[(${x} % 256) * 256 + ${y} % 256 + 1] + AND8[(floor(${x} / 256) % 256) * 256 + floor(${y} / 256) % 256 + 1] * 256 + AND8[(floor(${x} / 65536) % 256) * 256 + floor(${y} / 65536) % 256 + 1] * 65536 + AND8[floor(${x} / 16777216) * 256 + floor(${y} / 16777216) + 1] * 16777216;`;

  // ---- control transfer
  // statically known target in tF; tA/tB cache the target's trace index and the epoch it was valid in
  const JUMP_STATIC = `if (${B} == epoch) { tp = ${A}; } else { stp = tp; eip = tF[tp]; find_block(); if (chain_ok == 1) { tA[stp] = tp; tB[stp] = epoch; } }`;
  // computed target in eip (ret, jmp reg ...): a small cache straight from eip to the trace, one half per
  // privilege level, entries tagged with the mapping epoch so that nothing stale can ever match
  const JUMP_DYN = `jc = eip % 4096 + jcOff; if (jcKey[jc] == eip + ebase) { tp = jcTp[jc]; } else { find_block(); if (chain_ok == 1) { jcKey[jc] = eip + ebase; jcTp[jc] = tp; } }`;

  // ================================================================ pseudo ops
  def('STOP', 0, `return;`);
  def('END', 30, JUMP_STATIC);                       // fall off the end of a block
  def('LEA_TMP', 3, `reg[16] = (reg[${B}] + reg[${C}] * ${D} + ${E} + reg[${A}]) % 4294967296; ${NEXT}`);
  def('LEA16_TMP', 0, `reg[16] = ((reg[${B}] + reg[${C}] + ${E}) % 65536 + reg[${A}]) % 4294967296; ${NEXT}`);
  def('NOP', 8, NEXT);
  // a lock prefix makes the cpu take its operand for writing up front (no separate read access first)
  def('LOCK_PROBE', 0.3, `wchk((reg[${B}] + reg[${C}] * ${D} + ${E}) % 4294967296); ${FAULT} ${NEXT}`);
  def('UD', 0, `exc(6, 0, 0); return;`);
  def('UNIMPL', 0, `fatal(20, ${F}); return;`);

  // ================================================================ mov
  def('MOV_RR', 60, `${RA} = ${RB}; ${NEXT}`);
  def('MOV_RI', 40, `${RA} = ${F}; ${NEXT}`);
  forEA((s, ea) => def('MOV_RM' + s, s === '_B' ? 120 : 15, `${ea} ${RD32(RA)} ${NEXT}`));
  forEA((s, ea) => def('MOV_MR' + s, s === '_B' ? 90 : 8, `${ea} ${WR32(RA)} ${NEXT}`));
  forEA((s, ea) => def('MOV_MI' + s, s === '_B' ? 25 : 2, `${ea} ${WR32(F)} ${NEXT}`));
  // 8-bit, low-byte registers only (ah..bh go through G_MOV_*)
  def('MOVB_RR', 3, `${RA} = ${RA} - ${RA} % 256 + ${RB} % 256; ${NEXT}`);
  def('MOVB_RI', 6, `${RA} = ${RA} - ${RA} % 256 + ${F}; ${NEXT}`);
  forEA((s, ea) => def('MOVB_RM' + s, s === '_B' ? 8 : 3, `${ea} ${RD8('t0')} ${RA} = ${RA} - ${RA} % 256 + t0; ${NEXT}`));
  forEA((s, ea) => def('MOVB_MR' + s, s === '_B' ? 10 : 3, `${ea} ${WR8(`${RA} % 256`)} ${NEXT}`));
  forEA((s, ea) => def('MOVB_MI' + s, s === '_B' ? 8 : 1, `${ea} ${WR8(F)} ${NEXT}`));
  // zero / sign extension into a 32-bit register
  def('MOVZXB_RR', 8, `${RA} = ${RB} % 256; ${NEXT}`);
  forEA((s, ea) => def('MOVZXB_RM' + s, s === '_B' ? 20 : 8, `${ea} ${RD8(RA)} ${NEXT}`));
  def('MOVZXW_RR', 3, `${RA} = ${RB} % 65536; ${NEXT}`);
  forEA((s, ea) => def('MOVZXW_RM' + s, s === '_B' ? 8 : 2, `${ea} ${RD16(RA)} ${NEXT}`));
  def('MOVSXB_RR', 3, `t0 = ${RB} % 256; ${RA} = t0 + (t0 > 127) * 4294967040; ${NEXT}`);
  forEA((s, ea) => def('MOVSXB_RM' + s, s === '_B' ? 5 : 2, `${ea} ${RD8('t0')} ${RA} = t0 + (t0 > 127) * 4294967040; ${NEXT}`));
  def('MOVSXW_RR', 2, `t0 = ${RB} % 65536; ${RA} = t0 + (t0 > 32767) * 4294901760; ${NEXT}`);
  forEA((s, ea) => def('MOVSXW_RM' + s, s === '_B' ? 3 : 1, `${ea} ${RD16('t0')} ${RA} = t0 + (t0 > 32767) * 4294901760; ${NEXT}`));
  // 16-bit moves to and from memory
  forEA((s, ea) => def('MOVW_RM' + s, s === '_B' ? 2 : 0.5, `${ea} ${RD16('t0')} ${RA} = ${RA} - ${RA} % 65536 + t0; ${NEXT}`));
  forEA((s, ea) => def('MOVW_MR' + s, s === '_B' ? 6 : 0.5, `${ea} ${WR16(`${RA} % 65536`)} ${NEXT}`));
  forEA((s, ea) => def('MOVW_MI' + s, s === '_B' ? 2 : 0.5, `${ea} ${WR16(F)} ${NEXT}`));
  def('XCHG_AR', 1, `t0 = reg[1]; reg[1] = ${RA}; ${RA} = t0; ${NEXT}`);                 // xchg eax, r32
  def('LEA_B', 35, `${RA} = (reg[${B}] + ${E}) % 4294967296; ${NEXT}`);
  def('LEA_X', 20, `${RA} = (reg[${B}] + reg[${C}] * ${D} + ${E}) % 4294967296; ${NEXT}`);

  // ================================================================ stack
  def('PUSH_R', 70, `${PUSH32(RA)} ${NEXT}`);
  def('PUSH_I', 20, `${PUSH32(F)} ${NEXT}`);
  forEA((s, ea) => def('PUSH_M' + s, s === '_B' ? 12 : 1, `${ea} ${RD32('t1')} ${PUSH32('t1')} ${NEXT}`));
  def('POP_R', 70, `${POP32(RA)} ${NEXT}`);
  def('LEAVE', 4, `sp = reg[6]; ea = sp; ${RD32('t0')} reg[5] = (sp + 4) % 4294967296; reg[6] = t0; sp_sync(); ${NEXT}`);
  // esp moved by something that does not track the window (the decoder puts this entry right after it)
  def('SPSYNC', 0.5, `sp_sync(); ${NEXT}`);
  // add / sub esp, imm (a multiple of 4 below 4096): tD = words, tE = the bound that keeps the window in its page
  def('ADDSP_I', 6, `fx = reg[5]; fy = ${F}; fz = fx + fy; if (fz > 4294967295) { fz -= 4294967296; cf = 1; } else { cf = 0; } fk = 1; reg[5] = fz; if ((spw - 2) % 1024 < ${E}) { spw += ${D}; } else { sp_sync(); } ${NEXT}`);
  def('SUBSP_I', 6, `fx = reg[5]; fy = ${F}; fz = fx - fy; if (fz < 0) { fz += 4294967296; cf = 1; } else { cf = 0; } fk = 2; reg[5] = fz; if ((spw - 1) % 1024 > ${E}) { spw -= ${D}; } else { sp_sync(); } ${NEXT}`);
  // mov r, [esp + 4n] / mov [esp + 4n], r: tE = n, tF = 1023 - n
  def('MOV_RM_SP', 45, `if ((spw - 2) % 1024 < ${F}) { ${RA} = memw[spw + ${E}]; } else { ea = (reg[5] + ${E} * 4) % 4294967296; ${RD32(RA)} sp_sync(); } ${NEXT}`);
  def('MOV_MR_SP', 40, `if ((spw - 2) % 1024 < ${F}) { memw[spw + ${E}] = ${RA}; } else { ea = (reg[5] + ${E} * 4) % 4294967296; ${WR32(RA)} sp_sync(); } ${NEXT}`);

  // ================================================================ 32-bit alu
  // operands in fx (destination) and fy (source); result and flags left in fz / cf / fk
  const ADDC = `if (fz > 4294967295) { fz -= 4294967296; cf = 1; } else { cf = 0; }`;
  const SUBC = `if (fz < 0) { fz += 4294967296; cf = 1; } else { cf = 0; }`;
  const ALU = [
    { n: 'ADD', w: 30, op: `fz = fx + fy; ${ADDC} fk = 1;`, wr: true },
    { n: 'OR', w: 8, op: `${AND32('fx', 'fy')} fz = fx + fy - bw; cf = 0; fk = 0;`, wr: true },
    { n: 'ADC', w: 2, op: `fz = fx + fy + cf; ${ADDC} fk = 5;`, wr: true },
    { n: 'SBB', w: 2, op: `fz = fx - fy - cf; ${SUBC} fk = 6;`, wr: true },
    { n: 'AND', w: 10, op: `${AND32('fx', 'fy')} fz = bw; cf = 0; fk = 0;`, wr: true },
    { n: 'SUB', w: 18, op: `fz = fx - fy; ${SUBC} fk = 2;`, wr: true },
    { n: 'XOR', w: 6, op: `${AND32('fx', 'fy')} fz = fx + fy - 2 * bw; cf = 0; fk = 0;`, wr: true },
    { n: 'CMP', w: 45, op: `fz = fx - fy; ${SUBC} fk = 2;`, wr: false },
  ];
  // grid: id = ALU_ADD_RR + k * 8 + form   (form: RR RI RM_B RM_X MR_B MR_X MI_B MI_X)
  for (const o of ALU) {
    const st = o.wr ? `${RA} = fz;` : '';
    def(`${o.n}_RR`, o.w, `fx = ${RA}; fy = ${RB}; ${o.op} ${st} ${NEXT}`);
    def(`${o.n}_RI`, o.w * 1.5, `fx = ${RA}; fy = ${F}; ${o.op} ${st} ${NEXT}`);
    forEA((s, ea) => def(`${o.n}_RM${s}`, o.w * (s === '_B' ? 0.6 : 0.1), `${ea} ${RD32('fy')} fx = ${RA}; ${o.op} ${st} ${NEXT}`));
    forEA((s, ea) => def(`${o.n}_MR${s}`, o.w * (s === '_B' ? 0.4 : 0.05),
      o.wr ? `${ea} ${RMW32('fx')} fy = ${RA}; ${o.op} ${RMW32_END('fz')} ${NEXT}` : `${ea} ${RD32('fx')} fy = ${RA}; ${o.op} ${NEXT}`));
    forEA((s, ea) => def(`${o.n}_MI${s}`, o.w * (s === '_B' ? 0.5 : 0.05),
      o.wr ? `${ea} ${RMW32('fx')} fy = ${F}; ${o.op} ${RMW32_END('fz')} ${NEXT}` : `${ea} ${RD32('fx')} fy = ${F}; ${o.op} ${NEXT}`));
  }
  def('TEST_RR', 6, `fx = ${RA}; fy = ${RB}; ${AND32('fx', 'fy')} fz = bw; cf = 0; fk = 0; ${NEXT}`);
  def('TEST_RI', 6, `fx = ${RA}; fy = ${F}; ${AND32('fx', 'fy')} fz = bw; cf = 0; fk = 0; ${NEXT}`);
  forEA((s, ea) => def('TEST_MR' + s, s === '_B' ? 3 : 1, `${ea} ${RD32('fx')} fy = ${RA}; ${AND32('fx', 'fy')} fz = bw; cf = 0; fk = 0; ${NEXT}`));
  forEA((s, ea) => def('TEST_MI' + s, s === '_B' ? 6 : 1, `${ea} ${RD32('fx')} fy = ${F}; ${AND32('fx', 'fy')} fz = bw; cf = 0; fk = 0; ${NEXT}`));
  // idioms the decoder spots
  def('ZERO_R', 25, `${RA} = 0; fz = 0; cf = 0; fk = 0; ${NEXT}`);                 // xor r,r / sub r,r
  def('TESTSELF_R', 40, `fz = ${RA}; cf = 0; fk = 0; ${NEXT}`);                    // test r,r / or r,r / and r,r
  def('ANDLO_RI', 8, `fz = ${RA} % ${F}; ${RA} = fz; cf = 0; fk = 0; ${NEXT}`);    // and r, 2^k-1   (tF = 2^k)
  def('ANDHI_RI', 8, `fz = ${RA}; fz = fz - fz % ${F}; ${RA} = fz; cf = 0; fk = 0; ${NEXT}`);   // and r, -(2^k)  (tF = 2^k)
  def('TESTLO_RI', 3, `fz = ${RA} % ${F}; cf = 0; fk = 0; ${NEXT}`);
  def('TESTBIT_RI', 10, `fz = (floor(${RA} / ${F}) % 2) * ${F}; cf = 0; fk = 0; ${NEXT}`);      // test r, 2^k   (tF = 2^k)
  forEA((s, ea) => def('TESTBIT_MI' + s, s === '_B' ? 6 : 1, `${ea} ${RD32('t0')} fz = (floor(t0 / ${F}) % 2) * ${F}; cf = 0; fk = 0; ${NEXT}`));

  // ---- 8-bit compare / test (low-byte registers and memory). flags are normalised to bit 31 (x 2^24)
  const CMP8 = `fz = fx - fy; if (fz < 0) { fz += 4294967296; cf = 1; } else { cf = 0; } fk = 18;`;
  def('CMPB_RI', 12, `fx = (${RA} % 256) * 16777216; fy = ${F}; ${CMP8} ${NEXT}`);            // tF = imm * 2^24
  def('CMPB_RR', 3, `fx = (${RA} % 256) * 16777216; fy = (${RB} % 256) * 16777216; ${CMP8} ${NEXT}`);
  forEA((s, ea) => def('CMPB_MI' + s, s === '_B' ? 20 : 4, `${ea} ${RD8('t0')} fx = t0 * 16777216; fy = ${F}; ${CMP8} ${NEXT}`));
  forEA((s, ea) => def('CMPB_RM' + s, s === '_B' ? 4 : 2, `${ea} ${RD8('t0')} fx = (${RA} % 256) * 16777216; fy = t0 * 16777216; ${CMP8} ${NEXT}`));
  forEA((s, ea) => def('CMPB_MR' + s, s === '_B' ? 4 : 2, `${ea} ${RD8('t0')} fx = t0 * 16777216; fy = (${RA} % 256) * 16777216; ${CMP8} ${NEXT}`));
  def('TESTB_RR', 8, `fz = AND8[(${RA} % 256) * 256 + ${RB} % 256 + 1] * 16777216; cf = 0; fk = 16; ${NEXT}`);
  def('TESTB_RI', 8, `fz = AND8[(${RA} % 256) * 256 + ${F}] * 16777216; cf = 0; fk = 16; ${NEXT}`);   // tF = imm + 1
  forEA((s, ea) => def('TESTB_MI' + s, s === '_B' ? 25 : 3, `${ea} ${RD8('t0')} fz = AND8[t0 * 256 + ${F}] * 16777216; cf = 0; fk = 16; ${NEXT}`));

  // ---- inc / dec / neg / not
  def('INC_R', 14, `fx = ${RA}; fy = 1; fz = (fx + 1) % 4294967296; ${RA} = fz; fk = 1; ${NEXT}`);
  def('DEC_R', 12, `fx = ${RA}; fy = 1; fz = (fx - 1) % 4294967296; ${RA} = fz; fk = 2; ${NEXT}`);
  forEA((s, ea) => def('INC_M' + s, s === '_B' ? 8 : 1, `${ea} ${RMW32('fx')} fy = 1; fz = (fx + 1) % 4294967296; ${RMW32_END('fz')} fk = 1; ${NEXT}`));
  forEA((s, ea) => def('DEC_M' + s, s === '_B' ? 8 : 1, `${ea} ${RMW32('fx')} fy = 1; fz = (fx - 1) % 4294967296; ${RMW32_END('fz')} fk = 2; ${NEXT}`));
  def('NEG_R', 3, `fy = ${RA}; fx = 0; fz = (0 - fy) % 4294967296; cf = (fy > 0); ${RA} = fz; fk = 2; ${NEXT}`);
  def('NOT_R', 3, `${RA} = 4294967295 - ${RA}; ${NEXT}`);

  // ---- shifts by a constant 1..31:  tF = 2^n, tE = 2^(32-n) (shl) or 2^(n-1) (shr/sar), tD/tC = helpers
  def('SHL_RI', 14, `t0 = ${RA}; cf = floor(t0 / ${E}) % 2; fz = (t0 * ${F}) % 4294967296; ${RA} = fz; fo = ((fz > 2147483647) + cf) % 2; fa = 0; fk = 3; ${NEXT}`);
  def('SHR_RI', 12, `t0 = ${RA}; cf = floor(t0 / ${E}) % 2; fz = floor(t0 / ${F}); ${RA} = fz; fo = ${D} * (t0 > 2147483647); fa = 0; fk = 3; ${NEXT}`);
  def('SAR_RI', 6, `t0 = ${RA}; cf = floor(t0 / ${E}) % 2; fz = floor(t0 / ${F}) + (t0 > 2147483647) * ${C}; ${RA} = fz; fo = 0; fa = 0; fk = 3; ${NEXT}`);

  // ---- shifts of a 32-bit register by cl (same arithmetic as shift_op in sys.js)
  def('SHL_RC', 3, `n = reg[2] % 32; if (n > 0) { t0 = ${RA}; cf = floor(t0 / POW2[33 - n]) % 2; fz = (t0 * POW2[n + 1]) % 4294967296; ${RA} = fz; fo = ((fz > 2147483647) + cf) % 2; fa = 0; fk = 3; } ${NEXT}`);
  def('SHR_RC', 2, `n = reg[2] % 32; if (n > 0) { t1 = floor(${RA} / POW2[n]); cf = t1 % 2; fz = floor(t1 / 2); ${RA} = fz; fo = (t1 > 2147483647) * 1; fa = 0; fk = 3; } ${NEXT}`);
  // ---- bt / bts / btr r32, imm8 (tF = 2^bit). only CF changes
  def('BT_RI', 2, `cf = floor(${RA} / ${F}) % 2; ${NEXT}`);
  def('BTS_RI', 0.7, `t0 = ${RA}; cf = floor(t0 / ${F}) % 2; if (cf == 0) { ${RA} = t0 + ${F}; } ${NEXT}`);
  def('BTR_RI', 0.7, `t0 = ${RA}; cf = floor(t0 / ${F}) % 2; if (cf == 1) { ${RA} = t0 - ${F}; } ${NEXT}`);
  // ---- setcc on al/cl/dl/bl (tF = condition code), and r8, imm8 on the same (tF = imm + 1)
  def('SETCC_R', 3, `eval_cc(${F}); t0 = ${RA}; ${RA} = t0 - t0 % 256 + ccr; ${NEXT}`);
  def('ANDB_RI', 2, `t0 = ${RA}; t1 = AND8[(t0 % 256) * 256 + ${F}]; ${RA} = t0 - t0 % 256 + t1; fz = t1 * 16777216; cf = 0; fk = 16; ${NEXT}`);

  // ---- multiply (low 32 bits; flags via imul2)
  def('IMUL_RR', 4, `imul2(${RA}, ${RB}); ${RA} = rv; ${NEXT}`);
  def('IMUL_RRI', 4, `imul2(${RB}, ${F}); ${RA} = rv; ${NEXT}`);
  forEA((s, ea) => def('IMUL_RM' + s, 1, `${ea} ${RD32('t0')} imul2(${RA}, t0); ${RA} = rv; ${NEXT}`));

  // ================================================================ control flow
  const SLT = `((fx + 2147483648) % 4294967296 < (fy + 2147483648) % 4294967296)`;
  const jcc = (name, w, cond, generic) => {
    // cond: SBL boolean expression, or null to use eval_cc
    if (cond) def(name, w, `if (${cond}) { ${JUMP_STATIC} } else { ${NEXT} }`);
    else def(name, w, `eval_cc(${generic}); if (ccr == 1) { ${JUMP_STATIC} } else { ${NEXT} }`);
  };
  jcc('JO', 0.1, null, 0); jcc('JNO', 0.1, null, 1);
  jcc('JB', 12, 'cf == 1'); jcc('JAE', 12, 'cf == 0');
  jcc('JZ', 60, 'fz == 0'); jcc('JNZ', 60, 'fz != 0');
  jcc('JBE', 12, 'cf == 1 || fz == 0'); jcc('JA', 12, 'cf == 0 && fz != 0');
  def('JS', 5, `if (fk == 64) { ccr = xs; } else { ccr = (fz > 2147483647); } if (ccr == 1) { ${JUMP_STATIC} } else { ${NEXT} }`);
  def('JNS', 5, `if (fk == 64) { ccr = xs; } else { ccr = (fz > 2147483647); } if (ccr == 0) { ${JUMP_STATIC} } else { ${NEXT} }`);
  jcc('JP', 0.1, null, 10); jcc('JNP', 0.1, null, 11);
  def('JL', 12, `if (fk == 2) { ccr = ${SLT}; } else { eval_cc(12); } if (ccr == 1) { ${JUMP_STATIC} } else { ${NEXT} }`);
  def('JGE', 12, `if (fk == 2) { ccr = ${SLT}; } else { eval_cc(12); } if (ccr == 0) { ${JUMP_STATIC} } else { ${NEXT} }`);
  def('JLE', 12, `if (fk == 2) { ccr = (fz == 0 || ${SLT}); } else { eval_cc(14); } if (ccr == 1) { ${JUMP_STATIC} } else { ${NEXT} }`);
  def('JG', 12, `if (fk == 2) { ccr = (fz == 0 || ${SLT}); } else { eval_cc(14); } if (ccr == 0) { ${JUMP_STATIC} } else { ${NEXT} }`);
  def('JMP', 40, JUMP_STATIC);
  def('CALL', 55, `${PUSH32(E)} ${JUMP_STATIC}`);                                   // tE = return address
  def('RET', 55, `${POP32('eip')} ${JUMP_DYN}`);
  def('RET_I', 2, `sp = reg[5]; ea = sp; ${RD32('eip')} reg[5] = (sp + 4 + ${F}) % 4294967296; sp_sync(); ${JUMP_DYN}`);
  def('JMP_R', 3, `eip = ${RA}; ${JUMP_DYN}`);
  forEA((s, ea) => def('JMP_M' + s, s === '_B' ? 1 : 4, `${ea} ${RD32('eip')} ${JUMP_DYN}`));
  def('CALL_R', 6, `t1 = ${RA}; ${PUSH32(E)} eip = t1; ${JUMP_DYN}`);
  forEA((s, ea) => def('CALL_M' + s, s === '_B' ? 5 : 2, `${ea} ${RD32('t1')} ${PUSH32(F)} eip = t1; ${JUMP_DYN}`));   // tF = return address
  // loop / loope / loopne / jecxz: tC = kind (0 loopne, 1 loope, 2 loop, 3 jecxz), tD = 65536 for 16-bit count
  def('LOOPX', 0.5, `do_loop(${C}, ${D}); if (ccr == 1) { ${JUMP_STATIC} } else { ${NEXT} }`);

  // ================================================================ flags and small stuff
  def('CLC', 0.5, `cf = 0; ${NEXT}`);
  def('STC', 0.5, `cf = 1; ${NEXT}`);
  def('CMC', 0.1, `cf = 1 - cf; ${NEXT}`);
  def('CLD', 2, `fl_df = 0; ${NEXT}`);
  def('STD', 0.5, `fl_df = 1; ${NEXT}`);
  def('CLI', 3, `if (cpl > fl_iopl) { exc(13, 0, 1); return; } fl_if = 0; ${NEXT}`);
  // popf / iret can unmask a pending interrupt: they leave the run loop so the machine loop delivers it at once.
  // sti does not (interrupts are only recognised after the instruction that follows it, think "sti; hlt")
  def('STI', 3, `if (cpl > fl_iopl) { exc(13, 0, 1); return; } fl_if = 1; ${NEXT}`);
  def('CWDE', 1, `t0 = reg[1] % 65536; reg[1] = t0 + (t0 > 32767) * 4294901760; ${NEXT}`);
  def('CBW', 0.1, `t0 = reg[1] % 256; reg[1] = reg[1] - reg[1] % 65536 + t0 + (t0 > 127) * 65280; ${NEXT}`);
  def('CDQ', 3, `reg[3] = (reg[1] > 2147483647) * 4294967295; ${NEXT}`);
  def('CWD', 0.1, `reg[3] = reg[3] - reg[3] % 65536 + (reg[1] % 65536 > 32767) * 65535; ${NEXT}`);
  def('BSWAP', 0.5, `t0 = ${RA}; ${RA} = (t0 % 256) * 16777216 + (floor(t0 / 256) % 256) * 65536 + (floor(t0 / 65536) % 256) * 256 + floor(t0 / 16777216); ${NEXT}`);
  def('SAHF', 0.1, `flags_ofaf(); t0 = fo; set_aflags(floor(reg[1] / 256) % 256); fo = t0; ${NEXT}`);
  def('LAHF', 0.1, `get_eflags(); reg[1] = reg[1] - (floor(reg[1] / 256) % 256) * 256 + (efl % 256) * 256; ${NEXT}`);
  def('PUSHF', 3, `do_pushf(${D}); ${FAULT} ${NEXT}`);
  def('POPF', 3, `do_popf(${D}); ${FAULT} ${NEXT} if (irq_out == 1) { if (fl_if == 1) { return; } }`);
  def('PUSHA', 0.2, `do_pusha(); ${FAULT} ${NEXT}`);
  def('POPA', 0.2, `do_popa(); ${FAULT} ${NEXT}`);
  def('ENTER', 0.1, `do_enter(${F}, ${E}); ${FAULT} ${NEXT}`);
  def('XLAT', 0.1, `ea = (reg[4] + reg[1] % 256 + reg[${B}]) % 4294967296; ${RD8('t0')} reg[1] = reg[1] - reg[1] % 256 + t0; ${NEXT}`);
  def('HLT', 1, `if (cpl > 0) { exc(13, 0, 1); return; } halted = 1; ${NEXT} return;`);
  def('CPUID', 0.1, `do_cpuid(); ${NEXT}`);
  def('RDTSC', 0.1, `do_rdtsc(); ${NEXT}`);
  // no model specific registers here. like qemu, reads give 0 and writes vanish (linux only probes with the _safe variants)
  def('MSR', 0.1, `if (cpl > 0) { exc(13, 0, 1); return; } if (${F} == 1) { reg[1] = 0; reg[3] = 0; } ${NEXT}`);
  def('FPU', 0.5, `if (fpu_trap == 1) { exc(7, 0, 0); return; } ${NEXT}`);          // any x87 opcode
  def('FWAIT', 0.1, `if (floor(cr0 / 2) % 2 == 1) { if (floor(cr0 / 8) % 2 == 1) { exc(7, 0, 0); return; } } ${NEXT}`);

  // ================================================================ generic slow lane
  // r/m operand: tC > 0 -> register code tC - 1, else memory at reg[tB] + tE; size tD; reg operand code tA - 1; imm tF
  const GSZ = `g_size(${D});`;
  const GALU = [
    `r = a + b; cf = (r > gm - 1); r = r % gm; fz = r * gs; fx = a * gs; fy = b * gs; fk = 1 + gc;`,
    `and32(a, b); r = a + b - bw; cf = 0; fz = r * gs; fk = gc;`,
    `r = a + b + cf; cf = (r > gm - 1); r = r % gm; fz = r * gs; fx = a * gs; fy = b * gs; fk = 5 + gc;`,
    `r = a - b - cf; cf = (r < 0); r = r % gm; fz = r * gs; fx = a * gs; fy = b * gs; fk = 6 + gc;`,
    `and32(a, b); r = bw; cf = 0; fz = r * gs; fk = gc;`,
    `r = a - b; cf = (r < 0); r = r % gm; fz = r * gs; fx = a * gs; fy = b * gs; fk = 2 + gc;`,
    `and32(a, b); r = a + b - 2 * bw; cf = 0; fz = r * gs; fk = gc;`,
    `r = a - b; cf = (r < 0); r = r % gm; fz = r * gs; fx = a * gs; fy = b * gs; fk = 2 + gc;`,
  ];
  ALU.forEach((o, k) => {
    const rd = o.wr ? 'g_rmw();' : 'g_rd();';
    const wr = o.wr ? 'g_wr(r);' : '';
    // id = G_ADD_EG + k * 3 + form (EG GE EI)
    def(`G_${o.n}_EG`, 1, `${GSZ} ${rd} ${FAULT} a = gv; gr_rd(${A} - 1, ${D}); b = gv; ${GALU[k]} ${wr} ${NEXT}`);
    def(`G_${o.n}_GE`, 1, `${GSZ} g_rd(); ${FAULT} b = gv; gr_rd(${A} - 1, ${D}); a = gv; ${GALU[k]} ${o.wr ? `gr_wr(${A} - 1, ${D}, r);` : ''} ${NEXT}`);
    def(`G_${o.n}_EI`, 1.5, `${GSZ} ${rd} ${FAULT} a = gv; b = ${F}; ${GALU[k]} ${wr} ${NEXT}`);
  });
  def('G_TEST_EG', 1, `${GSZ} g_rd(); ${FAULT} a = gv; gr_rd(${A} - 1, ${D}); and32(a, gv); cf = 0; fz = bw * gs; fk = gc; ${NEXT}`);
  def('G_TEST_EI', 1, `${GSZ} g_rd(); ${FAULT} a = gv; and32(a, ${F}); cf = 0; fz = bw * gs; fk = gc; ${NEXT}`);
  def('G_MOV_EG', 6, `gr_rd(${A} - 1, ${D}); g_st(gv); ${FAULT} ${NEXT}`);
  def('G_MOV_GE', 6, `g_rd(); ${FAULT} gr_wr(${A} - 1, ${D}, gv); ${NEXT}`);
  def('G_MOV_EI', 4, `g_st(${F}); ${FAULT} ${NEXT}`);
  def('G_INC', 2, `${GSZ} g_rmw(); ${FAULT} a = gv; r = (a + 1) % gm; fz = r * gs; fx = a * gs; fy = gs; fk = 1 + gc; g_wr(r); ${NEXT}`);
  def('G_DEC', 2, `${GSZ} g_rmw(); ${FAULT} a = gv; r = (a - 1) % gm; fz = r * gs; fx = a * gs; fy = gs; fk = 2 + gc; g_wr(r); ${NEXT}`);
  def('G_NOT', 0.5, `${GSZ} g_rmw(); ${FAULT} g_wr(gm - 1 - gv); ${NEXT}`);
  def('G_NEG', 0.5, `${GSZ} g_rmw(); ${FAULT} a = gv; r = (0 - a) % gm; cf = (a > 0); fz = r * gs; fx = 0; fy = a * gs; fk = 2 + gc; g_wr(r); ${NEXT}`);
  def('G_MUL', 1, `${GSZ} g_rd(); ${FAULT} do_mul(gv, ${D}, 0); ${NEXT}`);
  def('G_IMUL1', 0.5, `${GSZ} g_rd(); ${FAULT} do_mul(gv, ${D}, 1); ${NEXT}`);
  def('G_DIV', 2, `${GSZ} g_rd(); ${FAULT} do_div(gv, ${D}); ${FAULT} ${NEXT}`);
  def('G_IDIV', 1, `${GSZ} g_rd(); ${FAULT} do_idiv(gv, ${D}); ${FAULT} ${NEXT}`);
  // shifts and rotates: tA = operation (0 rol 1 ror 2 rcl 3 rcr 4 shl 5 shr 6 shl 7 sar), tF = count or 256 for cl
  def('G_SHIFT', 6, `${GSZ} g_rmw(); ${FAULT} if (${F} == 256) { n = reg[2] % 32; } else { n = ${F} % 32; } if (n > 0) { shift_op(${A}, gv, n); g_wr(rv); } ${NEXT}`);
  // shld / shrd: tA - 1 = source register code, tF = count or 256 for cl, tD = size; direction in the handler
  def('G_SHLD', 1, `${GSZ} g_rmw(); ${FAULT} if (${F} == 256) { n = reg[2] % 32; } else { n = ${F} % 32; } if (n > 0) { a = gv; gr_rd(${A} - 1, ${D}); shiftd_op(0, a, gv, n); g_wr(rv); } ${NEXT}`);
  def('G_SHRD', 1, `${GSZ} g_rmw(); ${FAULT} if (${F} == 256) { n = reg[2] % 32; } else { n = ${F} % 32; } if (n > 0) { a = gv; gr_rd(${A} - 1, ${D}); shiftd_op(1, a, gv, n); g_wr(rv); } ${NEXT}`);
  def('G_IMUL2', 0.5, `${GSZ} g_rd(); ${FAULT} a = gv; gr_rd(${A} - 1, ${D}); imuln(gv, a); gr_wr(${A} - 1, ${D}, rv); ${NEXT}`);
  def('G_IMUL3', 0.5, `${GSZ} g_rd(); ${FAULT} imuln(gv, ${F}); gr_wr(${A} - 1, ${D}, rv); ${NEXT}`);
  def('G_XCHG', 2, `g_rmw_w(); ${FAULT} a = gv; gr_rd(${A} - 1, ${D}); g_wr(gv); gr_wr(${A} - 1, ${D}, a); ${NEXT}`);
  def('G_XADD', 0.5, `${GSZ} g_rmw(); ${FAULT} a = gv; gr_rd(${A} - 1, ${D}); b = gv; ${GALU[0]} gr_wr(${A} - 1, ${D}, a); g_wr(r); ${NEXT}`);
  def('G_CMPXCHG', 3, `${GSZ} g_rmw(); ${FAULT} b = gv; gr_rd(0, ${D}); a = gv; ${GALU[7]} if (r == 0) { gr_rd(${A} - 1, ${D}); g_wr(gv); } else { g_wr(b); gr_wr(0, ${D}, b); } ${NEXT}`);
  // bit tests: tC > 0 register operand, else memory. offset from register tA - 1 (G_BT*_R) or immediate tF (G_BT*_I)
  ['BT', 'BTS', 'BTR', 'BTC'].forEach((nm, k) => {
    def(`G_${nm}_R`, 2, `gr_rd(${A} - 1, ${D}); bt_op(${k}, gv, 1); ${FAULT} ${NEXT}`);
    def(`G_${nm}_I`, 2, `bt_op(${k}, ${F}, 0); ${FAULT} ${NEXT}`);
  });
  def('G_BSF', 1, `${GSZ} g_rd(); ${FAULT} do_bsf(gv); if (gv > 0) { gr_wr(${A} - 1, ${D}, rv); } ${NEXT}`);
  def('G_BSR', 1, `${GSZ} g_rd(); ${FAULT} do_bsr(gv); if (gv > 0) { gr_wr(${A} - 1, ${D}, rv); } ${NEXT}`);
  def('G_SETCC', 4, `eval_cc(${A}); g_st(ccr); ${FAULT} ${NEXT}`);                     // tA = condition code
  def('G_CMOV', 0.5, `g_rd(); ${FAULT} eval_cc(${F}); if (ccr == 1) { gr_wr(${A} - 1, ${D}, gv); } ${NEXT}`);
  // movzx / movsx odd forms: source size tD, tF = destination size, tE... sign flag lives in the handler
  def('G_MOVZX', 1, `g_rd(); ${FAULT} gr_wr(${A} - 1, ${F}, gv); ${NEXT}`);
  def('G_MOVSX', 1, `g_rd(); ${FAULT} if (${D} == 1) { if (gv > 127) { gv += 4294967040; } } else { if (gv > 32767) { gv += 4294901760; } } gr_wr(${A} - 1, ${F}, gv % POW2[${F} * 8 + 1]); ${NEXT}`);
  def('G_PUSH', 1, `g_rd(); ${FAULT} do_push(gv, ${D}); ${FAULT} ${NEXT}`);
  def('G_POP', 1, `do_pop_rm(); ${FAULT} ${NEXT}`);
  def('G_PUSHW_I', 0.1, `do_push(${F}, 2); ${FAULT} ${NEXT}`);
  def('G_LEA', 0.2, `gr_wr(${A} - 1, ${D}, (reg[${B}] + ${E}) % POW2[${D} * 8 + 1]); ${NEXT}`);
  def('G_XCHG_AX', 0.5, `gr_rd(0, ${D}); a = gv; gr_rd(${A} - 1, ${D}); gr_wr(0, ${D}, gv); gr_wr(${A} - 1, ${D}, a); ${NEXT}`);

  // ---- segment registers, far transfers, system
  def('MOV_SEG_E', 3, `g_rd(); ${FAULT} load_seg(${A}, gv % 65536); ${FAULT} ${NEXT}`);       // tA = segment number
  def('MOV_E_SEG', 3, `g_st(segsel[${A} + 1]); ${FAULT} ${NEXT}`);                             // tD: 2 for memory, 4 for a register
  def('PUSH_SEG', 2, `do_push(segsel[${A} + 1], ${D}); ${FAULT} ${NEXT}`);
  def('POP_SEG', 2, `do_pop_seg(${A}, ${D}); ${FAULT} ${NEXT}`);
  def('LXS', 0.2, `do_lxs(${F}); ${FAULT} ${NEXT}`);                                           // lss/lds/les/lfs/lgs, tF = segment number
  def('JMPF', 0.2, `do_jmpf(${A}, ${F}); if (flt == 1) { return; }`);                          // tA = selector, tF = offset
  def('JMPF_M', 0.1, `do_farptr(); ${FAULT} do_jmpf(t1, t0); if (flt == 1) { return; }`);
  def('CALLF', 0.1, `do_callf(${A}, ${F}, ${E}); if (flt == 1) { return; }`);
  def('CALLF_M', 0.1, `do_farptr(); ${FAULT} do_callf(t1, t0, ${F}); if (flt == 1) { return; }`);
  def('RETF', 0.1, `do_retf(${F}); if (flt == 1) { return; }`);
  def('IRET', 6, `do_iret(); if (flt == 1) { return; } if (irq_out == 1) { if (fl_if == 1) { return; } }`);
  def('INT', 6, `do_interrupt(${F}, 1, 0, 0, ${E}); flt = 0; return;`);                        // tE = return address
  def('INTO', 0, `flags_ofaf(); if (fo == 1) { do_interrupt(4, 1, 0, 0, ${E}); flt = 0; return; } ${NEXT}`);
  def('GRP6', 0.2, `do_grp6(${A}); ${FAULT} ${NEXT}`);
  def('GRP7', 0.2, `do_grp7(${A}); ${FAULT} ${NEXT}`);
  def('INVLPG', 2, `if (cpl > 0) { exc(13, 0, 1); return; } tlb_invlpg((reg[${B}] + ${E}) % 4294967296); ${NEXT}`);
  def('CLTS', 0.5, `if (cpl > 0) { exc(13, 0, 1); return; } set_cr0(cr0 - (floor(cr0 / 8) % 2) * 8); ${NEXT}`);
  def('MOV_R_CR', 1, `if (cpl > 0) { exc(13, 0, 1); return; } get_cr(${F}); ${RA} = rv; ${NEXT}`);
  // writing a control register can change the mapping under our feet: this is always the last entry of its block
  def('MOV_CR_R', 2, `if (cpl > 0) { exc(13, 0, 1); return; } set_cr(${F}, ${RA}); ${NEXT}`);
  def('MOV_R_DR', 0.1, `if (cpl > 0) { exc(13, 0, 1); return; } ${RA} = dreg[${F} + 1]; ${NEXT}`);
  def('MOV_DR_R', 0.1, `if (cpl > 0) { exc(13, 0, 1); return; } dreg[${F} + 1] = ${RA}; ${NEXT}`);
  // port i/o: tD = size, tF = port or 65536 for dx
  def('IN', 3, `if (cpl > fl_iopl) { exc(13, 0, 1); return; } if (${F} == 65536) { t0 = reg[3] % 65536; } else { t0 = ${F}; } port_in(t0, ${D}); gr_wr(0, ${D}, rv); ${NEXT}`);
  def('OUT', 4, `if (cpl > fl_iopl) { exc(13, 0, 1); return; } if (${F} == 65536) { t0 = reg[3] % 65536; } else { t0 = ${F}; } gr_rd(0, ${D}); port_out(t0, ${D}, gv); ${NEXT} if (halted > 0) { return; }`);
  // string ops: tA = segment base register for the source, tD = size, tF = rep mode (0 none, 1 rep/repe, 2 repne)
  // a string proc leaves ccr = 1 when it stopped early with work left (re-run the same trace entry)
  for (const nm of ['MOVS', 'STOS', 'LODS', 'CMPS', 'SCAS']) {
    def('STR_' + nm, nm === 'MOVS' || nm === 'STOS' ? 6 : 2, `str_${nm.toLowerCase()}(${A}, ${D}, ${F}); ${FAULT} if (ccr == 0) { ${NEXT} }`);
  }

  // ---------------------------------------------------------------- fused sequences
  // Finding the handler costs about as much as running it, so common sequences of simple instructions
  // ("push; push", "pop; pop; ret", "test; jz" ...) get handlers of their own: the bodies above glued together.
  // The decoder builds them up pairwise: when the instruction it just decoded can be fused onto the entry before
  // it, its operands move into that entry's free fields and the entry becomes the fused handler. Which sequences
  // exist comes from a profile (tools/mkfuse.js). Any instruction of a sequence may still fault: xeip tells exc()
  // which one it was (tO holds the byte offsets of the later instructions, 6 bits each).
  const NINTERP = H.length;
  const FIELDS = ['A', 'B', 'C', 'D', 'E', 'F'];
  const usedFields = (body) => FIELDS.filter((f) => body.includes(`t${f}[tp]`));
  const fused = new Map();               // "A+B+C" -> handler
  const fuseTable = [];                  // [prev static id, cur static id, fused static id]
  const patterns = ((cfg.fuse && cfg.fuse.patterns) || []).slice().sort((x, y) => x.seq.length - y.seq.length);
  for (const pat of patterns) {
    const seq = pat.seq, n = seq.length;
    const prev = n === 2 ? byName.get(seq[0]) : fused.get(seq.slice(0, n - 1).join('+'));
    const cur = byName.get(seq[n - 1]);
    if (!prev || !cur) throw new Error(`fuse: ${seq.join('+')} needs its prefix and its parts to exist`);
    // fields: the left part keeps what it has, the new instruction gets the free ones
    const taken = new Set(prev.fuse ? prev.fuse.taken : usedFields(prev.body));
    const map = {};
    for (const f of usedFields(cur.body)) {
      const free = FIELDS.find((x) => !taken.has(x));
      if (!free) throw new Error(`fuse: ${seq.join('+')} needs more than six operand fields`);
      map[f] = free; taken.add(free);
    }
    let body = cur.body;
    // (stp is tp saved across find_block by a chained jump: it updates the same entry's chain cache)
    for (const f of FIELDS) if (map[f]) body = body.split(`t${f}[tp]`).join(`t#${map[f]}[tp]`).split(`t${f}[stp]`).join(`t#${map[f]}[stp]`);
    body = body.split('t#').join('t');
    body = body.split('@P@').join(`xeip = tI[tp] + floor(tO[tp] / ${Math.pow(64, n - 2)}) % 64;`);
    let left = prev.fuse ? prev.body : prev.body.split('@P@').join('xeip = tI[tp];');
    if (!left.endsWith(NEXT) || left.indexOf('tp ') !== left.length - NEXT.length) throw new Error(`fuse: ${seq[n - 2]} cannot be followed by anything`);
    left = left.slice(0, -NEXT.length);
    const hh = def(seq.join('+'), pat.w, `${left}\n// + ${seq[n - 1]}\n${body}`);
    hh.fuse = { n, taken, map: FIELDS.map((f) => (map[f] ? FIELDS.indexOf(map[f]) + 1 : 0)), pow: Math.pow(64, n - 2) };
    fused.set(hh.name, hh);
    fuseTable.push([prev.id, cur.id, hh.id]);
  }

  // ---------------------------------------------------------------- dispatch tree
  // every handler has a static id (definition order: the decoder does arithmetic on those) and a dispatch id,
  // which is what the trace holds. dispatch ids number the leaves of a huffman tree built from the profile, so
  // run() finds a handler in about as few comparisons as its frequency allows.
  if (cfg.weights) for (const hh of H) if (!hh.fuse && cfg.weights[hh.name] !== undefined) hh.w = cfg.weights[hh.name];
  let nodes = H.map((hh) => ({ w: hh.w + 1e-6, leaf: hh }));
  while (nodes.length > 1) {
    nodes.sort((x, y) => y.w - x.w);
    const b = nodes.pop(), a = nodes.pop();
    nodes.push({ w: a.w + b.w, l: a, r: b });
  }
  let nextDid = 1, depthSum = 0, wSum = 0;
  const number = (n, d) => {
    if (n.leaf) { n.leaf.did = nextDid++; n.first = n.leaf.did; n.leaf.depth = d; depthSum += n.leaf.w * d; wSum += n.leaf.w; return; }
    number(n.l, d + 1); number(n.r, d + 1); n.first = n.l.first;
  };
  number(nodes[0], 0);
  const bodyOf = (hh) => hh.body.split('@P@').join('');
  const tree = (n, ind) => {
    if (n.leaf) return `${ind}// ${n.leaf.name}\n${ind}${n.leaf.fuse ? n.leaf.body : bodyOf(n.leaf)}\n`;
    return `${ind}if (h < ${n.r.first}) {\n${tree(n.l, ind + ' ')}${ind}} else {\n${tree(n.r, ind + ' ')}${ind}}\n`;
  };
  const byDid = []; for (const hh of H) byDid[hh.did] = hh;
  const hmap = H.map((hh) => hh.did);
  const prof = (cfg.profile ? 'prof[h] += 1;' : '') + (cfg.unitProf ? ' tpc[tp] += 1;' : '');
  const dbg = (cfg.debugHook ? `host("step");` : '') + (cfg.spCheck ? ' sp_check();' : '');
  const src = `
var gm = 0, gs = 0, gc = 0, gv = 0, gb = 0, xeip = 0;
${cfg.profile ? `list prof[${H.length + 1}];` : ''}
${cfg.unitProf ? 'list tpc[TN]; list tL[TN];' : ''}
${H.slice(0, NINTERP).map((hh) => `const H_${hh.name} = ${hh.id};`).join('\n')}
list HMAP = data("hmap");               // static handler id -> dispatch id
${patterns.length ? 'list ISUNIT = data("isunit");           // by dispatch id: 1 = fused sequence (the faulting eip is in xeip)' : ''}

${cfg.spCheck ? `// debugging aid (js builds): the stack window must agree with esp and the write tlb between instructions
proc sp_check() {
  if (spw == 1) { return; }
  if (tH[tp] == HMAP[H_SPSYNC]) { return; }      // esp has just been moved, the fix-up entry is next
  if (reg[5] % 4 == 0) { q = tlbW[floor(reg[5] / 4096) + tlbOff]; if (q != 0) { if (spw == q + reg[5] / 4) { return; } } }
  fatal(50, tI[tp]);
}` : ''}
// run up to cnt trace entries
proc run(cnt) {
  repeat (cnt) {
    h = tH[tp];
    ${prof}${dbg}
${tree(nodes[0], '    ')}
  }
}
`;
  const isunit = []; for (let d = 1; d < nextDid; d++) isunit.push(byDid[d].fuse ? 1 : 0);
  // by static id: 1 = the handler stores into reg[tA]. when tA is esp the decoder appends an SPSYNC entry.
  // (the stack handlers themselves keep the window right and are exempt.)
  const wra = H.map((hh) => (!hh.fuse && /(^|[;{}\s])reg\[tA\[tp\]\] = /.test(hh.body) && !/^(POP_R|MOV_RM_SP)$/.test(hh.name) ? 1 : 0));
  return { src, H, byName, byDid, hmap, isunit, wra, fuseTable, ninterp: NINTERP, avgDepth: depthSum / wSum };
};
