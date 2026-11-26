'use strict';
// the scratch.mit.edu build keeps its kernel packed in one long string (tools/zpack.js explains the format and
// why it looks the way it does). this is the unpacker, run once at power-on: "decompressing linux...", for real.
//
// it lives in the terminal sprite, because the one way scratch has of telling 'a' from 'A' is the name of a
// costume, and the terminal's costumes are the printable characters. what it produces is ram pages: each one is
// put together in the first page frame of the hot memory list, and the stage, which owns the cold lists' procs,
// stores it from there (a broadcast per page).
//
// everything is shaped by what a block costs in the stock interpreter (~100 ns, a variable read included), so
// the tables are laid out per slot: for the slot the coder's state points at, zsl is the symbol, zfs its
// frequency, zbs the slot's position inside the symbol's range, and zcn a second value that saves arithmetic
// (the next literal table, the match length class, 2^bits of an offset).
module.exports = function unpack(cfg) {
  const L = cfg.pack.layout;
  const NT = L.NTAB, SC = L.SCALE;
  const tnum = (off) => L.tables.findIndex((t) => t.off === off);
  const base = (off) => tnum(off) * SC + 1;                 // first slot of a table
  const DIGIT = `costume(letter(ZS, zi)); zx = zx * ${L.BASE} + ZV[costume_num()]; zi += 1;`;
  // one symbol from the table whose slots start at b: z_k = its slot, state advanced and refilled
  const SYM = (b) => `z_k = ${b} + zx % ${SC}; zx = zfs[z_k] * floor(zx / ${SC}) + zbs[z_k]; if (zx < ZLOW) { z_fill(); }`;
  const stage = `
// ---------------------------------------------------------------- the packed memory image (tools/zpack.js)
var z_pg = 0, z_busy = 0;
on broadcast "zpage" { pg_store(z_pg, 0); }
`;
  const term = `
// ---------------------------------------------------------------- the unpacker (see emu/unpack.js)
const ZLOW = ${L.LOW};
const ZWIN = ${L.WINDOW};
var ZS = data("ztext");                 // the image, as text
list ZF = data("zfreq");                // symbol frequencies of every table, end to end
list ZT = data("ztab");                 // [offset, symbols] of each table in ZF
list ZV = data("zval");                 // costume number of a character -> its value as a base ${L.BASE} digit
list ZDIR = data("zdir");               // [first page, pages] runs the image is made of
list zsl[0]; list zfs[0]; list zbs[0]; list zcn[0];     // the slot tables, ${NT} x ${SC} entries each
list zw[0];                             // the last ${L.WINDOW / 1024} KB of output, a byte per item
var zx = 0, zi = 0, zr = 0, zp = 0;
var z_ll = 0, z_ml = 0, z_mc = 0, z_pend = 0, z_src = 0, z_d = 0, z_r0 = 0, z_r1 = 0, z_r2 = 0, z_cb = 0, z_pb = 0;
var z_room = 0, z_n = 0, z_m = 0, z_k = 0, z_t = 0, z_s = 0, z_j = 0, z_f = 0, z_v = 0, z_u = 0, z_o = 0, z_q = 0, z_r = 0, z_np = 0, z_dn = 0, z_di = 0;

// the slot tables, from the frequencies. every table fills exactly ${SC} slots
proc z_tables() {
  clear(zsl); clear(zfs); clear(zbs); clear(zcn);
  z_t = 1;
  repeat (${NT}) {
    z_s = 0;
    repeat (ZT[z_t + 1]) {
      z_f = ZF[ZT[z_t] + z_s + 1];
      // what zsl / zcn say about this symbol depends on the kind of table
      if (z_t < ${2 * tnum(L.T_TOK) + 1}) { z_v = z_s; z_u = floor(z_s / 16) * ${SC} + 1; }
      else { if (z_t == ${2 * tnum(L.T_TOK) + 1}) { z_v = floor(z_s / 16); z_u = z_s % 16; }
      else { z_v = z_s; if (z_t == ${2 * tnum(L.T_OF) + 1}) { if (z_s > 2) { z_u = POW2[z_s - 2]; } else { z_u = 0; } } else { z_u = POW2[z_s + 1]; } } }
      z_j = 0;
      repeat (z_f) { push(zsl, z_v); push(zfs, z_f); push(zbs, z_j); push(zcn, z_u); z_j += 1; }
      z_s += 1;
    }
    z_t += 2;
  }
}
// digits into the state until it is back in range
proc z_fill() {
  until (zx >= ZLOW) { ${DIGIT} }
}
// an escaped count from the table at b -> zr
proc z_esc(b) {
  ${SYM('b')}
  z_m = zcn[z_k];
  zr = z_m - 1 + zx % z_m; zx = floor(zx / z_m);
  if (zx < ZLOW) { z_fill(); }
}
// the next 4096 bytes of output, into the ring from z_pb + 1
proc z_page() {
  zp = z_pb + 1; z_room = 4096;
  until (z_room == 0) {
    if (z_ll > 0) {
      // literals: the table is picked by the top four bits of the byte before
      z_n = z_ll; if (z_n > z_room) { z_n = z_room; }
      z_ll -= z_n; z_room -= z_n;
      repeat (z_n) {
        z_k = z_cb + zx % ${SC};
        zx = zfs[z_k] * floor(zx / ${SC}) + zbs[z_k];
        if (zx < ZLOW) { ${DIGIT} if (zx < ZLOW) { z_fill(); } }
        zw[zp] = zsl[z_k]; zp += 1;
        z_cb = zcn[z_k];
      }
    } else {
      if (z_ml > 0) {
        // a match: copy from further back in the ring (the source may run off its end and wrap)
        z_n = z_ml; if (z_n > z_room) { z_n = z_room; }
        z_ml -= z_n; z_room -= z_n;
        until (z_n == 0) {
          z_m = z_n; if (z_src + z_m > ZWIN + 1) { z_m = ZWIN + 1 - z_src; }
          repeat (z_m) { zw[zp] = zw[z_src]; zp += 1; z_src += 1; }
          z_n -= z_m;
          if (z_src > ZWIN) { z_src = 1; }
        }
      } else {
        if (z_pend == 1) {
          // the match after the literals: length class from the token, then the offset
          z_pend = 0;
          z_ml = z_mc + ${L.MINMATCH};
          if (z_mc == 15) { z_esc(${base(L.T_ESCM)}); z_ml += zr; }
          ${SYM(base(L.T_OF))}
          z_o = zsl[z_k];
          if (z_o > 2) {
            // 2^bits + that many raw bits, straight out of the state
            z_m = zcn[z_k];
            z_d = z_m + zx % z_m; zx = floor(zx / z_m);
            if (zx < ZLOW) { z_fill(); }
            z_r2 = z_r1; z_r1 = z_r0; z_r0 = z_d;
          } else {
            if (z_o == 0) { z_d = z_r0; }
            else { if (z_o == 1) { z_d = z_r1; z_r1 = z_r0; z_r0 = z_d; }
            else { z_d = z_r2; z_r2 = z_r1; z_r1 = z_r0; z_r0 = z_d; } }
          }
          z_src = zp - z_d; if (z_src < 1) { z_src += ZWIN; }
        } else {
          // a new sequence
          ${SYM(base(L.T_TOK))}
          z_ll = zsl[z_k]; z_mc = zcn[z_k];
          if (z_ll == 15) { z_esc(${base(L.T_ESCL)}); z_ll = 15 + zr; }
          z_pend = 1;
          if (zp == 1) { z_cb = floor(zw[ZWIN] / 16) * ${SC} + 1; } else { z_cb = floor(zw[zp - 1] / 16) * ${SC} + 1; }
        }
      }
    }
  }
}
// one page: unpack it, then pack its bytes into words in page frame 0
proc z_page1() {
  z_page();
  z_r = z_pb + 1; z_q = 1;
  repeat (1024) { memw[z_q] = zw[z_r] + zw[z_r + 1] * 256 + zw[z_r + 2] * 65536 + zw[z_r + 3] * 16777216; z_r += 4; z_q += 1; }
  z_pb = (z_pb + 4096) % ZWIN;
}
proc z_start() {
  z_tables();
  clear(zw); repeat (ZWIN) { push(zw, 0); }
  zi = 1; zx = 0;
  repeat (6) { ${DIGIT} }
  z_ll = 0; z_ml = 0; z_pend = 0; z_pb = 0; z_r0 = 1; z_r1 = 4; z_r2 = 8; z_cb = 1;
}
// the stage asks for this once its lists exist (emu/ui.js) and waits for it
on broadcast "unpack" {
  z_busy = 1;
  hide();
  puts("decompressing linux ");
  z_start();
  z_di = 1; z_dn = 0;
  repeat (len(ZDIR) / 2) {
    z_pg = ZDIR[z_di]; z_np = ZDIR[z_di + 1]; z_di += 2;
    repeat (z_np) {
      z_page1();
      broadcast_wait("zpage");
      z_pg += 1; z_dn += 1;
      if (z_dn % 24 == 0) { putc(46); }
    }
  }
  // the tables and the ring have done their job (and would only weigh down a save)
  clear(zsl); clear(zfs); clear(zbs); clear(zcn); clear(zw);
  puts(" ok");
  putc(13); putc(10);
  show();
  z_busy = 0;
}
`;
  return { stage, term };
};
