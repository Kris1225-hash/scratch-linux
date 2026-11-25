'use strict';
// i486SX core, part 4: the cold procs behind the generic ("G_") and system handlers.

module.exports = function sys(cfg) {
  // family 4 model 8, no fpu/vme/pse. ebx/ecx are what qemu's 486 reports (clflush size field, hypervisor bit) so the two stay comparable
  const c1 = cfg.cpuid1 || { eax: 0x480, ebx: 0x800, ecx: 2147483648, edx: 0 };
  return `
// ---------------------------------------------------------------- generic operand access
var g_ea = 0;

proc g_size(sz) {
  if (sz == 4) { gm = 4294967296; gs = 1; gc = 0; gb = 32; }
  else { if (sz == 2) { gm = 65536; gs = 65536; gc = 8; gb = 16; } else { gm = 256; gs = 16777216; gc = 16; gb = 8; } }
}
// register by x86 code (0..7) and size. 8-bit codes 4..7 are ah ch dh bh
proc gr_rd(code, sz) {                 // -> gv
  if (sz == 4) { gv = reg[code + 1]; }
  else { if (sz == 2) { gv = reg[code + 1] % 65536; }
  else { if (code < 4) { gv = reg[code + 1] % 256; } else { gv = floor(reg[code - 3] / 256) % 256; } } }
}
proc gr_wr(code, sz, v) {
  if (code == 4) { spw = 1; }
  if (sz == 4) { reg[code + 1] = v + 0; }
  else { if (sz == 2) { reg[code + 1] = reg[code + 1] - reg[code + 1] % 65536 + v; }
  else { if (code < 4) { reg[code + 1] = reg[code + 1] - reg[code + 1] % 256 + v; }
  else { reg[code - 3] = reg[code - 3] + (v - floor(reg[code - 3] / 256) % 256) * 256; } } }
}
// the r/m operand of the instruction at tp
proc g_rd() {                          // -> gv
  if (tC[tp] > 0) { gr_rd(tC[tp] - 1, tD[tp]); return; }
  g_ea = (reg[tB[tp]] + tE[tp]) % M32;
  if (tD[tp] == 4) { rd32(g_ea); } else { if (tD[tp] == 2) { rd16(g_ea); } else { rd8(g_ea); } }
  gv = rv;
}
// read with intent to write back: any fault happens here, g_wr afterwards cannot fail
proc g_rmw() {
  if (tC[tp] > 0) { gr_rd(tC[tp] - 1, tD[tp]); return; }
  g_ea = (reg[tB[tp]] + tE[tp]) % M32;
  rwchk(g_ea); if (flt == 1) { return; }
  if (tD[tp] > 1) { rwchk((g_ea + tD[tp] - 1) % M32); if (flt == 1) { return; } }
  if (tD[tp] == 4) { rd32(g_ea); } else { if (tD[tp] == 2) { rd16(g_ea); } else { rd8(g_ea); } }
  gv = rv;
}
// same, for implicitly locked instructions (xchg): the operand is taken for writing straight away
proc g_rmw_w() {
  if (tC[tp] > 0) { gr_rd(tC[tp] - 1, tD[tp]); return; }
  g_ea = (reg[tB[tp]] + tE[tp]) % M32;
  wchk(g_ea); if (flt == 1) { return; }
  if (tD[tp] > 1) { wchk((g_ea + tD[tp] - 1) % M32); if (flt == 1) { return; } }
  if (tD[tp] == 4) { rd32(g_ea); } else { if (tD[tp] == 2) { rd16(g_ea); } else { rd8(g_ea); } }
  gv = rv;
}
proc g_wr(v) {
  if (tC[tp] > 0) { gr_wr(tC[tp] - 1, tD[tp], v); return; }
  if (tD[tp] == 4) { wr32(g_ea, v + 0); } else { if (tD[tp] == 2) { wr16(g_ea, v + 0); } else { wr8(g_ea, v + 0); } }
}
proc g_st(v) {
  if (tC[tp] > 0) { gr_wr(tC[tp] - 1, tD[tp], v); return; }
  g_ea = (reg[tB[tp]] + tE[tp]) % M32;
  if (tD[tp] == 4) { wr32(g_ea, v + 0); } else { if (tD[tp] == 2) { wr16(g_ea, v + 0); } else { wr8(g_ea, v + 0); } }
}

// ---------------------------------------------------------------- shifts and rotates
var so_t = 0, so_m = 0, so_h = 0;

// op: 0 rol 1 ror 2 rcl 3 rcr 4 shl 5 shr 6 shl 7 sar. v = operand, cnt = 1..31. size from g_size. -> rv + flags
proc shift_op(op, v, cnt) {
  so_h = gm / 2;
  if (op == 4 || op == 6) {
    if (cnt > gb) { rv = 0; cf = 0; }
    else { cf = floor(v / POW2[gb - cnt + 1]) % 2; rv = (v * POW2[cnt + 1]) % gm; }
    fz = rv * gs; fo = ((rv >= so_h) + cf) % 2; fa = 0; fk = 3 + gc;
    return;
  }
  if (op == 5) {
    so_t = floor(v / POW2[cnt]);
    cf = so_t % 2; rv = floor(so_t / 2);
    fz = rv * gs; fo = ((so_t % gm >= so_h) + (rv >= so_h)) % 2; fa = 0; fk = 3 + gc;
    return;
  }
  if (op == 7) {
    if (v >= so_h) { so_t = floor((v - gm) / POW2[cnt]); cf = so_t % 2; rv = floor(so_t / 2) + gm; }
    else { so_t = floor(v / POW2[cnt]); cf = so_t % 2; rv = floor(so_t / 2); }
    fz = rv * gs; fo = 0; fa = 0; fk = 3 + gc;
    return;
  }
  // rotates only touch CF and OF
  flags_ofaf();
  if (op == 0) {
    so_m = cnt % gb;
    rv = (v * POW2[so_m + 1]) % gm + floor(v / POW2[gb - so_m + 1]);
    cf = rv % 2; fo = ((v >= so_h) + (rv >= so_h)) % 2;
    return;
  }
  if (op == 1) {
    so_m = cnt % gb;
    rv = floor(v / POW2[so_m + 1]) + (v % POW2[so_m + 1]) * POW2[gb - so_m + 1];
    cf = (rv >= so_h) + 0; fo = ((v >= so_h) + cf) % 2;
    return;
  }
  so_m = cnt % (gb + 1);
  if (so_m == 0) { rv = v; return; }
  if (op == 2) {
    rv = (v * POW2[so_m + 1]) % gm + cf * POW2[so_m] + floor(v / POW2[gb - so_m + 2]);
    cf = floor(v / POW2[gb - so_m + 1]) % 2;
  } else {
    rv = floor(v / POW2[so_m + 1]) + cf * POW2[gb - so_m + 1] + (v * POW2[gb - so_m + 2]) % gm;
    cf = floor(v / POW2[so_m]) % 2;
  }
  fo = ((v >= so_h) + (rv >= so_h)) % 2;
}
// double shifts. dir 0 = shld, 1 = shrd. x = destination, y = filler, cnt = 1..31 -> rv + flags
proc shiftd_op(dir, x, y, cnt) {
  so_h = gm / 2;
  if (cnt > gb) { rv = x; return; }               // 16-bit operand with count > 16: undefined, leave it alone
  if (dir == 0) {
    rv = (x * POW2[cnt + 1]) % gm + floor(y / POW2[gb - cnt + 1]);
    cf = floor(x / POW2[gb - cnt + 1]) % 2;
    fo = ((rv >= so_h) + cf) % 2;
  } else {
    rv = floor(x / POW2[cnt + 1]) + (y * POW2[gb - cnt + 1]) % gm;
    so_t = floor(x / POW2[cnt]);
    cf = so_t % 2;
    fo = ((so_t >= so_h) + (rv >= so_h)) % 2;
  }
  fz = rv * gs; fa = 0; fk = 3 + gc;
}

// ---------------------------------------------------------------- multiply / divide
var mu_al = 0, mu_ah = 0, mu_bl = 0, mu_bh = 0, mu_ll = 0, mu_mid = 0, m_lo = 0, m_hi = 0, mu_x = 0, mu_y = 0, mu_p = 0;
var dv_q = 0, dv_r = 0, dv_n = 0, dv_q1 = 0, dv_hi = 0, dv_lo = 0, dv_d = 0, dv_neg = 0, dv_rneg = 0, dv_ovf = 0;

proc mul64(x, y) {                      // unsigned 32 x 32 -> m_hi : m_lo
  mu_al = x % 65536; mu_ah = floor(x / 65536); mu_bl = y % 65536; mu_bh = floor(y / 65536);
  mu_ll = mu_al * mu_bl;
  mu_mid = mu_al * mu_bh + mu_ah * mu_bl + floor(mu_ll / 65536);
  m_lo = (mu_mid % 65536) * 65536 + mu_ll % 65536;
  m_hi = mu_ah * mu_bh + floor(mu_mid / 65536);
}
// signed 32 x 32, low half in rv, CF = OF = "did not fit"
proc imul2(x, y) {
  mul64(x, y);
  if (x > SMAX) { m_hi = (m_hi - y) % M32; }
  if (y > SMAX) { m_hi = (m_hi - x) % M32; }
  rv = m_lo;
  cf = (m_hi != (m_lo > SMAX) * UMAX) + 0; fo = cf; fz = m_lo; fa = 0; fk = 3;
}
// same for the operand size chosen by g_size
proc imuln(x, y) {
  if (gb == 32) { imul2(x, y); return; }
  mu_x = x - (x >= gm / 2) * gm; mu_y = y - (y >= gm / 2) * gm;
  mu_p = mu_x * mu_y;
  rv = mu_p % gm;
  cf = (mu_p < 0 - gm / 2 || mu_p > gm / 2 - 1) + 0; fo = cf; fz = rv * gs; fa = 0; fk = 3 + gc;
}
// one-operand mul / imul: (e)dx:(e)ax = (e)ax * v, or ax = al * v
proc do_mul(v, sz, sgn) {
  if (sz == 4) {
    mul64(reg[1], v);
    if (sgn == 1) {
      if (reg[1] > SMAX) { m_hi = (m_hi - v) % M32; }
      if (v > SMAX) { m_hi = (m_hi - reg[1]) % M32; }
      cf = (m_hi != (m_lo > SMAX) * UMAX) + 0;
    } else { cf = (m_hi > 0) + 0; }
    reg[1] = m_lo; reg[3] = m_hi;
    fz = m_lo; fo = cf; fa = 0; fk = 3;
    return;
  }
  if (sz == 2) {
    mu_x = reg[1] % 65536; mu_y = v;
    if (sgn == 1) { mu_x = mu_x - (mu_x > 32767) * 65536; mu_y = mu_y - (mu_y > 32767) * 65536; }
    mu_p = mu_x * mu_y;
    if (sgn == 1) { cf = (mu_p < 0 - 32768 || mu_p > 32767) + 0; } else { cf = (mu_p > 65535) + 0; }
    mu_p = mu_p % M32;
    reg[1] = reg[1] - reg[1] % 65536 + mu_p % 65536;
    reg[3] = reg[3] - reg[3] % 65536 + floor(mu_p / 65536);
    fz = (mu_p % 65536) * 65536; fo = cf; fa = 0; fk = 11;
    return;
  }
  mu_x = reg[1] % 256; mu_y = v;
  if (sgn == 1) { mu_x = mu_x - (mu_x > 127) * 256; mu_y = mu_y - (mu_y > 127) * 256; }
  mu_p = mu_x * mu_y;
  if (sgn == 1) { cf = (mu_p < 0 - 128 || mu_p > 127) + 0; } else { cf = (mu_p > 255) + 0; }
  mu_p = mu_p % 65536;
  reg[1] = reg[1] - reg[1] % 65536 + mu_p;
  fz = (mu_p % 256) * 16777216; fo = cf; fa = 0; fk = 19;
}
// 64 / 32 unsigned: (hi:lo) / d -> dv_q, dv_r. dv_ovf = 1 when the quotient needs more than 32 bits
proc udiv64(hi, lo, d) {
  dv_ovf = 0;
  if (hi == 0) { dv_q = floor(lo / d); dv_r = lo - dv_q * d; return; }
  if (hi >= d) { dv_ovf = 1; return; }
  dv_n = hi * 65536 + floor(lo / 65536);
  dv_q1 = floor(dv_n / d);
  dv_n = (dv_n - dv_q1 * d) * 65536 + lo % 65536;
  dv_q = floor(dv_n / d);
  dv_r = dv_n - dv_q * d;
  dv_q = dv_q1 * 65536 + dv_q;
}
proc do_div(v, sz) {
  if (v == 0) { exc(0, 0, 0); return; }
  if (sz == 4) {
    udiv64(reg[3], reg[1], v);
    if (dv_ovf == 1) { exc(0, 0, 0); return; }
    reg[1] = dv_q; reg[3] = dv_r;
    return;
  }
  if (sz == 2) {
    dv_n = (reg[3] % 65536) * 65536 + reg[1] % 65536;
    dv_q = floor(dv_n / v);
    if (dv_q > 65535) { exc(0, 0, 0); return; }
    dv_r = dv_n - dv_q * v;
    reg[1] = reg[1] - reg[1] % 65536 + dv_q; reg[3] = reg[3] - reg[3] % 65536 + dv_r;
    return;
  }
  dv_n = reg[1] % 65536;
  dv_q = floor(dv_n / v);
  if (dv_q > 255) { exc(0, 0, 0); return; }
  dv_r = dv_n - dv_q * v;
  reg[1] = reg[1] - dv_n + dv_r * 256 + dv_q;
}
proc do_idiv(v, sz) {
  if (v == 0) { exc(0, 0, 0); return; }
  if (sz == 4) {
    dv_hi = reg[3]; dv_lo = reg[1]; dv_d = v; dv_neg = 0; dv_rneg = 0;
    if (dv_hi > SMAX) {                 // negate the 64-bit dividend
      dv_rneg = 1; dv_neg = 1;
      dv_lo = (M32 - dv_lo) % M32;
      dv_hi = (UMAX - dv_hi + (dv_lo == 0)) % M32;
    }
    if (dv_d > SMAX) { dv_d = M32 - dv_d; dv_neg = 1 - dv_neg; }
    udiv64(dv_hi, dv_lo, dv_d);
    if (dv_ovf == 1) { exc(0, 0, 0); return; }
    if (dv_neg == 1) { if (dv_q > SIGN) { exc(0, 0, 0); return; } dv_q = (M32 - dv_q) % M32; }
    else { if (dv_q > SMAX) { exc(0, 0, 0); return; } }
    if (dv_rneg == 1) { dv_r = (M32 - dv_r) % M32; }
    reg[1] = dv_q; reg[3] = dv_r;
    return;
  }
  if (sz == 2) {
    dv_n = (reg[3] % 65536) * 65536 + reg[1] % 65536;
    if (dv_n > SMAX) { dv_n = dv_n - M32; }
    dv_d = v - (v > 32767) * 65536;
    dv_q = dv_n / dv_d;
    if (dv_q < 0) { dv_q = ceil(dv_q); } else { dv_q = floor(dv_q); }
    if (dv_q > 32767 || dv_q < 0 - 32768) { exc(0, 0, 0); return; }
    dv_r = dv_n - dv_q * dv_d;
    reg[1] = reg[1] - reg[1] % 65536 + dv_q % 65536; reg[3] = reg[3] - reg[3] % 65536 + dv_r % 65536;
    return;
  }
  dv_n = reg[1] % 65536;
  if (dv_n > 32767) { dv_n = dv_n - 65536; }
  dv_d = v - (v > 127) * 256;
  dv_q = dv_n / dv_d;
  if (dv_q < 0) { dv_q = ceil(dv_q); } else { dv_q = floor(dv_q); }
  if (dv_q > 127 || dv_q < 0 - 128) { exc(0, 0, 0); return; }
  dv_r = dv_n - dv_q * dv_d;
  reg[1] = reg[1] - reg[1] % 65536 + (dv_r % 256) * 256 + dv_q % 256;
}

// ---------------------------------------------------------------- bit tests and scans
var bt_ea = 0, bt_n = 0, bt_v = 0, bt_b = 0, bt_sz = 0, bt_bits = 0, bt_so = 0;

// op: 0 bt 1 bts 2 btr 3 btc. off = bit offset. isreg = 1 when it came from a register (bit-string addressing)
proc bt_op(op, off, isreg) {
  bt_sz = tD[tp]; bt_bits = bt_sz * 8;
  if (tC[tp] > 0) {
    gr_rd(tC[tp] - 1, bt_sz); bt_v = gv; bt_n = POW2[off % bt_bits + 1];
    bt_b = floor(bt_v / bt_n) % 2; cf = bt_b;
    if (op == 1) { if (bt_b == 0) { gr_wr(tC[tp] - 1, bt_sz, bt_v + bt_n); } }
    if (op == 2) { if (bt_b == 1) { gr_wr(tC[tp] - 1, bt_sz, bt_v - bt_n); } }
    if (op == 3) { gr_wr(tC[tp] - 1, bt_sz, bt_v + (1 - 2 * bt_b) * bt_n); }
    return;
  }
  bt_ea = (reg[tB[tp]] + tE[tp]) % M32;
  if (isreg == 1) {
    bt_so = off;
    if (bt_sz == 4) { if (bt_so > SMAX) { bt_so = bt_so - M32; } } else { if (bt_so > 32767) { bt_so = bt_so - 65536; } }
    bt_ea = (bt_ea + floor(bt_so / 8)) % M32;
    bt_n = POW2[bt_so % 8 + 1];
  } else {
    bt_so = off % bt_bits;
    bt_ea = (bt_ea + floor(bt_so / 8)) % M32;
    bt_n = POW2[bt_so % 8 + 1];
  }
  if (op == 0) { rd8(bt_ea); if (flt == 1) { return; } cf = floor(rv / bt_n) % 2; return; }
  rwchk(bt_ea); if (flt == 1) { return; }
  rd8(bt_ea); bt_v = rv;
  bt_b = floor(bt_v / bt_n) % 2; cf = bt_b;
  if (op == 1) { if (bt_b == 0) { wr8(bt_ea, bt_v + bt_n); } }
  if (op == 2) { if (bt_b == 1) { wr8(bt_ea, bt_v - bt_n); } }
  if (op == 3) { wr8(bt_ea, bt_v + (1 - 2 * bt_b) * bt_n); }
}
proc do_bsf(v) {                        // -> rv = index of lowest set bit (v != 0). flags like "test v, v"
  fz = v * gs; cf = 0; fk = gc;
  if (v == 0) { return; }
  bt_v = v; rv = 0;
  if (bt_v % 65536 == 0) { bt_v = bt_v / 65536; rv += 16; }
  if (bt_v % 256 == 0) { bt_v = bt_v / 256; rv += 8; }
  if (bt_v % 16 == 0) { bt_v = bt_v / 16; rv += 4; }
  if (bt_v % 4 == 0) { bt_v = bt_v / 4; rv += 2; }
  if (bt_v % 2 == 0) { rv += 1; }
}
proc do_bsr(v) {
  fz = v * gs; cf = 0; fk = gc;
  if (v == 0) { return; }
  bt_v = v; rv = 0;
  if (bt_v > 65535) { bt_v = floor(bt_v / 65536); rv += 16; }
  if (bt_v > 255) { bt_v = floor(bt_v / 256); rv += 8; }
  if (bt_v > 15) { bt_v = floor(bt_v / 16); rv += 4; }
  if (bt_v > 3) { bt_v = floor(bt_v / 4); rv += 2; }
  if (bt_v > 1) { rv += 1; }
}

// ---------------------------------------------------------------- stack odds and ends
var pp_v = 0, pp_o = 0, pp_i = 0, pp_sz = 0;

proc do_push(v, sz) {
  sp = (reg[5] - sz) % M32;
  if (sz == 4) { wr32(sp, v + 0); } else { wr16(sp, v % 65536); }
  if (flt == 1) { return; }
  reg[5] = sp; spw = 1;
}
// pop into the r/m operand. the address is computed with esp already incremented, the store may fault
proc do_pop_rm() {
  pp_sz = tD[tp]; sp = reg[5];
  if (pp_sz == 4) { rd32(sp); } else { rd16(sp); }
  if (flt == 1) { return; }
  pp_v = rv;
  if (tC[tp] > 0) { reg[5] = (sp + pp_sz) % M32; spw = 1; gr_wr(tC[tp] - 1, pp_sz, pp_v); return; }
  g_ea = reg[tB[tp]] + tE[tp];
  if (tB[tp] == 5) { g_ea += pp_sz; }
  g_ea = g_ea % M32;
  wchk(g_ea); if (flt == 1) { return; }
  wchk((g_ea + pp_sz - 1) % M32); if (flt == 1) { return; }
  reg[5] = (sp + pp_sz) % M32; spw = 1;
  if (pp_sz == 4) { wr32(g_ea, pp_v); } else { wr16(g_ea, pp_v); }
}
proc do_pop_seg(sn, sz) {
  sp = reg[5];
  rd16(sp); if (flt == 1) { return; }
  load_seg(sn, rv); if (flt == 1) { return; }
  reg[5] = (sp + sz) % M32; spw = 1;
}
proc do_pushf(sz) {
  get_eflags();
  do_push(efl, sz);
}
proc do_popf(sz) {
  sp = reg[5];
  if (sz == 4) { rd32(sp); } else { rd16(sp); }
  if (flt == 1) { return; }
  pp_v = rv;
  if (sz == 2) { get_eflags(); pp_v = pp_v + floor(efl / 65536) * 65536; }
  reg[5] = (sp + sz) % M32; spw = 1;
  set_aflags(pp_v); set_sflags(pp_v, cpl);
}
proc do_pusha() {
  sp = (reg[5] - 32) % M32;
  wchk(sp); if (flt == 1) { return; }
  wchk((sp + 31) % M32); if (flt == 1) { return; }
  pp_i = 1; pp_o = 28;
  repeat (8) { wr32((sp + pp_o) % M32, reg[pp_i]); pp_i += 1; pp_o -= 4; }
  reg[5] = sp; spw = 1;
}
proc do_popa() {
  sp = reg[5];
  rd32((sp + 28) % M32); if (flt == 1) { return; }
  rd32(sp); if (flt == 1) { return; }
  pp_i = 8; pp_o = 0;
  repeat (8) { if (pp_i != 5) { rd32((sp + pp_o) % M32); reg[pp_i] = rv; } pp_i -= 1; pp_o += 4; }
  reg[5] = (sp + 32) % M32; spw = 1;
}
proc do_enter(size, level) {
  if (level % 32 > 0) { fatal(21, level); return; }
  sp = (reg[5] - 4) % M32;
  wr32(sp, reg[6]); if (flt == 1) { return; }
  reg[6] = sp;
  reg[5] = (sp - size) % M32; spw = 1;
}
// loop / loope / loopne / jecxz -> ccr = 1 to take the branch
proc do_loop(kind, m16) {
  if (kind == 3) {
    if (m16 > 0) { ccr = (reg[2] % 65536 == 0) + 0; } else { ccr = (reg[2] == 0) + 0; }
    return;
  }
  if (m16 > 0) { pp_v = (reg[2] % 65536 - 1) % 65536; reg[2] = reg[2] - reg[2] % 65536 + pp_v; }
  else { pp_v = (reg[2] - 1) % M32; reg[2] = pp_v; }
  ccr = (pp_v != 0) + 0;
  if (kind == 0) { if (fz == 0) { ccr = 0; } }
  if (kind == 1) { if (fz != 0) { ccr = 0; } }
}

// ---------------------------------------------------------------- far transfers and iret
var ir_eip = 0, ir_cs = 0, ir_efl = 0, ir_esp = 0, ir_ss = 0, ir_rpl = 0, ir_old = 0, ir_i = 0;
list segdpl[6];                         // dpl of what is loaded in es cs ss ds fs gs (3 for a null selector)

proc do_farptr() {                      // offset -> t0, selector -> t1 from the m16:32 at the r/m operand
  g_ea = (reg[tB[tp]] + tE[tp]) % M32;
  if (tD[tp] == 4) { rd32(g_ea); } else { rd16(g_ea); }
  if (flt == 1) { return; }
  t0 = rv;
  rd16((g_ea + tD[tp]) % M32); if (flt == 1) { return; }
  t1 = rv;
}
proc do_lxs(sn) {
  do_farptr(); if (flt == 1) { return; }
  load_seg(sn, t1); if (flt == 1) { return; }
  gr_wr(tA[tp] - 1, tD[tp], t0);
}
proc do_jmpf(sel, off) {
  load_cs(sel, cpl); if (flt == 1) { return; }
  eip = off;
  find_block();
}
proc do_callf(sel, off, ret) {
  sp = (reg[5] - 8) % M32;
  wchk(sp); if (flt == 1) { return; }
  wchk((sp + 7) % M32); if (flt == 1) { return; }
  ir_cs = segsel[2];
  load_cs(sel, cpl); if (flt == 1) { return; }
  wr32((sp + 4) % M32, ir_cs); wr32(sp, ret);
  reg[5] = sp; spw = 1;
  eip = off;
  find_block();
}
proc do_retf(extra) {
  sp = reg[5];
  rd32(sp); if (flt == 1) { return; } ir_eip = rv;
  rd32((sp + 4) % M32); if (flt == 1) { return; } ir_cs = rv % 65536;
  if (ir_cs % 4 != cpl) { fatal(22, ir_cs); return; }
  load_cs(ir_cs, cpl); if (flt == 1) { return; }
  reg[5] = (sp + 8 + extra) % M32; spw = 1;
  eip = ir_eip;
  find_block();
}
proc do_iret() {
  if (fl_nt == 1) { fatal(7, 0); return; }
  sp = reg[5];
  rd32(sp); if (flt == 1) { return; } ir_eip = rv;
  rd32((sp + 4) % M32); if (flt == 1) { return; } ir_cs = rv % 65536;
  rd32((sp + 8) % M32); if (flt == 1) { return; } ir_efl = rv;
  if (floor(ir_efl / 131072) % 2 == 1) { fatal(8, 0); return; }
  ir_rpl = ir_cs % 4;
  if (ir_rpl < cpl) { exc(13, ir_cs - ir_rpl, 1); return; }
  ir_old = cpl;
  if (ir_rpl > cpl) {
    rd32((sp + 12) % M32); if (flt == 1) { return; } ir_esp = rv;
    rd32((sp + 16) % M32); if (flt == 1) { return; } ir_ss = rv % 65536;
    load_cs(ir_cs, ir_rpl); if (flt == 1) { return; }
    load_seg(2, ir_ss); if (flt == 1) { return; }
    reg[5] = ir_esp; spw = 1;
    // data segments the new privilege level may not use are dropped
    seg_drop(0); seg_drop(3); seg_drop(4); seg_drop(5);
  } else {
    load_cs(ir_cs, ir_rpl); if (flt == 1) { return; }
    reg[5] = (sp + 12) % M32; spw = 1;
  }
  set_aflags(ir_efl); set_sflags(ir_efl, ir_old);
  eip = ir_eip;
  find_block();
}
proc seg_drop(sn) {
  if (segsel[sn + 1] > 3) { if (segdpl[sn + 1] < cpl) { segsel[sn + 1] = 0; reg[sn + 10] = 0; segdpl[sn + 1] = 3; } }
}

// ---------------------------------------------------------------- system registers
var sc_old = 0, sc_v = 0;

proc set_cr0(v) {
  sc_old = cr0;
  cr0 = v - (floor(v / 16) % 2) * 16 + 16;        // ET is hardwired
  pg_on = floor(cr0 / SIGN) % 2;
  wp_on = floor(cr0 / 65536) % 2;
  fpu_trap = (floor(cr0 / 4) % 2 + floor(cr0 / 8) % 2 > 0) + 0;
  if (floor(sc_old / SIGN) % 2 != pg_on || floor(sc_old / 65536) % 2 != wp_on || sc_old % 2 != cr0 % 2) { tlb_flush(); }
}
proc get_cr(n) {
  if (n == 0) { rv = cr0; } else { if (n == 2) { rv = cr2; } else { if (n == 3) { rv = cr3; } else { rv = cr4; } } }
}
proc set_cr(n, v) {
  if (n == 0) { set_cr0(v); return; }
  if (n == 2) { cr2 = v; return; }
  if (n == 3) {
    cr3 = v; cr3w = floor(v / 4096) * 1024 + 1;
    if (floor(v / 4096) >= RAM_PAGES) { fatal(12, v); return; }
    tlb_flush();
    return;
  }
  cr4 = v; tlb_flush();
}
// 0f 00: sldt str lldt ltr verr verw
proc do_grp6(sub) {
  if (sub == 0) { g_st(ldt_sel); return; }
  if (sub == 1) { g_st(tr_sel); return; }
  if (sub > 3) { fatal(23, sub); return; }
  if (cpl > 0) { exc(13, 0, 1); return; }
  g_rd(); if (flt == 1) { return; }
  sc_v = gv % 65536;
  if (sub == 2) {
    if (sc_v < 4) { ldt_sel = sc_v; ldt_base = 0; ldt_limit = 0; return; }
    read_desc(sc_v); if (flt == 1) { return; }
    if (ds_ok == 0) { exc(13, sc_v - sc_v % 4, 1); return; }
    desc_base(); ldt_sel = sc_v; ldt_base = dbase; desc_limit(); ldt_limit = rv;
    return;
  }
  read_desc(sc_v); if (flt == 1) { return; }
  if (ds_ok == 0) { exc(13, sc_v - sc_v % 4, 1); return; }
  desc_base(); tr_sel = sc_v; tr_base = dbase; desc_limit(); tr_limit = rv;
}
proc desc_limit() {                     // -> rv
  rv = ds_lo % 65536 + (floor(ds_hi / 65536) % 16) * 65536;
  if (floor(ds_hi / 8388608) % 2 == 1) { rv = rv * 4096 + 4095; }
}
// 0f 01: sgdt sidt lgdt lidt smsw - lmsw
proc do_grp7(sub) {
  if (sub == 4) { g_st(cr0 % 65536); return; }
  if (sub == 6) {
    if (cpl > 0) { exc(13, 0, 1); return; }
    g_rd(); if (flt == 1) { return; }
    sc_v = gv % 16;
    if (cr0 % 2 == 1) { if (sc_v % 2 == 0) { sc_v += 1; } }
    set_cr0(cr0 - cr0 % 16 + sc_v);
    return;
  }
  if (sub > 3 || tC[tp] > 0) { exc(6, 0, 0); return; }
  g_ea = (reg[tB[tp]] + tE[tp]) % M32;
  if (sub < 2) {
    wchk(g_ea); if (flt == 1) { return; }
    wchk((g_ea + 5) % M32); if (flt == 1) { return; }
    if (sub == 0) { wr16(g_ea, gdt_limit); wr32((g_ea + 2) % M32, gdt_base); }
    else { wr16(g_ea, idt_limit); wr32((g_ea + 2) % M32, idt_base); }
    return;
  }
  if (cpl > 0) { exc(13, 0, 1); return; }
  rd16(g_ea); if (flt == 1) { return; } sc_v = rv;
  rd32((g_ea + 2) % M32); if (flt == 1) { return; }
  if (tD[tp] == 2) { rv = rv % 16777216; }
  if (sub == 2) { gdt_limit = sc_v; gdt_base = rv; } else { idt_limit = sc_v; idt_base = rv; }
}
proc do_cpuid() {
  if (reg[1] == 0) { reg[1] = 1; reg[4] = 1970169159; reg[3] = 1231384169; reg[2] = 1818588270; }   // "GenuineIntel"
  else { reg[1] = ${c1.eax}; reg[4] = ${c1.ebx}; reg[2] = ${c1.ecx}; reg[3] = ${c1.edx}; }
}
proc do_rdtsc() {
  reg[1] = icount % M32; reg[3] = floor(icount / M32) % M32;
}

// ---------------------------------------------------------------- string instructions
// seg = reg[] index of the source segment base, sz = element size, rep: 0 none, 1 rep/repe, 2 repne.
// a rep runs at most rep_chunk elements per call; ccr = 1 on return means "not done, run me again".
var rep_chunk = ${cfg.repChunk || 4096};
var st_d = 0, st_k = 0, st_src = 0, st_dst = 0, st_si = 0, st_di = 0, st_v = 0, st_cnt = 0, st_a = 0, st_b = 0, st_n = 0, st_hit = 0;

proc str_ld(lin, sz) { if (sz == 4) { rd32(lin); } else { if (sz == 2) { rd16(lin); } else { rd8(lin); } } }
proc str_st(lin, sz, v) { if (sz == 4) { wr32(lin, v); } else { if (sz == 2) { wr16(lin, v); } else { wr8(lin, v); } } }
// how many whole dwords can be moved forward from st_src / to st_dst without leaving either page (0 = use the slow lane)
proc str_span(bytes, usesrc) {
  st_k = 0;
  if (fl_df == 1 || rep_chunk < 2) { return; }
  if (st_dst % 4 > 0 || bytes < 4) { return; }
  st_k = floor(bytes / 4);
  st_n = (4096 - st_dst % 4096) / 4;
  if (st_n < st_k) { st_k = st_n; }
  if (usesrc == 1) {
    if (st_src % 4 > 0) { st_k = 0; return; }
    st_n = (4096 - st_src % 4096) / 4;
    if (st_n < st_k) { st_k = st_n; }
  }
  if (st_cnt < st_k) { st_k = st_cnt; }
}
proc str_movs(seg, sz, rep) {
  ccr = 0;
  st_d = sz * (1 - 2 * fl_df);
  if (rep == 0) {
    str_ld((reg[7] + reg[seg]) % M32, sz); if (flt == 1) { return; }
    str_st(reg[8], sz, rv); if (flt == 1) { return; }
    reg[7] = (reg[7] + st_d) % M32; reg[8] = (reg[8] + st_d) % M32;
    return;
  }
  st_cnt = rep_chunk;
  until (reg[2] == 0 || st_cnt < 1) {
    st_src = (reg[7] + reg[seg]) % M32; st_dst = reg[8];
    str_span(reg[2] * sz, 1);
    if (st_k > 0) {
      q = tlbR[floor(st_src / 4096) + tlbOff];
      if (q == 0) { tlb_fill(st_src, 0); if (flt == 1) { return; } }
      st_si = q + st_src / 4;
      q = tlbW[floor(st_dst / 4096) + tlbOff];
      if (q == 0) { tlb_fill(st_dst, 1); if (flt == 1) { return; } }
      st_di = q + st_dst / 4;
      // (eight words per turn of the loop; in order, as an overlapping copy expects)
      repeat (floor(st_k / 8)) {
        memw[st_di] = memw[st_si]; memw[st_di + 1] = memw[st_si + 1]; memw[st_di + 2] = memw[st_si + 2]; memw[st_di + 3] = memw[st_si + 3];
        memw[st_di + 4] = memw[st_si + 4]; memw[st_di + 5] = memw[st_si + 5]; memw[st_di + 6] = memw[st_si + 6]; memw[st_di + 7] = memw[st_si + 7];
        st_si += 8; st_di += 8;
      }
      repeat (st_k % 8) { memw[st_di] = memw[st_si]; st_si += 1; st_di += 1; }
      reg[7] = (reg[7] + st_k * 4) % M32; reg[8] = (reg[8] + st_k * 4) % M32;
      reg[2] = reg[2] - st_k * 4 / sz; st_cnt -= st_k;
    } else {
      str_ld(st_src, sz); if (flt == 1) { return; }
      str_st(st_dst, sz, rv); if (flt == 1) { return; }
      reg[7] = (reg[7] + st_d) % M32; reg[8] = (reg[8] + st_d) % M32;
      reg[2] = reg[2] - 1; st_cnt -= 1;
    }
  }
  if (reg[2] > 0) { ccr = 1; }
}
proc str_stos(seg, sz, rep) {
  ccr = 0;
  st_d = sz * (1 - 2 * fl_df);
  gr_rd(0, sz); st_v = gv;
  if (rep == 0) {
    str_st(reg[8], sz, st_v); if (flt == 1) { return; }
    reg[8] = (reg[8] + st_d) % M32;
    return;
  }
  if (sz == 1) { st_a = st_v * 16843009; } else { if (sz == 2) { st_a = st_v * 65537; } else { st_a = st_v; } }
  st_cnt = rep_chunk;
  until (reg[2] == 0 || st_cnt < 1) {
    st_dst = reg[8];
    str_span(reg[2] * sz, 0);
    if (st_k > 0) {
      q = tlbW[floor(st_dst / 4096) + tlbOff];
      if (q == 0) { tlb_fill(st_dst, 1); if (flt == 1) { return; } }
      st_di = q + st_dst / 4;
      repeat (floor(st_k / 8)) {
        memw[st_di] = st_a; memw[st_di + 1] = st_a; memw[st_di + 2] = st_a; memw[st_di + 3] = st_a;
        memw[st_di + 4] = st_a; memw[st_di + 5] = st_a; memw[st_di + 6] = st_a; memw[st_di + 7] = st_a;
        st_di += 8;
      }
      repeat (st_k % 8) { memw[st_di] = st_a; st_di += 1; }
      reg[8] = (reg[8] + st_k * 4) % M32;
      reg[2] = reg[2] - st_k * 4 / sz; st_cnt -= st_k;
    } else {
      str_st(st_dst, sz, st_v); if (flt == 1) { return; }
      reg[8] = (reg[8] + st_d) % M32;
      reg[2] = reg[2] - 1; st_cnt -= 1;
    }
  }
  if (reg[2] > 0) { ccr = 1; }
}
proc str_lods(seg, sz, rep) {
  ccr = 0;
  st_d = sz * (1 - 2 * fl_df);
  if (rep == 0) {
    str_ld((reg[7] + reg[seg]) % M32, sz); if (flt == 1) { return; }
    gr_wr(0, sz, rv);
    reg[7] = (reg[7] + st_d) % M32;
    return;
  }
  st_cnt = rep_chunk;
  until (reg[2] == 0 || st_cnt < 1) {
    str_ld((reg[7] + reg[seg]) % M32, sz); if (flt == 1) { return; }
    gr_wr(0, sz, rv);
    reg[7] = (reg[7] + st_d) % M32;
    reg[2] = reg[2] - 1; st_cnt -= 1;
  }
  if (reg[2] > 0) { ccr = 1; }
}
// compare st_a with st_b like "cmp a, b" at the size chosen by g_size
proc str_cmpflags() {
  fz = st_a - st_b; cf = (fz < 0) + 0; fz = (fz % gm) * gs; fx = st_a * gs; fy = st_b * gs; fk = 2 + gc;
}
proc str_cmps(seg, sz, rep) {
  ccr = 0;
  g_size(sz);
  st_d = sz * (1 - 2 * fl_df);
  if (rep == 0) {
    str_ld((reg[7] + reg[seg]) % M32, sz); if (flt == 1) { return; } st_a = rv;
    str_ld(reg[8], sz); if (flt == 1) { return; } st_b = rv;
    str_cmpflags();
    reg[7] = (reg[7] + st_d) % M32; reg[8] = (reg[8] + st_d) % M32;
    return;
  }
  st_cnt = rep_chunk;
  until (reg[2] == 0 || st_cnt < 1) {
    str_ld((reg[7] + reg[seg]) % M32, sz); if (flt == 1) { return; } st_a = rv;
    str_ld(reg[8], sz); if (flt == 1) { return; } st_b = rv;
    str_cmpflags();
    reg[7] = (reg[7] + st_d) % M32; reg[8] = (reg[8] + st_d) % M32;
    reg[2] = reg[2] - 1; st_cnt -= 1;
    if (rep == 1) { if (fz != 0) { return; } } else { if (fz == 0) { return; } }
  }
  if (reg[2] > 0) { ccr = 1; }
}
proc str_scas(seg, sz, rep) {
  ccr = 0;
  g_size(sz);
  st_d = sz * (1 - 2 * fl_df);
  gr_rd(0, sz); st_a = gv;
  if (rep == 0) {
    str_ld(reg[8], sz); if (flt == 1) { return; } st_b = rv;
    str_cmpflags();
    reg[8] = (reg[8] + st_d) % M32;
    return;
  }
  st_cnt = rep_chunk;
  until (reg[2] == 0 || st_cnt < 1) {
    st_dst = reg[8];
    if (sz == 1 && fl_df == 0 && rep_chunk > 1) {
      // byte scan forward (strlen / memchr): walk one page at a time through a single translation
      q = tlbR[floor(st_dst / 4096) + tlbOff];
      if (q == 0) { tlb_fill(st_dst, 0); if (flt == 1) { return; } }
      st_n = 4096 - st_dst % 4096;
      if (reg[2] < st_n) { st_n = reg[2]; }
      if (st_cnt < st_n) { st_n = st_cnt; }
      st_k = 0; st_hit = 0;
      until (st_k == st_n || st_hit == 1) {
        st_b = floor(itemf(memw, q + st_dst / 4) / POW256[st_dst % 4 + 1]) % 256;
        st_dst += 1; st_k += 1;
        if (rep == 1) { if (st_b != st_a) { st_hit = 1; } } else { if (st_b == st_a) { st_hit = 1; } }
      }
      reg[8] = st_dst % M32; reg[2] = reg[2] - st_k; st_cnt -= st_k;
      str_cmpflags();
      if (st_hit == 1) { return; }
    } else {
      str_ld(st_dst, sz); if (flt == 1) { return; } st_b = rv;
      str_cmpflags();
      reg[8] = (reg[8] + st_d) % M32;
      reg[2] = reg[2] - 1; st_cnt -= 1;
      if (rep == 1) { if (fz != 0) { return; } } else { if (fz == 0) { return; } }
    }
  }
  if (reg[2] > 0) { ccr = 1; }
}
`;
};
