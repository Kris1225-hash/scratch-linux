'use strict';
// the rest of the pc: port i/o, 8259 pic pair, 8254 pit, 16550 uart, cmos clock, and the machine loop.

module.exports = function devices(cfg) {
  const js = cfg.target === 'js';
  const M = require('./mem')(cfg);
  const cold = M.coldLists(cfg.ramMB * 256);
  // host clock for the cmos rtc: scratch has "current [year]" blocks, the js build asks its host
  const rtc = (k, sb) => js ? `hostf("rtc", ${k})` : `current("${sb}")`;
  return `
const VT_PER_INSN = ${cfg.vtPerInsn};    // pit ticks (1/1193182 s) of virtual time per executed instruction
var vt = 0, icount = 0, irq_out = 0;
var slice_n = ${cfg.sliceInsns};

// ---------------------------------------------------------------- 8259 interrupt controllers (1 = master, 2 = slave)
list pic_irr[2]; list pic_isr[2]; list pic_imr[2]; list pic_base[2]; list pic_init[2]; list pic_ris[2]; list pic_icw4[2];
var pi_n = 0, pi_bit = 0, pi_i = 0, pi_v = 0, pi_m = 0, pi_p = 0, pi_done = 0;

// highest-priority unmasked request that is not blocked by one in service -> pi_n (negative: none)
proc pic_pending(p) {
  pi_n = 0 - 1; pi_bit = 1; pi_i = 0;
  repeat (8) {
    if (pi_n == 0 - 1) {
      if (floor(pic_isr[p] / pi_bit) % 2 == 1) { pi_n = 0 - 2; }
      else { if (floor(pic_irr[p] / pi_bit) % 2 == 1) { if (floor(pic_imr[p] / pi_bit) % 2 == 0) { pi_n = pi_i; } } }
    }
    pi_bit = pi_bit * 2; pi_i += 1;
  }
}
proc pic_update() {
  pic_pending(2);
  pi_v = pic_irr[1];
  if (pi_n >= 0) { if (floor(pi_v / 4) % 2 == 0) { pic_irr[1] = pi_v + 4; } }
  else { if (floor(pi_v / 4) % 2 == 1) { pic_irr[1] = pi_v - 4; } }
  pic_pending(1);
  irq_out = (pi_n >= 0) + 0;
}
proc pic_raise(irq) {
  if (irq < 8) { pi_p = 1; pi_v = POW2[irq + 1]; } else { pi_p = 2; pi_v = POW2[irq - 7]; }
  if (floor(pic_irr[pi_p] / pi_v) % 2 == 0) { pic_irr[pi_p] = pic_irr[pi_p] + pi_v; }
  pic_update();
}
proc pic_lower(irq) {
  if (irq < 8) { pi_p = 1; pi_v = POW2[irq + 1]; } else { pi_p = 2; pi_v = POW2[irq - 7]; }
  if (floor(pic_irr[pi_p] / pi_v) % 2 == 1) { pic_irr[pi_p] = pic_irr[pi_p] - pi_v; }
  pic_update();
}
// interrupt acknowledge: -> rv = vector
proc pic_ack() {
  pic_pending(1);
  if (pi_n < 0) { rv = pic_base[1] + 7; return; }
  pi_m = pi_n;
  if (pi_m == 2) {
    pic_pending(2);
    if (pi_n < 0) { rv = pic_base[2] + 7; }
    else { pi_v = POW2[pi_n + 1]; pic_isr[2] = pic_isr[2] + pi_v; pic_irr[2] = pic_irr[2] - pi_v; rv = pic_base[2] + pi_n; }
    pic_isr[1] = pic_isr[1] + 4;
  } else {
    pi_v = POW2[pi_m + 1]; pic_isr[1] = pic_isr[1] + pi_v; pic_irr[1] = pic_irr[1] - pi_v; rv = pic_base[1] + pi_m;
  }
  pic_update();
}
proc pic_write(p, a0, v) {
  if (a0 == 0) {
    if (floor(v / 16) % 2 == 1) {                 // icw1: start the init sequence
      pic_init[p] = 2; pic_imr[p] = 0; pic_isr[p] = 0; pic_irr[p] = 0; pic_ris[p] = 0; pic_icw4[p] = v % 2;
    } else { if (floor(v / 8) % 2 == 1) {         // ocw3
      if (floor(v / 2) % 2 == 1) { pic_ris[p] = v % 2; }
    } else {                                      // ocw2
      pi_m = floor(v / 32);
      if (pi_m == 1) {                            // non-specific eoi
        pi_bit = 1; pi_done = 0;
        repeat (8) {
          if (pi_done == 0) { if (floor(pic_isr[p] / pi_bit) % 2 == 1) { pic_isr[p] = pic_isr[p] - pi_bit; pi_done = 1; } }
          pi_bit = pi_bit * 2;
        }
      }
      if (pi_m == 3) {                            // specific eoi
        pi_bit = POW2[v % 8 + 1];
        if (floor(pic_isr[p] / pi_bit) % 2 == 1) { pic_isr[p] = pic_isr[p] - pi_bit; }
      }
    } }
  } else {
    if (pic_init[p] == 2) { pic_base[p] = v - v % 8; pic_init[p] = 3; }
    else { if (pic_init[p] == 3) { if (pic_icw4[p] == 1) { pic_init[p] = 4; } else { pic_init[p] = 0; } }
    else { if (pic_init[p] == 4) { pic_init[p] = 0; } else { pic_imr[p] = v; } } }
  }
  pic_update();
}
proc pic_read(p, a0) {                 // -> rv
  if (a0 == 1) { rv = pic_imr[p]; } else { if (pic_ris[p] == 1) { rv = pic_isr[p]; } else { rv = pic_irr[p]; } }
}

// ---------------------------------------------------------------- 8254 timer, channel 0 only
var pit_reload = 65536, pit_next = 0, pit_on = 0, pit_rw = 3, pit_mode = 3, pit_wlo = 0, pit_wst = 0, pit_lat = 0, pit_latv = 0, pit_rst = 0, pit_c = 0;

proc pit_count() {                     // -> pit_c = current counter value
  pit_c = floor(pit_next - vt);
  if (pit_c < 1) { pit_c = 1; }
  if (pit_c > pit_reload) { pit_c = pit_reload; }
  pit_c = pit_c % 65536;
}
proc pit_write(port, v) {
  if (port == 67) {
    if (floor(v / 64) > 0) { return; }
    if (floor(v / 16) % 4 == 0) { pit_count(); pit_latv = pit_c; pit_lat = 2; return; }
    pit_rw = floor(v / 16) % 4; pit_mode = floor(v / 2) % 8; pit_wst = 0;
    return;
  }
  if (port != 64) { return; }
  if (pit_rw == 3) {
    if (pit_wst == 0) { pit_wlo = v; pit_wst = 1; return; }
    pit_c = pit_wlo + v * 256; pit_wst = 0;
  } else { if (pit_rw == 1) { pit_c = v; } else { pit_c = v * 256; } }
  if (pit_c == 0) { pit_c = 65536; }
  pit_reload = pit_c; pit_next = vt + pit_c;
  if (pit_mode % 4 == 2 || pit_mode % 4 == 3) { pit_on = 1; } else { pit_on = 2; }    // periodic or one-shot
}
proc pit_read(port) {                  // -> rv
  rv = 255;
  if (port != 64) { return; }
  if (pit_lat > 0) {
    if (pit_lat == 2) { rv = pit_latv % 256; } else { rv = floor(pit_latv / 256); }
    pit_lat -= 1;
    return;
  }
  pit_count();
  if (pit_rst == 0) { rv = pit_c % 256; pit_rst = 1; } else { rv = floor(pit_c / 256); pit_rst = 0; }
}
proc pit_fire() {
  pic_lower(0); pic_raise(0);
  if (pit_on == 1) { pit_next += pit_reload; if (pit_next <= vt) { pit_next = vt + pit_reload; } } else { pit_on = 0; }
}

// ---------------------------------------------------------------- 16550 uart at 0x3f8, irq 4
list uart_rx[0];                       // bytes typed at the machine
list uart_tx[0];                       // bytes the machine printed (the terminal drains this)
var u_ier = 0, u_lcr = 0, u_mcr = 0, u_scr = 0, u_dll = 1, u_dlm = 0, u_fcr = 0, u_thre = 0, u_irq = 0, u_lvl = 0, u_old = 0;

proc uart_update() {
  u_lvl = 0;
  if (u_ier % 2 == 1) { if (len(uart_rx) > 0) { u_lvl = 1; } }
  if (floor(u_ier / 2) % 2 == 1) { if (u_thre == 1) { u_lvl = 1; } }
  if (u_lvl != u_irq) { u_irq = u_lvl; if (u_lvl == 1) { pic_raise(4); } else { pic_lower(4); } }
}
proc uart_write(off, v) {
  if (off == 0) {
    if (floor(u_lcr / 128) % 2 == 1) { u_dll = v; return; }
    if (floor(u_mcr / 16) % 2 == 1) { push(uart_rx, v); } else { push(uart_tx, v); }
    u_thre = 1; uart_update();
    return;
  }
  if (off == 1) {
    if (floor(u_lcr / 128) % 2 == 1) { u_dlm = v; return; }
    u_old = u_ier; u_ier = v % 16;
    if (floor(u_ier / 2) % 2 == 1) { if (floor(u_old / 2) % 2 == 0) { u_thre = 1; } }
    uart_update();
    return;
  }
  if (off == 2) { u_fcr = v; if (floor(v / 2) % 2 == 1) { clear(uart_rx); } uart_update(); return; }
  if (off == 3) { u_lcr = v; return; }
  if (off == 4) { u_mcr = v % 32; return; }
  if (off == 7) { u_scr = v; }
}
proc uart_read(off) {                  // -> rv
  rv = 0;
  if (off == 0) {
    if (floor(u_lcr / 128) % 2 == 1) { rv = u_dll; return; }
    if (len(uart_rx) > 0) { rv = uart_rx[1]; del(uart_rx, 1); }
    uart_update();
    return;
  }
  if (off == 1) { if (floor(u_lcr / 128) % 2 == 1) { rv = u_dlm; } else { rv = u_ier; } return; }
  if (off == 2) {
    rv = 1;
    if (u_ier % 2 == 1 && len(uart_rx) > 0) { rv = 4; }
    else { if (floor(u_ier / 2) % 2 == 1) { if (u_thre == 1) { rv = 2; u_thre = 0; uart_update(); } } }
    if (u_fcr % 2 == 1) { rv += 192; }
    return;
  }
  if (off == 3) { rv = u_lcr; return; }
  if (off == 4) { rv = u_mcr; return; }
  if (off == 5) { rv = 96 + (len(uart_rx) > 0); return; }
  if (off == 6) {
    if (floor(u_mcr / 16) % 2 == 1) { rv = (floor(u_mcr / 2) % 2) * 16 + (u_mcr % 2) * 32 + (floor(u_mcr / 4) % 2) * 64 + (floor(u_mcr / 8) % 2) * 128; }
    else { rv = 176; }
    return;
  }
  rv = u_scr;
}

// ---------------------------------------------------------------- cmos real time clock (reads the host's clock)
var cmos_idx = 0, cm_v = 0;
proc cmos_read() {                     // -> rv
  cm_v = 0 - 1; rv = 0;
  if (cmos_idx == 0) { cm_v = ${rtc(0, 'second')}; }
  if (cmos_idx == 2) { cm_v = ${rtc(1, 'minute')}; }
  if (cmos_idx == 4) { cm_v = ${rtc(2, 'hour')}; }
  if (cmos_idx == 6) { cm_v = ${rtc(3, 'dayofweek')}; }
  if (cmos_idx == 7) { cm_v = ${rtc(4, 'date')}; }
  if (cmos_idx == 8) { cm_v = ${rtc(5, 'month')}; }
  if (cmos_idx == 9) { cm_v = ${rtc(6, 'year')} % 100; }
  if (cmos_idx == 50) { cm_v = floor(${rtc(6, 'year')} / 100); }
  if (cm_v >= 0) { rv = floor(cm_v / 10) * 16 + cm_v % 10; return; }
  if (cmos_idx == 10) { rv = 38; }
  if (cmos_idx == 11) { rv = 2; }
  if (cmos_idx == 13) { rv = 128; }
}

// ---------------------------------------------------------------- port space
var po_v = 0;
proc port_in8(port) {                  // -> rv
  if (port >= 1016 && port <= 1023) { uart_read(port - 1016); return; }
  if (port == 32 || port == 33) { pic_read(1, port - 32); return; }
  if (port == 160 || port == 161) { pic_read(2, port - 160); return; }
  if (port >= 64 && port <= 67) { pit_read(port); return; }
  if (port == 113) { cmos_read(); return; }
  if (port == 146) { rv = 2; return; }
  if (port == 96 || port == 97 || port == 100) { rv = 0; return; }
  rv = 255;
}
proc port_in(port, sz) {               // -> rv
  ${cfg.lockstep ? 'rv = hostf("io_in", port, sz); return;' : ''}
  port_in8(port);
  if (sz == 1) { return; }
  po_v = rv; port_in8(port + 1); po_v += rv * 256;
  if (sz == 4) { port_in8(port + 2); po_v += rv * 65536; port_in8(port + 3); po_v += rv * 16777216; }
  rv = po_v;
}
proc port_out8(port, v) {
  if (port >= 1016 && port <= 1023) { uart_write(port - 1016, v); return; }
  if (port == 32 || port == 33) { pic_write(1, port - 32, v); return; }
  if (port == 160 || port == 161) { pic_write(2, port - 160, v); return; }
  if (port >= 64 && port <= 67) { pit_write(port, v); return; }
  if (port == 112) { cmos_idx = v % 128; return; }
  if (port == 100) { if (v == 254) { fatal(30, 0); } return; }          // keyboard controller reset line
  if (port == 3321) { if (v % 16 > 5) { fatal(30, 1); } }
}
proc port_out(port, sz, v) {
  ${cfg.lockstep ? 'host("io_out", port, sz, v); if (port >= 1016 && port <= 1023) { if (sz == 1) { uart_write(port - 1016, v); } } return;' : ''}
  port_out8(port, v % 256);
  if (sz == 1) { return; }
  port_out8(port + 1, floor(v / 256) % 256);
  if (sz == 4) { port_out8(port + 2, floor(v / 65536) % 256); port_out8(port + 3, floor(v / 16777216)); }
}

// ---------------------------------------------------------------- the machine loop
// one slice: run some instructions, move virtual time, raise and deliver interrupts
proc machine_step() {
  if (halted == 0) {
    flt = 0;
    run(slice_n);
    icount += slice_n; vt += slice_n * VT_PER_INSN;
  }
  machine_poll();
}
// the device side of a slice: timer, uart, interrupt delivery
proc machine_poll() {
  if (pit_on > 0) { if (vt >= pit_next) { pit_fire(); } }
  if (len(uart_rx) > 0) { if (u_irq == 0) { uart_update(); } }
  if (irq_out == 1) { if (fl_if == 1) { if (halted < 2) {
    halted = 0;
    pic_ack();
    eip = tI[tp]; flt = 0;
    do_interrupt(rv, 0, 0, 0, eip);
    flt = 0;
  } } }
  if (halted == 1) { if (fl_if == 0) { halted = 2; halt_code = 40; } }     // hlt with interrupts off: the os is done
}
// nothing to run until the next timer event: jump virtual time forward (the caller decides how fast that is allowed)
proc idle_skip() {
  if (pit_on > 0) { if (pit_next > vt) { vt = pit_next; } } else { halted = 2; halt_code = 41; }
}

// ---------------------------------------------------------------- power-on
${cfg.packed ? '' : `list img = data("img");                // memory image words
list imgdir = data("imgdir");          // [first word index, count] pairs describing where img goes`}
var rs_i = 0, rs_j = 0, rs_k = 0, rs_n = 0;${M.paged ? ' var rs_p = 0, rs_m = 0;' : ''}
const BOOT_EIP = ${cfg.bootEip};
const BOOT_ESI = ${cfg.bootEsi};

var mem_dirty = 0;                      // the project file ships with its memory zeroed: the first power-on can skip that
proc reset() {
${M.paged ? `  // nothing is in a frame, no tables
  tlb_flush();
  rs_i = 1; repeat (TLB_HALF * 2) { tlb1R[rs_i] = 1; tlb1W[rs_i] = 1; rs_i += 1; }
  tlbPn = 1025;
  rs_i = 1; repeat (NF) { fr_pp[rs_i] = 0; fr_ref[rs_i] = 0; fr_dirty[rs_i] = 0; fr_n[rs_i] = 0; fr_g[rs_i] = 0; rs_i += 1; }
  rs_i = 1; repeat (RAM_PAGES + 2) { pgf[rs_i] = 0; rs_i += 1; }
  hand = 0; nevict = 0; npgin = 0; npgout = 0; pin_a = 0; pin_b = 0; pin_c = 0; pin_d = 0;
${cfg.packed ? '  // (ram was zeroed and the kernel unpacked into it before we got here: see emu/unpack.js)' : `  if (mem_dirty == 1) {
${cold.map((c) => `    rs_i = 1; repeat (${c.pages * 1024}) { ${c.name}[rs_i] = 0; rs_i += 1; }`).join('\n')}
  }
  mem_dirty = 1;
  // the image goes into the cold lists a page at a time, through frame 0
  rs_j = 1; rs_k = 1;
  repeat (len(imgdir) / 2) {
    rs_p = (imgdir[rs_j] - 1) / 1024; rs_n = imgdir[rs_j + 1]; rs_j += 2;
    until (rs_n < 1) {
      rs_m = 1;
      repeat (1024) { if (rs_n > 0) { memw[rs_m] = img[rs_k]; rs_k += 1; rs_n -= 1; } else { memw[rs_m] = 0; } rs_m += 1; }
      pg_store(rs_p, 0); rs_p += 1;
    }
  }`}` : `  if (mem_dirty == 1) { rs_i = 1; repeat (MEM_WORDS) { memw[rs_i] = 0; rs_i += 1; } }
  mem_dirty = 1;
  rs_j = 1; rs_k = 1;
  repeat (len(imgdir) / 2) {
    rs_i = imgdir[rs_j]; rs_n = imgdir[rs_j + 1]; rs_j += 2;
    repeat (rs_n) { memw[rs_i] = img[rs_k]; rs_i += 1; rs_k += 1; }
  }
  tlb_flush();`}
  rs_i = 1; repeat (BN) { bkTag[rs_i] = 0; rs_i += 1; }
  rs_i = 1; repeat (RAM_PAGES + 2) { codepg[rs_i] = 0; pgGen[rs_i] = 0; rs_i += 1; }
  // (epoch only ever grows, also across resets: the seed entries keep whatever chain caches the last run left
  // in them, and those must never look valid again)
  tnext = SEED_END; new_epoch(); d_unc = 0; nblocks = 0; ninval = 0; nflush = 0; n_fused = 0; n_seeded = 0;
  tH[TR_STOP] = HMAP[H_STOP]; tI[TR_STOP] = 0;
  rs_i = 1; repeat (16) { reg[rs_i] = 0; rs_i += 1; }
  spw = 1;
  rs_i = 1; repeat (6) { segsel[rs_i] = 24; segdpl[rs_i] = 0; rs_i += 1; }
  segsel[2] = 16;
  rs_i = 1; repeat (8) { dreg[rs_i] = 0; rs_i += 1; }
  reg[7] = BOOT_ESI;
  eip = BOOT_EIP; cpl = 0; tlbOff = 1; jcOff = 1;
  fz = 1; fk = 0; fx = 0; fy = 0; cf = 0; fo = 0; fa = 0; xs = 0; xp = 0;
  fl_if = 0; fl_df = 0; fl_iopl = 0; fl_nt = 0; fl_ac = 0; fl_id = 0; fl_tf = 0;
  cr0 = 17; cr2 = 0; cr3 = 0; cr4 = 0; cr3w = 1; pg_on = 0; wp_on = 0; fpu_trap = 0;
  gdt_base = 0; gdt_limit = 0; idt_base = 0; idt_limit = 0; ldt_sel = 0; ldt_base = 0; ldt_limit = 0; tr_sel = 0; tr_base = 0; tr_limit = 0;
  halted = 0; halt_code = 0; halt_info = 0; flt = 0; fetching = 0; exc_depth = 0;
  vt = 0; icount = 0; irq_out = 0;
  rs_i = 1; repeat (2) { pic_irr[rs_i] = 0; pic_isr[rs_i] = 0; pic_imr[rs_i] = 255; pic_init[rs_i] = 0; pic_ris[rs_i] = 0; pic_icw4[rs_i] = 0; rs_i += 1; }
  pic_base[1] = 8; pic_base[2] = 112;
  pit_reload = 65536; pit_next = 0; pit_on = 0; pit_rw = 3; pit_mode = 3; pit_wst = 0; pit_lat = 0; pit_rst = 0;
  clear(uart_rx); clear(uart_tx);
  u_ier = 0; u_lcr = 0; u_mcr = 0; u_scr = 0; u_dll = 1; u_dlm = 0; u_fcr = 0; u_thre = 0; u_irq = 0;
  cmos_idx = 0;
  find_block();
}
`;
};
