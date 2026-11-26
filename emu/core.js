'use strict';
// i486SX core, part 1: machine state, memory + paging, lazy flags, segments, exceptions, the block cache.
// Everything here is SBL source text (see sbl/sbl.js), assembled by emu/build.js.

module.exports = function core(cfg) {
  const RAM = cfg.ramMB * 1048576;
  const M = require('./mem')(cfg);
  const { TR, TW, paged } = M;
  const cold = M.coldLists(RAM / 4096);
  // pick the cold list a page lives in (pl_k) with a little tree of comparisons, and run "leaf" on it
  const coldTree = (lo, hi, leaf) => {
    if (hi - lo === 1) return leaf(cold[lo].name);
    const mid = (lo + hi) >> 1;
    return `if (pl_k < ${mid}) { ${coldTree(lo, mid, leaf)} } else { ${coldTree(mid, hi, leaf)} }`;
  };
  return `
const M32 = 4294967296;
const SIGN = 2147483648;
const SMAX = 2147483647;
const UMAX = 4294967295;
const RAM_BYTES = ${RAM};
const RAM_PAGES = RAM_BYTES / 4096;
const DUMMY_PAGE = RAM_PAGES;          // physical accesses outside ram land in this scratch page
const MEM_WORDS = RAM_BYTES / 4 + 1024;
const TLB_HALF = ${paged ? 1024 : 1048576};              // ${paged ? 'one table slot per 4 MB of linear addresses' : 'one entry per linear page'}; second half is the cpl 3 view
const BN = ${cfg.blockSlots};          // block cache slots
const TN = ${cfg.traceSize};           // trace entries
const TR_STOP = 1;                     // trace entry that just stops the machine
const TR_SCRATCH = 2;                  // trace entries for uncached (page-straddling) instructions
const TR_FIRST = 16;
const TR_LIMIT = TN - 160;

// ---------------------------------------------------------------- cpu state
// reg: 1 eax 2 ecx 3 edx 4 ebx 5 esp 6 ebp 7 esi 8 edi | 9 always zero | 10..15 segment bases es cs ss ds fs gs | 16 ea temp
list reg[16];
list segsel[6];                        // es cs ss ds fs gs
list dreg[8];
var eip = 0, cpl = 0, tlbOff = 1;
// lazy flags. ZF = (fz == 0), CF = cf. fk = kind + 4 * carry_in + 8 * sizecode:
//   kind 0 logic (OF = AF = 0), 1 add-like, 2 sub-like (OF/AF derive from fx, fy, fz), 3 OF/AF explicit in fo / fa
//   carry_in marks adc / sbb, where fz is not simply fx +/- fy (so "fk == 2" really means a plain cmp/sub)
//   fk == 64: everything but ZF/CF is explicit (xs = SF, xp = PF, fo, fa), as loaded by popf / iret / sahf
// fx / fy / fz are normalised so the operand's sign bit sits at bit 31 whatever the operand size.
var fz = 1, fk = 0, fx = 0, fy = 0, cf = 0, fo = 0, fa = 0, xs = 0, xp = 0;
var fl_if = 0, fl_df = 0, fl_iopl = 0, fl_nt = 0, fl_ac = 0, fl_id = 0, fl_tf = 0;
var cr0 = 0, cr2 = 0, cr3 = 0, cr4 = 0, cr3w = 1, pg_on = 0, wp_on = 0, fpu_trap = 0;
var gdt_base = 0, gdt_limit = 0, idt_base = 0, idt_limit = 0;
var ldt_sel = 0, ldt_base = 0, ldt_limit = 0, tr_sel = 0, tr_base = 0, tr_limit = 0;
var halted = 0, halt_code = 0, halt_info = 0;
var flt = 0, fetching = 0, exc_depth = 0, nexc = 0;

// ---------------------------------------------------------------- memory
${paged ? `// paged model (see emu/mem.js): memw is ${M.NF} page frames, ram itself sits in the cold lists
const NF = ${M.NF};
const CPP = ${M.CPP};                        // physical pages per cold list
list memw[NF * 1024];
${cold.map((c) => `list ${c.name}[${c.pages * 1024}];`).join(' ')}
list pgf[RAM_PAGES + 2];               // physical page -> the frame it is in (1..NF), 0 = cold
list fr_pp[NF];                        // frame -> physical page + 1, 0 = free
list fr_ref[NF];                       // touched since the clock hand last came by
list fr_dirty[NF];                     // has been mapped for writing since it was loaded
list fr_e[NF * 8]; list fr_n[NF]; list fr_g[NF];   // the tlb entries that point into a frame: up to 8 slots in tlbP, how many (9 = lost count), as of which tlbgen
// the tlb is two levels deep: tlb1R / tlb1W say where the table for a 4 MB stretch of linear addresses starts
// in tlbP (1 = no table yet: that is the first table, which stays empty); an entry is "tlb entry" as before
list tlb1R[TLB_HALF * 2];
list tlb1W[TLB_HALF * 2];
list tlbP[NF * 1024];
list ctT[8192]; list ctP[8192];        // linear page -> physical page for code lookups (tagged like the jump cache)` : `list memw[MEM_WORDS];
list tlbR[TLB_HALF * 2];
list tlbW[TLB_HALF * 2];`}
list tlbRU[0];
list tlbWU[0];
list codepg[RAM_PAGES + 2];            // 1 = some cached block was decoded from this physical page
list POW2 = data("pow2");              // POW2[n + 1] = 2^n, n = 0..32
list POW256 = [1, 256, 65536, 16777216];
${cfg.lazy ? 'list AND8[65536];' : 'list AND8 = data("and8");'}              // AND8[a * 256 + b + 1] = a & b
list PARITY = data("parity");          // PARITY[b + 1] = 1 if b has an even number of set bits
list FSH = [1, 65536, 16777216];       // flag normalisation shift by size code

var q = 0, ea = 0, mi = 0, sh = 0, mw = 0, rv = 0, sp = 0;
var a = 0, b = 0, r = 0, t0 = 0, t1 = 0, t2 = 0, t3 = 0, n = 0, bw = 0;
var epoch = 1, ebase = 4294967296;     // ebase = (epoch % 2^20) * 2^32, the tag of the jump cache
list jcKey[8192]; list jcTp[8192];      // eip -> trace entry for computed jumps: [1..4096] supervisor, [4097..8192] cpl 3
var jc = 0, jcOff = 1, jc_i = 0;
proc new_epoch() {
  epoch += 1;
  ebase = (epoch % 1048576) * 4294967296;
  if (ebase == 0) { jc_i = 1; repeat (8192) { jcKey[jc_i] = 0; jc_i += 1; } }      // tags are about to repeat
}

// ---- the stack window (see handlers.js)
var spw = 1;
proc sp_sync() {
  spw = 1;
  if (reg[5] % 4 == 0) {
    q = ${TW('reg[5]')};
    if (q != 0) { spw = q + reg[5] / 4; }
  }
}
// ---- tlb
var tf_vp = 0, tf_pp = 0, tf_a = 0, tf_b = 0, tf_pde = 0, tf_pte = 0, tf_n = 0, tf_i = 0, tf_err = 0;

${paged ? `var tlbPn = 1025, tf_t = 0, tf_e = 0, tf_f = 0, tf_ok = 0, ta_i = 0, td_i = 0;
var tlbgen = 1;                         // goes up whenever the whole tlb is emptied: the frames' entry lists are void then
proc tlb_flush() {
  tlbgen += 1;
  tf_i = 1;
  repeat (len(tlbRU)) { tlbP[tlbRU[tf_i]] = 0; tf_i += 1; }
  clear(tlbRU);
  tlbw_flush();
  new_epoch();
}
proc tlbw_flush() {
  spw = 1;
  tf_i = 1;
  repeat (len(tlbWU)) { tlbP[tlbWU[tf_i]] = 0; tf_i += 1; }
  clear(tlbWU);
}
// forget every cached translation, for our own reasons. nothing changed for the guest, so the epoch stays; and
// the stack window stays too: its frame is never given away (see pg_in)
proc tlb_drop() {
  tlbgen += 1;
  td_i = 1;
  repeat (len(tlbRU)) { tlbP[tlbRU[td_i]] = 0; td_i += 1; }
  clear(tlbRU);
  td_i = 1;
  repeat (len(tlbWU)) { tlbP[tlbWU[td_i]] = 0; td_i += 1; }
  clear(tlbWU);
}
proc tlb_invlpg(lin) {
  tf_vp = floor(lin / 4096);
  tf_i = floor(tf_vp / 1024) + 1; tf_e = tf_vp % 1024;
  tlbP[tlb1R[tf_i] + tf_e] = 0; tlbP[tlb1R[tf_i + TLB_HALF] + tf_e] = 0;
  tlbP[tlb1W[tf_i] + tf_e] = 0; tlbP[tlb1W[tf_i + TLB_HALF] + tf_e] = 0;
  new_epoch(); spw = 1;
}
// a fresh second-level table -> tf_t. when they are all taken, start over with none
proc tlb_alloc() {
  if (tlbPn > NF * 1024 - 1023) {
    tlb_drop(); spw = 1;
    ta_i = 1; repeat (TLB_HALF * 2) { tlb1R[ta_i] = 1; tlb1W[ta_i] = 1; ta_i += 1; }
    tlbPn = 1025;
  }
  tf_t = tlbPn; tlbPn += 1024;
}

// ---- page frames
var hand = 0, nevict = 0, npgin = 0, npgout = 0, pin_a = 0, pin_b = 0, pin_c = 0, pin_d = 0, pin_s = 0;
var pi_f = 0, pi_old = 0, pl_k = 0, pl_c = 0, pl_h = 0, pm_f = 0, pm_h = 0;
// copy physical page pp from its cold list into frame f (0-based) / back
proc pg_load(pp, f) {
  pl_k = floor(pp / CPP); pl_c = (pp % CPP) * 1024 + 1; pl_h = f * 1024 + 1;
  ${coldTree(0, cold.length, (c) => `repeat (1024) { memw[pl_h] = ${c}[pl_c]; pl_h += 1; pl_c += 1; }`)}
}
proc pg_store(pp, f) {
  pl_k = floor(pp / CPP); pl_c = (pp % CPP) * 1024 + 1; pl_h = f * 1024 + 1;
  ${coldTree(0, cold.length, (c) => `repeat (1024) { ${c}[pl_c] = memw[pl_h]; pl_h += 1; pl_c += 1; }`)}
}
// take the tlb entries that point into frame f away again
var fi_k = 0;
proc fr_inval(f) {
  if (fr_g[f] == tlbgen) {
    if (fr_n[f] > 8) { tlb_drop(); }
    else { fi_k = (f - 1) * 8; repeat (fr_n[f]) { fi_k += 1; tlbP[fr_e[fi_k]] = 0; } }
  }
  fr_n[f] = 0; fr_g[f] = tlbgen;
}
// bring physical page pp into a frame -> pi_f (1..NF). the frame is found clock-fashion: the hand skips frames
// that were touched since it last came by, taking their tlb entries away so that the next touch shows up again
// ("touched" is only ever noticed when the tlb is filled). a frame it finds untouched has no entries left and
// can go. never the frames somebody may still hold an address in, though: the last four the tlb handed out, and
// the one under the stack window.
proc pg_in(pp) {
  if (spw == 1) { pin_s = 0; } else { pin_s = floor((spw - 1) / 1024) + 1; }
  pi_f = 0;
  until (pi_f > 0) {
    hand = hand % NF + 1;
    if (fr_ref[hand] == 1) { fr_ref[hand] = 0; fr_inval(hand); }
    else { if (hand != pin_a && hand != pin_b && hand != pin_c && hand != pin_d && hand != pin_s) { pi_f = hand; } }
  }
  pi_old = fr_pp[pi_f];
  if (pi_old > 0) {
    if (fr_dirty[pi_f] == 1) { pg_store(pi_old - 1, pi_f - 1); npgout += 1; }
    pgf[pi_old] = 0;
    nevict += 1;
  }
  pg_load(pp, pi_f - 1);
  pgf[pp + 1] = pi_f; fr_pp[pi_f] = pp + 1; fr_dirty[pi_f] = 0;
  npgin += 1;
}
// physical page pp, for the page walk -> pm_f (its frame), pm_h (memw index of its first word)
proc pm_get(pp) {
  pm_f = pgf[pp + 1];
  if (pm_f == 0) { pg_in(pp); pm_f = pi_f; }
  fr_ref[pm_f] = 1;
  pm_h = (pm_f - 1) * 1024 + 1;
}
// the page walk for linear page tf_vp (address lin): tf_ok = 1 and tf_pp = physical page, or tf_ok = 0 after
// delivering #PF (flt = 1). sets accessed / dirty bits like the real thing.
// (delivering the fault walks pages itself, for the stack it pushes to: tf_ok is set again afterwards)
proc walk(lin, wr) {
  tf_ok = 0;
  if (pg_on == 0) { tf_pp = tf_vp; tf_ok = 1; return; }
  pm_get(floor(cr3 / 4096));
  tf_a = pm_h + floor(tf_vp / 1024);
  tf_pde = memw[tf_a];
  tf_err = wr * 2 + (cpl == 3) * 4;
  if (tf_pde % 2 == 0) { page_fault(lin, tf_err); tf_ok = 0; return; }
  // the directory entry counts as accessed as soon as the walk goes through it, even if the walk then faults
  if (floor(tf_pde / 32) % 2 == 0) { tf_pde += 32; memw[tf_a] = tf_pde; fr_dirty[pm_f] = 1; }
  tf_b = floor(tf_pde / 4096);
  if (tf_b >= RAM_PAGES) { fatal(11, tf_pde); tf_ok = 0; return; }
  pm_get(tf_b);
  tf_b = pm_h + tf_vp % 1024;
  tf_pte = memw[tf_b];
  if (tf_pte % 2 == 0) { page_fault(lin, tf_err); tf_ok = 0; return; }
  if (cpl == 3) {
    if ((floor(tf_pde / 4) % 2) * (floor(tf_pte / 4) % 2) == 0) { page_fault(lin, tf_err + 1); tf_ok = 0; return; }
  }
  if (wr == 1) {
    if ((floor(tf_pde / 2) % 2) * (floor(tf_pte / 2) % 2) == 0) {
      if (cpl == 3 || wp_on == 1) { page_fault(lin, tf_err + 1); tf_ok = 0; return; }
    }
  }
  tf_n = tf_pte;
  if (floor(tf_pte / 32) % 2 == 0) { tf_n += 32; }
  if (wr == 1) { if (floor(tf_pte / 64) % 2 == 0) { tf_n += 64; } }
  if (tf_n != tf_pte) { memw[tf_b] = tf_n; fr_dirty[pm_f] = 1; }
  tf_pp = floor(tf_pte / 4096);
  tf_ok = 1;
}
// translate linear address lin for reading (wr = 0) or writing (wr = 1) at the current privilege and cache it.
// success: q = tlb entry.  failure: #PF has been delivered and flt = 1.
// entry format: memw index = entry + lin / 4, i.e. entry = (frame - lin_page) * 1024 + 1  (never 0, so 0 = miss)
proc tlb_fill(lin, wr) {
  tf_vp = floor(lin / 4096);
  walk(lin, wr);
  if (tf_ok == 0) { return; }
  if (tf_pp >= RAM_PAGES) { tf_pp = DUMMY_PAGE; }
  tf_f = pgf[tf_pp + 1];
  if (tf_f == 0) { pg_in(tf_pp); tf_f = pi_f; }
  fr_ref[tf_f] = 1;
  pin_d = pin_c; pin_c = pin_b; pin_b = pin_a; pin_a = tf_f;
  q = (tf_f - 1 - tf_vp) * 1024 + 1;
  tf_i = floor(tf_vp / 1024) + tlbOff;
  if (wr == 1) {
    fr_dirty[tf_f] = 1;
    if (codepg[tf_pp + 1] == 1) { invalidate_page(tf_pp); }
    tf_t = tlb1W[tf_i];
    if (tf_t == 1) { tlb_alloc(); tlb1W[tf_i] = tf_t; }
    tf_e = tf_t + tf_vp % 1024;
    tlbP[tf_e] = q; push(tlbWU, tf_e);
    if (len(tlbWU) > 150000) { tlbw_flush(); tlbP[tf_e] = q; push(tlbWU, tf_e); }
  } else {
    tf_t = tlb1R[tf_i];
    if (tf_t == 1) { tlb_alloc(); tlb1R[tf_i] = tf_t; }
    tf_e = tf_t + tf_vp % 1024;
    tlbP[tf_e] = q; push(tlbRU, tf_e);
    if (len(tlbRU) > 150000) { tlb_flush(); tlbP[tf_e] = q; push(tlbRU, tf_e); }
  }
  // remember the entry with its frame
  if (fr_g[tf_f] != tlbgen) { fr_g[tf_f] = tlbgen; fr_n[tf_f] = 0; }
  if (fr_n[tf_f] < 8) { fr_n[tf_f] += 1; fr_e[(tf_f - 1) * 8 + fr_n[tf_f]] = tf_e; } else { fr_n[tf_f] = 9; }
}

` : `proc tlb_flush() {
  tf_i = 1;
  repeat (len(tlbRU)) { tlbR[tlbRU[tf_i]] = 0; tf_i += 1; }
  clear(tlbRU);
  tlbw_flush();
  new_epoch();
}
proc tlbw_flush() {
  spw = 1;
  tf_i = 1;
  repeat (len(tlbWU)) { tlbW[tlbWU[tf_i]] = 0; tf_i += 1; }
  clear(tlbWU);
}
proc tlb_invlpg(lin) {
  tf_vp = floor(lin / 4096);
  tlbR[tf_vp + 1] = 0; tlbR[tf_vp + 1 + TLB_HALF] = 0;
  tlbW[tf_vp + 1] = 0; tlbW[tf_vp + 1 + TLB_HALF] = 0;
  new_epoch(); spw = 1;
}

// translate linear address lin for reading (wr = 0) or writing (wr = 1) at the current privilege and cache it.
// success: q = tlb entry.  failure: #PF has been delivered and flt = 1.
// entry format: word index = entry + lin / 4, i.e. entry = (phys_page - lin_page) * 1024 + 1  (never 0, so 0 = miss)
proc tlb_fill(lin, wr) {
  tf_vp = floor(lin / 4096);
  if (pg_on == 0) { tf_pp = tf_vp; }
  else {
    tf_a = cr3w + floor(tf_vp / 1024);
    tf_pde = memw[tf_a];
    tf_err = wr * 2 + (cpl == 3) * 4;
    if (tf_pde % 2 == 0) { page_fault(lin, tf_err); return; }
    // the directory entry counts as accessed as soon as the walk goes through it, even if the walk then faults
    if (floor(tf_pde / 32) % 2 == 0) { tf_pde += 32; memw[tf_a] = tf_pde; }
    tf_b = floor(tf_pde / 4096);
    if (tf_b >= RAM_PAGES) { fatal(11, tf_pde); return; }
    tf_b = tf_b * 1024 + 1 + tf_vp % 1024;
    tf_pte = memw[tf_b];
    if (tf_pte % 2 == 0) { page_fault(lin, tf_err); return; }
    if (cpl == 3) {
      if ((floor(tf_pde / 4) % 2) * (floor(tf_pte / 4) % 2) == 0) { page_fault(lin, tf_err + 1); return; }
    }
    if (wr == 1) {
      if ((floor(tf_pde / 2) % 2) * (floor(tf_pte / 2) % 2) == 0) {
        if (cpl == 3 || wp_on == 1) { page_fault(lin, tf_err + 1); return; }
      }
    }
    tf_n = tf_pte;
    if (floor(tf_pte / 32) % 2 == 0) { tf_n += 32; }
    if (wr == 1) { if (floor(tf_pte / 64) % 2 == 0) { tf_n += 64; } }
    if (tf_n != tf_pte) { memw[tf_b] = tf_n; }
    tf_pp = floor(tf_pte / 4096);
  }
  if (tf_pp >= RAM_PAGES) { tf_pp = DUMMY_PAGE; }
  q = (tf_pp - tf_vp) * 1024 + 1;
  if (wr == 1) {
    if (codepg[tf_pp + 1] == 1) { invalidate_page(tf_pp); }
    tlbW[tf_vp + tlbOff] = q; push(tlbWU, tf_vp + tlbOff);
    if (len(tlbWU) > 150000) { tlbw_flush(); tlbW[tf_vp + tlbOff] = q; push(tlbWU, tf_vp + tlbOff); }
  } else {
    tlbR[tf_vp + tlbOff] = q; push(tlbRU, tf_vp + tlbOff);
    if (len(tlbRU) > 150000) { tlb_flush(); tlbR[tf_vp + tlbOff] = q; push(tlbRU, tf_vp + tlbOff); }
  }
}

`}proc page_fault(lin, err) {
  cr2 = lin;
  exc(14, err, 1);
}

// ---- slow-path memory access (procs). fast paths are inlined into the handlers by emu/handlers.js.
// all of these either succeed (flt stays 0) or deliver a fault and set flt = 1.
var m_a = 0, m_v = 0, m_u = 0, m_i = 0, m_w = 0, m_s = 0;

proc rd8(lin) {                         // -> rv
  q = ${TR('lin')};
  if (q == 0) { tlb_fill(lin, 0); if (flt == 1) { return; } }
  rv = floor(itemf(memw, q + lin / 4) / POW256[lin % 4 + 1]) % 256;
}
proc wr8(lin, v) {
  q = ${TW('lin')};
  if (q == 0) { tlb_fill(lin, 1); if (flt == 1) { return; } }
  m_i = q + floor(lin / 4); m_s = POW256[lin % 4 + 1]; m_w = memw[m_i];
  memw[m_i] = m_w + (v - floor(m_w / m_s) % 256) * m_s;
}
proc rd16(lin) {                        // -> rv
  if (lin % 4 == 3) {
    rd8(lin); if (flt == 1) { return; } m_v = rv;
    rd8((lin + 1) % M32); if (flt == 1) { return; }
    rv = m_v + rv * 256;
    return;
  }
  q = ${TR('lin')};
  if (q == 0) { tlb_fill(lin, 0); if (flt == 1) { return; } }
  rv = floor(itemf(memw, q + lin / 4) / POW256[lin % 4 + 1]) % 65536;
}
proc wr16(lin, v) {
  if (lin % 4 == 3) {
    wchk(lin); if (flt == 1) { return; }
    wchk((lin + 1) % M32); if (flt == 1) { return; }
    wr8(lin, v % 256); wr8((lin + 1) % M32, floor(v / 256));
    return;
  }
  q = ${TW('lin')};
  if (q == 0) { tlb_fill(lin, 1); if (flt == 1) { return; } }
  m_i = q + floor(lin / 4); m_s = POW256[lin % 4 + 1]; m_w = memw[m_i];
  memw[m_i] = m_w + (v - floor(m_w / m_s) % 65536) * m_s;
}
proc rd32(lin) {                        // -> rv
  if (lin % 4 == 0) {
    q = ${TR('lin')};
    if (q == 0) { tlb_fill(lin, 0); if (flt == 1) { return; } }
    rv = memw[q + lin / 4];
    return;
  }
  rd32u(lin);
}
// unaligned 32-bit read: two words when both halves sit in one page, bytes otherwise
proc rd32u(lin) {
  m_a = lin % 4;
  if (lin % 4096 < 4093) {
    q = ${TR('lin')};
    if (q == 0) { tlb_fill(lin, 0); if (flt == 1) { return; } }
    m_i = q + floor(lin / 4); m_s = POW256[m_a + 1];
    rv = floor(memw[m_i] / m_s) + (memw[m_i + 1] % m_s) * POW256[5 - m_a];
    return;
  }
  rd16(lin); if (flt == 1) { return; } m_u = rv;      // (rd16 uses m_v itself)
  rd16((lin + 2) % M32); if (flt == 1) { return; }
  rv = m_u + rv * 65536;
}
proc wr32(lin, v) {
  if (lin % 4 == 0) {
    q = ${TW('lin')};
    if (q == 0) { tlb_fill(lin, 1); if (flt == 1) { return; } }
    memw[q + lin / 4] = v;
    return;
  }
  wr32u(lin, v);
}
proc wr32u(lin, v) {
  m_a = lin % 4;
  if (lin % 4096 < 4093) {
    q = ${TW('lin')};
    if (q == 0) { tlb_fill(lin, 1); if (flt == 1) { return; } }
    m_i = q + floor(lin / 4); m_s = POW256[m_a + 1]; m_v = POW256[5 - m_a];
    memw[m_i] = memw[m_i] % m_s + (v % m_v) * m_s;
    m_w = memw[m_i + 1];
    memw[m_i + 1] = m_w - m_w % m_s + floor(v / m_v);
    return;
  }
  wchk(lin); if (flt == 1) { return; }
  wchk((lin + 3) % M32); if (flt == 1) { return; }
  wr16(lin, v % 65536); wr16((lin + 2) % M32, floor(v / 65536));
}
// make sure lin is writable (so a multi-part write cannot fault half way)
proc wchk(lin) {
  q = ${TW('lin')};
  if (q == 0) { tlb_fill(lin, 1); }
}
// a read-modify-write instruction touches its operand as a read first and then as a write (that is what qemu
// does, and it is visible: a not-present page faults as a read, a copy-on-write page gets its accessed bit set
// before the write faults). leaves q = the write translation.
proc rwchk(lin) {
  q = ${TR('lin')};
  if (q == 0) { tlb_fill(lin, 0); if (flt == 1) { return; } }
  q = ${TW('lin')};
  if (q == 0) { tlb_fill(lin, 1); }
}
// read-modify-write helpers for unaligned operands: verify writability, then read
proc rmw32u(lin) {
  rwchk(lin); if (flt == 1) { return; }
  rwchk((lin + 3) % M32); if (flt == 1) { return; }
  rd32u(lin);
}
proc rmw16(lin) {
  rwchk(lin); if (flt == 1) { return; }
  rwchk((lin + 1) % M32); if (flt == 1) { return; }
  rd16(lin);
}

// supervisor-privilege access used for descriptor tables, the tss and stack switches
var s_cpl = 0, s_off = 0;
proc sys_rd32(lin) {
  s_cpl = cpl; s_off = tlbOff; cpl = 0; tlbOff = 1;
  rd32(lin);
  cpl = s_cpl; tlbOff = s_off;
}

// ---- 32-bit and via the byte table (cold-path form; hot handlers inline the same thing)
proc and32(x, y) {                      // -> bw
  bw = AND8[(x % 256) * 256 + y % 256 + 1]
     + AND8[(floor(x / 256) % 256) * 256 + floor(y / 256) % 256 + 1] * 256
     + AND8[(floor(x / 65536) % 256) * 256 + floor(y / 65536) % 256 + 1] * 65536
     + AND8[floor(x / 16777216) * 256 + floor(y / 16777216) + 1] * 16777216;
}

// ---------------------------------------------------------------- flags
var ec_k = 0, fl_k = 0, fl_s = 0, fl_sa = 0, fl_sb = 0, fl_sr = 0, efl = 0, ccr = 0;

// make OF and AF explicit (fo / fa), keeping ZF SF PF lazy
proc flags_ofaf() {
  if (fk == 64) { return; }
  fl_k = fk % 4;
  if (fl_k == 3) { return; }
  if (fl_k == 0) { fo = 0; fa = 0; }
  else {
    fl_s = FSH[floor(fk / 8) + 1] * 16;
    fl_sa = (fx > SMAX); fl_sb = (fy > SMAX); fl_sr = (fz > SMAX);
    if (fl_k == 1) { fo = (fl_sa == fl_sb) * (fl_sr != fl_sa); }
    else { fo = (fl_sa != fl_sb) * (fl_sr != fl_sa); }
    fa = (floor(fx / fl_s) + floor(fy / fl_s) + floor(fz / fl_s)) % 2;
  }
  fk = fk - fl_k + 3;
}
proc get_eflags() {                     // -> efl
  flags_ofaf();
  if (fk == 64) { fl_sr = xs; fl_s = xp; }
  else { fl_sr = (fz > SMAX); fl_s = PARITY[floor(fz / FSH[floor(fk / 8) + 1]) % 256 + 1]; }
  efl = cf + 2 + fl_s * 4 + fa * 16 + (fz == 0) * 64 + fl_sr * 128 + fl_tf * 256 + fl_if * 512 + fl_df * 1024
      + fo * 2048 + fl_iopl * 4096 + fl_nt * 16384 + fl_ac * 262144 + fl_id * 2097152;
}
// load CF PF AF ZF SF OF from an eflags image
proc set_aflags(v) {
  cf = v % 2; xp = floor(v / 4) % 2; fa = floor(v / 16) % 2; xs = floor(v / 128) % 2; fo = floor(v / 2048) % 2;
  fz = 1 - floor(v / 64) % 2;
  fk = 64;
}
// load the system flags the way POPF / IRET do at privilege level "pl" (the cpl before the instruction)
proc set_sflags(v, pl) {
  fl_tf = floor(v / 256) % 2; fl_df = floor(v / 1024) % 2; fl_nt = floor(v / 16384) % 2;
  fl_ac = floor(v / 262144) % 2; fl_id = floor(v / 2097152) % 2;
  if (pl <= fl_iopl) { fl_if = floor(v / 512) % 2; }
  if (pl == 0) { fl_iopl = floor(v / 4096) % 4; }
}
// condition code cc (0..15, x86 encoding) -> ccr = 0 / 1
proc eval_cc(cc) {
  ec_k = floor(cc / 2);
  if (ec_k == 2) { ccr = (fz == 0); }
  else { if (ec_k == 1) { ccr = (cf == 1); }
  else { if (ec_k == 3) { ccr = (cf == 1 || fz == 0); }
  else { if (ec_k == 4) { if (fk == 64) { ccr = xs; } else { ccr = (fz > SMAX); } }
  else { if (ec_k == 5) { if (fk == 64) { ccr = xp; } else { ccr = PARITY[floor(fz / FSH[floor(fk / 8) + 1]) % 256 + 1]; } }
  else { if (ec_k == 0) { flags_ofaf(); ccr = fo; }
  else {
    // l / le: SF != OF
    if (fk % 8 == 2) { ccr = ((fx + SIGN) % M32 < (fy + SIGN) % M32); }
    else {
      flags_ofaf();
      if (fk == 64) { ccr = (xs != fo); } else { ccr = ((fz > SMAX) != fo); }
    }
    if (ec_k == 7) { if (fz == 0) { ccr = 1; } }
  } } } } } }
  if (cc % 2 == 1) { ccr = 1 - ccr; }
}

// ---------------------------------------------------------------- segments
var ds_lo = 0, ds_hi = 0, ds_ok = 0, dbase = 0, ds_b = 0, ds_l = 0, ds_o = 0;

proc read_desc(sel) {                   // -> ds_lo, ds_hi, ds_ok
  ds_ok = 0;
  if (sel < 4) { return; }
  if (floor(sel / 4) % 2 == 1) { ds_b = ldt_base; ds_l = ldt_limit; } else { ds_b = gdt_base; ds_l = gdt_limit; }
  ds_o = sel - sel % 8;
  if (ds_o + 7 > ds_l) { return; }
  sys_rd32((ds_b + ds_o) % M32); if (flt == 1) { return; } ds_lo = rv;
  sys_rd32((ds_b + ds_o + 4) % M32); if (flt == 1) { return; } ds_hi = rv;
  ds_ok = 1;
}
proc desc_base() { dbase = floor(ds_lo / 65536) + (ds_hi % 256) * 65536 + floor(ds_hi / 16777216) * 16777216; }

// load a data/stack segment register (sn: 0 es, 2 ss, 3 ds, 4 fs, 5 gs)
proc load_seg(sn, sel) {
  if (sel < 4) {
    if (sn == 2) { exc(13, 0, 1); return; }
    segsel[sn + 1] = sel; reg[sn + 10] = 0; segdpl[sn + 1] = 3;
    return;
  }
  read_desc(sel); if (flt == 1) { return; }
  if (ds_ok == 0) { exc(13, sel - sel % 4, 1); return; }
  if (floor(ds_hi / 32768) % 2 == 0) { if (sn == 2) { exc(12, sel - sel % 4, 1); } else { exc(11, sel - sel % 4, 1); } return; }
  desc_base();
  if (sn < 4) { if (dbase != 0) { fatal(3, sel); return; } }      // es / ss / ds must stay flat
  segsel[sn + 1] = sel; reg[sn + 10] = dbase; segdpl[sn + 1] = floor(ds_hi / 8192) % 4;
}
// load cs for a far transfer; new privilege = npl
proc load_cs(sel, npl) {
  read_desc(sel); if (flt == 1) { return; }
  if (ds_ok == 0) { exc(13, sel - sel % 4, 1); return; }
  if (floor(ds_hi / 32768) % 2 == 0) { exc(11, sel - sel % 4, 1); return; }
  desc_base();
  if (dbase != 0) { fatal(3, sel); return; }
  if (floor(ds_hi / 4194304) % 2 == 0) { fatal(4, sel); return; }   // 16-bit code segment
  segsel[2] = sel - sel % 4 + npl; reg[11] = 0;
  set_cpl(npl);
}
proc set_cpl(v) {
  cpl = v; spw = 1;
  if (v == 3) { tlbOff = 1 + TLB_HALF; jcOff = 4097; } else { tlbOff = 1; jcOff = 1; }
}

// ---------------------------------------------------------------- exceptions and interrupts
var di_rf = 0, di_lo = 0, di_hi = 0, di_type = 0, di_sel = 0, di_off = 0, di_npl = 0, di_efl = 0, di_cs = 0, di_ss = 0, di_esp = 0, di_cpl = 0, di_nesp = 0, di_nss = 0;

proc fatal(code, info) {
  halted = 2; halt_code = code; halt_info = info; tp = TR_STOP; flt = 1;
}
proc kpush(v) {
  sp = (sp - 4) % M32;
  wr32(sp, v);
}
// a fault raised by the instruction at tp (or, while fetching, at eip)
proc exc(vec, err, haserr) {
  if (exc_depth > 0) { fatal(1, vec); return; }
  if (fetching == 0) { ${cfg.fuse && cfg.fuse.patterns && cfg.fuse.patterns.length ? 'if (ISUNIT[tH[tp]] == 1) { eip = xeip; } else { eip = tI[tp]; }' : 'eip = tI[tp];'} }
  nexc += 1;
  exc_depth = 1;
  flt = 0;
  do_interrupt(vec, 0, haserr, err, eip);
  exc_depth = 0;
  flt = 1;
}
// deliver vector vec through the idt. soft = 1 for INT n (dpl is checked). ret = eip to push.
// on return eip / tp point at the handler.
proc do_interrupt(vec, soft, haserr, err, ret) {
  if (vec * 8 + 7 > idt_limit) { fatal(2, vec); return; }
  sys_rd32((idt_base + vec * 8) % M32); if (flt == 1) { fatal(2, vec); return; } di_lo = rv;
  sys_rd32((idt_base + vec * 8 + 4) % M32); if (flt == 1) { fatal(2, vec); return; } di_hi = rv;
  di_type = floor(di_hi / 256) % 32;
  if (soft == 1) { if (floor(di_hi / 8192) % 4 < cpl) { exc(13, vec * 8 + 2, 1); return; } }
  if (floor(di_hi / 32768) % 2 == 0) { exc(11, vec * 8 + 2, 1); return; }
  if (di_type != 14) { if (di_type != 15) { fatal(5, vec); return; } }
  di_sel = floor(di_lo / 65536); di_off = di_lo % 65536 + floor(di_hi / 65536) * 65536;
  read_desc(di_sel); if (flt == 1) { fatal(2, vec); return; }
  if (ds_ok == 0) { fatal(6, vec); return; }
  di_npl = floor(ds_hi / 8192) % 4;
  get_eflags(); di_efl = efl;
  // everything that is not an INT n (and not #DB #BP #OF #DF #MC) pushes an eflags image with RF set, as qemu does
  if (soft == 0) { if (vec != 1 && vec != 3 && vec != 4 && vec != 8 && vec != 18) { di_efl += 65536; } }
  di_cs = segsel[2]; di_ss = segsel[3]; di_esp = reg[5]; di_cpl = cpl;
  if (di_npl < cpl) {
    sys_rd32((tr_base + 4 + di_npl * 8) % M32); if (flt == 1) { fatal(2, vec); return; } di_nesp = rv;
    sys_rd32((tr_base + 8 + di_npl * 8) % M32); if (flt == 1) { fatal(2, vec); return; } di_nss = rv % 65536;
    set_cpl(di_npl);
    load_seg(2, di_nss); if (flt == 1) { fatal(2, vec); return; }
    sp = di_nesp;
    kpush(di_ss); if (flt == 1) { fatal(2, vec); return; }
    kpush(di_esp); if (flt == 1) { fatal(2, vec); return; }
  } else { sp = reg[5]; }
  kpush(di_efl); if (flt == 1) { fatal(2, vec); return; }
  kpush(di_cs); if (flt == 1) { fatal(2, vec); return; }
  kpush(ret); if (flt == 1) { fatal(2, vec); return; }
  if (haserr == 1) { kpush(err); if (flt == 1) { fatal(2, vec); return; } }
  reg[5] = sp; spw = 1;
  segsel[2] = di_sel - di_sel % 4 + di_npl; reg[11] = 0;
  fl_tf = 0; fl_nt = 0;
  if (di_type == 14) { fl_if = 0; }
  eip = di_off;
  find_block();
}

// ---------------------------------------------------------------- block cache
// decoded code lives in the trace lists tH (handler id), tA..tF (operands), tI (eip of the instruction).
// bkTag/bkTp map (physical address, linear page) -> first trace entry of a block.
list bkTag[BN];
list bkTp[BN];
// (their initial contents are the seed: blocks decoded at build time, see decode.js)
${cfg.lazy ? 'list tH[TN]; list tA[TN]; list tB[TN]; list tC[TN]; list tD[TN]; list tE[TN]; list tF[TN]; list tI[TN];' : `list tH = data("tH"); list tA = data("tA"); list tB = data("tB"); list tC = data("tC"); list tD = data("tD");
list tE = data("tE"); list tF = data("tF"); list tI = data("tI");`}
${cfg.fuse && cfg.fuse.patterns && cfg.fuse.patterns.length ? 'list tO = data("tO");' : ''}
const SEED_END = ${cfg.seedEnd || 16};  // first trace entry that is free for decoding
var tp = TR_STOP, tnext = SEED_END, tw = 0;
var vp = 0, pk = 0, ci = 0, h = 0, stp = 0, chain_ok = 0;
var iv_i = 0, iv_p = 0, iv_c = 0;
var nblocks = 0, ninval = 0, nflush = 0;

// forget every block decoded from physical page pp. a block's tag carries the generation its page had when it
// was decoded, so bumping the generation is all it takes (the kernel patches its own text a lot while booting,
// and hunting down the blocks one by one cost 49000 scratch blocks a time). after 255 bumps the numbers would
// repeat: then the page's blocks really are looked up and removed.
list pgGen[RAM_PAGES + 2];
const GENMUL = 35184372088832;           // 2^45: above the 25 bits of pk and the 20 bits of vp
proc invalidate_page(pp) {
  codepg[pp + 1] = 0;
  pgGen[pp + 1] += 1;
  if (pgGen[pp + 1] > 255) {
    pgGen[pp + 1] = 0;
    iv_p = pp * 4096 + 4;               // pk of the first byte of the page
    repeat (4096) {
      iv_c = iv_p % BN + 1;
      if (bkTag[iv_c] % 33554432 == iv_p) { bkTag[iv_c] = 0; }
      iv_p += 1;
    }
  }
  new_epoch(); chain_ok = 0; ninval += 1;
}
proc flush_blocks() {
  iv_i = 1;
  repeat (BN) { bkTag[iv_i] = 0; iv_i += 1; }
  tnext = SEED_END; new_epoch(); chain_ok = 0; nflush += 1;
}

// set tp to the trace of the code at eip, decoding it if needed. faults while fetching are delivered here,
// so on return tp always points at something executable.
${paged ? `var fb_i = 0, fb_pp = 0;
proc find_block() {
  chain_ok = 1;
  vp = floor(eip / 4096);
  // code is looked up by where it sits in ram, and that does not need the page in a frame: a table of its own
  fb_i = vp % 1024 + jcOff;
  if (ctT[fb_i] == vp + ebase) { fb_pp = ctP[fb_i]; }
  else {
    fetching = 1; flt = 0;
    tf_vp = vp; walk(eip, 0);
    fetching = 0;
    // #PF on the fetch: it has been delivered and tp already sits on the handler (or on TR_STOP)
    if (tf_ok == 0) { flt = 0; chain_ok = 0; return; }
    if (tf_pp >= RAM_PAGES) { tf_pp = DUMMY_PAGE; }
    fb_pp = tf_pp;
    ctT[fb_i] = vp + ebase; ctP[fb_i] = fb_pp;
  }
  pk = fb_pp * 4096 + eip % 4096 + 4;
  ci = pk % BN + 1;
  if (bkTag[ci] == pk + vp * 33554432 + pgGen[fb_pp + 1] * GENMUL) { tp = bkTp[ci]; return; }
  decode_block();
}
` : `proc find_block() {
  chain_ok = 1;
  vp = floor(eip / 4096);
  q = tlbR[vp + tlbOff];
  if (q == 0) {
    fetching = 1; flt = 0;
    tlb_fill(eip, 0);
    fetching = 0;
    // #PF on the fetch: it has been delivered and tp already sits on the handler (or on TR_STOP)
    if (flt == 1) { flt = 0; chain_ok = 0; return; }
  }
  pk = eip + 4 * q;
  ci = pk % BN + 1;
  if (bkTag[ci] == pk + vp * 33554432 + pgGen[floor((pk - 4) / 4096) + 1] * GENMUL) { tp = bkTp[ci]; return; }
  decode_block();
}
`}`;
};
