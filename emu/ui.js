'use strict';
// the scratch-only part: the stage's frame loop and the terminal sprite (pen-stamped 80x30 text console).
//
// keyboard: every printable key has its own "when [key] pressed" hat that feeds the uart directly, so you type
// straight onto the terminal. scratch cannot see shift, ctrl, backspace or tab, so the arrow keys stand in:
//   left = backspace, up = shift (twice = caps lock), right = tab, down = ctrl
// pressing down twice opens scratch's "ask" box for a whole line at once (paste); while it is open the view
// scrolls up as far as needed to keep the cursor line clear of it.
//
// phones and tablets have no keys to press. scratch has no "is this a phone" block, so the check is behavioural:
// a tap on the screen before any physical key was ever pressed means touch mode, where the ask box (and with it
// the on-screen keyboard) opens and comes back after every line. the first real key press ends touch mode, and
// from then on clicking the screen does nothing.
const { CELL_W, CELL_H } = require('./font');

module.exports = function ui(cfg) {
  const COLS = 80, ROWS = 30;
  const X0 = -240, Y0 = 180;
  const ST_Y = -168;                      // top edge of the status line
  const ASK_ROWS = 26;                    // text rows that stay visible above the ask box (full size stage)
  const ASK_ROWS_TOUCH = 20;              // same on a phone, where the box is much taller relative to the stage

  // one hat per key. [scratch key name, character code]
  const keys = [];
  for (let c = 97; c <= 122; c++) keys.push([String.fromCharCode(c), c]);
  for (let c = 48; c <= 57; c++) keys.push([String.fromCharCode(c), c]);
  for (const ch of '`-=[]\\;\',./~!@#$%^&*()_+{}|:"<>?') keys.push([ch, ch.charCodeAt(0)]);
  keys.push(['space', 32], ['enter', 13], ['left arrow', 127], ['right arrow', 9]);
  const sblStr = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const keyHats = keys.map(([k, c]) => `on key ${sblStr(k)} { key(${c}); }`).join('\n');

  return `
// ---------------------------------------------------------------- stage: run the machine
const FRAME_BUDGET = ${cfg.frameBudget || 0.029};     // seconds of emulation per screen frame (scratch ticks every 0.033)
var f_t0 = 0, f_last = 0, f_allow = 0, f_done = 0, f_gap = 0, kips = 0, k_t = 0, k_i = 0, power = 0;
var f_act = 0, f_slow = 0, f_h0 = 0;     // when something last happened; 1 = dozing (clock at a fifth of real time)
var asking = 0;                          // 1 while the text box is wanted / open
var has_kbd = 0, touch = 0;              // a physical key has been seen / touch mode (see the top of emu/ui.js)
list kbd_lines[0];                       // lines typed into the ask box, waiting for the terminal to send them

proc boot() {
  reset();
  clear(kbd_lines);
  f_last = (days2000() * 86400); k_t = f_last; k_i = 0; kips = 0; f_act = f_last; f_slow = 0;
}
// one screen frame of machine time. an idle (hlt) machine lets its clock follow the real one.
// (the clock is "days since 2000": scratch's own timer block only ticks once per frame)
// linux wants its timer interrupt 100 times a second whether it has anything to do or not, and each one costs
// ~1600 instructions. so after five seconds of nothing at all (no key, no output, cpu halted) the machine dozes:
// its clock runs at a fifth of real time until something happens.
proc frame() {
  f_t0 = (days2000() * 86400);
  f_allow = (f_t0 - f_last) * 1193182;
  f_last = f_t0;
  if (f_allow > 119318) { f_allow = 119318; }
  f_h0 = halted;
  if (len(uart_rx) > 0) { f_act = f_t0; if (u_irq == 0) { uart_update(); } }
  if (f_t0 - f_act > 5) { f_slow = 1; f_allow = f_allow * 0.2; } else { f_slow = 0; }
  f_done = 0;
  until (f_done == 1) {
    if (halted == 2) { f_done = 1; }
    else {
      if (halted == 1 && irq_out == 0) {
        f_gap = pit_next - vt;
        if (pit_on > 0 && f_gap <= f_allow) { f_allow -= f_gap; idle_skip(); machine_step(); }
        else { vt += f_allow; f_allow = 0; f_done = 1; }
      } else { machine_step(); }
      if ((days2000() * 86400) - f_t0 > FRAME_BUDGET) { f_done = 1; }
    }
  }
  if (halted != 1 || f_h0 != 1 || len(uart_tx) > 0) { f_act = f_t0; }
  if (f_t0 - k_t > 1) { kips = round((icount - k_i) / (f_t0 - k_t) / 1000); k_t = f_t0; k_i = icount; }
}
on flag {
  power = 0; asking = 0; has_kbd = 0; touch = 0;
  ${cfg.lazy ? '// build the big lists, then have the terminal sprite unpack the kernel into them (emu/unpack.js)\n  alloc(); and8_init();' : ''}
  ${cfg.packed ? 'broadcast_wait("unpack");' : ''}
  boot();
  power = 1;
  forever { frame(); }
}
// the text box, on request
on flag {
  forever {
    until (asking == 1) { }
    ask("a line for linux. empty = close this box, ^C = ctrl-c, ^M = just enter");
    if (strlen(answer()) > 0) {
      push(kbd_lines, answer());
      if (touch == 0) { asking = 0; }        // touch mode: straight back for the next line
    } else { asking = 0; }
  }
}
// the phone check: a tap with no keyboard in sight
on stageclick { if (has_kbd == 0) { touch = 1; asking = 1; } }

// ---------------------------------------------------------------- the terminal sprite
target term;
const COLS = ${COLS};
const ROWS = ${ROWS};
list scr[${COLS * ROWS}];                // character codes; row r lives at ((t_top + r) % ROWS)
var t_top = 0, cx = 0, cy = 0, t_redraw = 0, t_esc = 0, t_p1 = 0, t_p2 = 0, t_np = 0, t_msg = 0;
var t_i = 0, t_c = 0, t_k = 0, t_x = 0, t_y = 0, t_row = 0, t_ch = 0, t_j = 0, t_n = 0;
var v_off = 0, v_want = 0, t_skip = 0;   // rows scrolled out of view at the top; redraw pacing
var sh_mode = 0, ct_mode = 0, kc = 0;    // shift: 0 off, 1 next letter, 2 locked. ctrl: 1 = next key
var st_dirty = 1, st_x = 0, st_kips = 0, st_i = 0, st_touch = 0, st_slow = 0;

proc cell(col, row, code) {
  scr[((t_top + row) % ROWS) * COLS + col + 1] = code;
  if (t_redraw == 0) { if (row >= v_off) { costume(code - 31); goto(col * ${CELL_W} + ${X0}, ${Y0} - (row - v_off) * ${CELL_H}); stamp(); } }
}
proc clear_row(row) {
  t_k = ((t_top + row) % ROWS) * COLS + 1;
  repeat (COLS) { scr[t_k] = 32; t_k += 1; }
}
proc newline() {
  cy += 1;
  if (cy >= ROWS) { cy = ROWS - 1; clear_row(0); t_top = (t_top + 1) % ROWS; t_redraw = 1; }
}
proc putc(c) {
  if (t_esc > 0) { esc_char(c); return; }
  if (c > 31) {
    if (c < 127) {
      if (cx >= COLS) { cx = 0; newline(); }
      cell(cx, cy, c);
      cx += 1;
    }
    return;
  }
  if (c == 10) { newline(); return; }
  if (c == 13) { cx = 0; return; }
  if (c == 8) { if (cx > 0) { cx -= 1; } return; }
  if (c == 9) { cx = (floor(cx / 8) + 1) * 8; if (cx >= COLS) { cx = COLS - 1; } return; }
  if (c == 27) { t_esc = 1; }
}
// a small slice of ansi: cursor moves, erase line / display. colours are parsed and ignored.
proc esc_char(c) {
  if (t_esc == 1) {
    if (c == 91) { t_esc = 2; t_p1 = 0; t_p2 = 0; t_np = 0; } else { t_esc = 0; }
    return;
  }
  if (c >= 48 && c <= 57) { if (t_np == 0) { t_p1 = t_p1 * 10 + c - 48; } else { t_p2 = t_p2 * 10 + c - 48; } return; }
  if (c == 59) { t_np += 1; return; }
  if (c == 63) { return; }
  t_esc = 0;
  if (cx >= COLS) { cx = COLS - 1; }
  if (c == 72 || c == 102) {
    cy = t_p1 - 1; cx = t_p2 - 1;
    if (cy < 0) { cy = 0; } if (cy >= ROWS) { cy = ROWS - 1; }
    if (cx < 0) { cx = 0; } if (cx >= COLS) { cx = COLS - 1; }
    return;
  }
  if (c == 74) {
    if (t_p1 == 2) { t_j = 0; repeat (ROWS) { clear_row(t_j); t_j += 1; } }
    else {
      t_k = ((t_top + cy) % ROWS) * COLS + cx + 1;
      repeat (COLS - cx) { scr[t_k] = 32; t_k += 1; }
      t_j = cy + 1; repeat (ROWS - 1 - cy) { clear_row(t_j); t_j += 1; }
    }
    t_redraw = 1;
    return;
  }
  if (c == 75) {
    t_k = ((t_top + cy) % ROWS) * COLS + cx + 1;
    repeat (COLS - cx) { scr[t_k] = 32; t_k += 1; }
    t_redraw = 1;
    return;
  }
  if (t_p1 == 0) { t_p1 = 1; }
  if (c == 65) { cy -= t_p1; if (cy < 0) { cy = 0; } return; }
  if (c == 66) { cy += t_p1; if (cy >= ROWS) { cy = ROWS - 1; } return; }
  if (c == 67) { cx += t_p1; if (cx >= COLS) { cx = COLS - 1; } return; }
  if (c == 68) { cx -= t_p1; if (cx < 0) { cx = 0; } }
}
proc redraw() {
  pen_clear();
  t_row = v_off;
  repeat (ROWS - v_off) {
    t_k = ((t_top + t_row) % ROWS) * COLS + 1; t_x = ${X0}; t_y = ${Y0} - (t_row - v_off) * ${CELL_H};
    repeat (COLS) {
      t_c = scr[t_k];
      if (t_c != 32) { costume(t_c - 31); goto(t_x, t_y); stamp(); }
      t_k += 1; t_x += ${CELL_W};
    }
    t_row += 1;
  }
  t_redraw = 0; st_dirty = 1;
}
// text -> character codes through the costume names (the one case-sensitive lookup scratch has)
proc puts(s) {
  t_i = 1;
  repeat (strlen(s)) {
    costume("cursor"); costume(letter(s, t_i));
    t_ch = costume_num();
    if (t_ch < 96) { putc(t_ch + 31); }
    t_i += 1;
  }
}
proc type_line(s) {
  if (strlen(s) == 2) { if (letter(s, 1) == "^") {
    costume("cursor"); costume(letter(s, 2));
    t_ch = costume_num() + 31;
    if (t_ch > 96) { t_ch -= 32; }
    if (t_ch > 63) { if (t_ch < 96) { push(uart_rx, t_ch - 64); return; } }
  } }
  t_i = 1;
  repeat (strlen(s)) {
    costume("cursor"); costume(letter(s, t_i));
    t_ch = costume_num();
    if (t_ch < 96) { push(uart_rx, t_ch + 31); }
    t_i += 1;
  }
  push(uart_rx, 13);
}

// ---- keyboard
proc saw_key() {
  if (has_kbd == 0) { has_kbd = 1; touch = 0; st_dirty = 1; }
}
proc key(c) {
  saw_key();
  if (power == 0) { return; }
  kc = c;
  if (ct_mode == 1) {
    ct_mode = 0; st_dirty = 1;
    if (kc >= 97 && kc <= 122) { kc -= 32; }
    if (kc >= 64 && kc <= 95) { push(uart_rx, kc - 64); return; }
    if (kc == 63) { push(uart_rx, 127); return; }
  }
  if (kc >= 97 && kc <= 122) { if (sh_mode > 0) { kc -= 32; if (sh_mode == 1) { sh_mode = 0; st_dirty = 1; } } }
  push(uart_rx, kc);
}
${keyHats}
on key "up arrow" { saw_key(); sh_mode = (sh_mode + 1) % 3; st_dirty = 1; }
on key "down arrow" { saw_key(); if (ct_mode == 1) { ct_mode = 0; asking = 1; } else { ct_mode = 1; } st_dirty = 1; }
on spriteclick { if (has_kbd == 0) { touch = 1; asking = 1; } }

// ---- status line: speed, key legend, shift / ctrl state
proc st_str(s) {
  st_i = 1;
  repeat (strlen(s)) {
    costume("cursor"); costume(letter(s, st_i));
    goto(st_x, ${ST_Y}); stamp();
    st_x += ${CELL_W}; st_i += 1;
  }
}
proc st_glyph(n) { costume(n); goto(st_x, ${ST_Y}); stamp(); st_x += ${CELL_W}; }
proc st_draw() {
  st_dirty = 0; st_kips = kips;
  st_x = ${X0};
  if (f_slow == 1) { st_str(" 486 dozing"); } else { st_str(join(" 486 @ ", join(kips, " kIPS "))); }
  until (st_x >= ${X0 + 17 * CELL_W}) { st_str(" "); }
  if (touch == 1) { st_str("| touch mode: tap the screen to bring the keyboard back"); }
  else { if (has_kbd == 0) { st_str("| got a keyboard? just type.   no keyboard? tap the screen."); }
  else {
    st_str("| "); st_glyph(97); st_str(" bksp  "); st_glyph(98); st_str(" shift  "); st_glyph(99); st_str(" tab  "); st_glyph(100); st_str(" ctrl  "); st_glyph(100); st_glyph(100); st_str(" text box ");
    if (ct_mode == 1) { st_str("| CTRL-"); }
    else { if (sh_mode == 1) { st_str("| SHIFT"); } else { if (sh_mode == 2) { st_str("| CAPS"); } } }
  } }
  until (st_x >= ${X0 + COLS * CELL_W}) { st_str(" "); }
}

proc term_init() {
  t_k = 1; repeat (COLS * ROWS) { scr[t_k] = 32; t_k += 1; }
  t_top = 0; cx = 0; cy = 0; t_esc = 0; t_msg = 0; t_redraw = 1; v_off = 0; t_skip = 9;
  sh_mode = 0; ct_mode = 0; st_dirty = 1;
  size(100); show();
  puts("486SX + 16550 + 8259 + 8254, all of it scratch blocks.${cfg.packed ? '' : ' loading linux 6.12 ...'}");
  putc(13); putc(10);
}
proc term_frame() {
  if (len(uart_tx) > 0) {
    t_n = 1;
    repeat (len(uart_tx)) { putc(uart_tx[t_n]); t_n += 1; }
    clear(uart_tx);
  }
  if (len(kbd_lines) > 0) { type_line(kbd_lines[1]); del(kbd_lines, 1); }
  if (halted == 2) { if (t_msg == 0) {
    t_msg = 1;
    putc(13); putc(10);
    puts(join("[ machine stopped, code ", join(halt_code, " ]")));
  } }
  // keep the cursor line above the text box while it is open
  v_want = 0;
  if (asking == 1) {
    if (touch == 1) { if (cy >= ${ASK_ROWS_TOUCH}) { v_want = cy - ${ASK_ROWS_TOUCH - 1}; } }
    else { if (cy >= ${ASK_ROWS}) { v_want = cy - ${ASK_ROWS - 1}; } }
  }
  if (v_want != v_off) { v_off = v_want; t_redraw = 1; t_skip = 9; }
  // a full repaint is ~1000 stamps: while text is streaming past, do it a few times a second, not every frame
  if (t_redraw == 1) { t_skip += 1; if (t_skip > 4) { redraw(); t_skip = 0; } }
  if (kips != st_kips) { st_dirty = 1; }
  if (touch != st_touch) { st_touch = touch; st_dirty = 1; }
  if (f_slow != st_slow) { st_slow = f_slow; st_dirty = 1; }
  if (st_dirty == 1) { if (t_redraw == 0) { st_draw(); } }
  costume("cursor");
  if (cx >= COLS) { goto(${X0 + (COLS - 1) * CELL_W}, ${Y0} - (cy - v_off) * ${CELL_H}); } else { goto(cx * ${CELL_W} + ${X0}, ${Y0} - (cy - v_off) * ${CELL_H}); }
}
${cfg.packed ? require('./unpack')(cfg).term : ''}
on flag {
  term_init();
  forever { ${cfg.packed ? 'if (z_busy == 0) { term_frame(); }' : 'term_frame();'} }
}
`;
};
