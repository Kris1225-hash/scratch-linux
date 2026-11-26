'use strict';
// pack the memory image (kernel + boot parameters) into text, for the build that has to fit scratch.mit.edu's
// 5 MB limit on project.json. the project unpacks it itself at power-on (emu/unpack.js is the other half).
//
//   LZ77 with a 128 KB window and three repeat offsets, entropy coded with rANS (static tables, 12 bit), the
//   coder's output written in base 93: one printable ascii character per digit, every one of them except
//   the two that json would have to escape. 6.54 bits per byte of project.json.
//
// why this and not gzip: scratch has no bit operations, no arrays of bytes and no character codes. what it does
// have is exact integer arithmetic on doubles, "letter n of string", and one case-sensitive lookup ("switch
// costume to (name)"). an rANS decoder is exactly that kind of work: per symbol one table lookup, a multiply,
// a divide, and now and then "state = state * 93 + next digit".
//
// stream layout, per sequence:
//   token                 literal count class (0..15) * 16 + match length class (0..15)
//   [count escape]        when the class is 15: count - 15 as (k, k raw bits), value + 1 in [2^k, 2^(k+1))
//   literals              each coded with the table picked by the top 4 bits of the byte before it
//   [length escape]       when the class is 15: length - 3 - 15, same coding
//   offset code           0..2 = repeat offset, 3 + k = distance in [2^k, 2^(k+1)), followed by k raw bits
// the last sequence may stop after its literals, when the output is complete.

const BASE = 93, SCALE = 4096, LOW = 2147483648;       // rANS state lives in [LOW, BASE * LOW)
const WINDOW = 131072;                                 // the unpacker's ring buffer; distances stay below it
const MINMATCH = 3, MAXMATCH = 65535;
const ALPHABET = (() => { let s = ''; for (let c = 32; c < 127; c++) if (c !== 34 && c !== 92) s += String.fromCharCode(c); return s; })();
// table layout inside the frequency list: 16 literal tables, then token, offset, and the two escape tables
const T_LIT = 0, T_TOK = 16 * 256, T_OF = T_TOK + 256, T_ESCL = T_OF + 20, T_ESCM = T_ESCL + 21, T_END = T_ESCM + 21;
const TABLES = [];
for (let c = 0; c < 16; c++) TABLES.push({ off: T_LIT + c * 256, n: 256 });
TABLES.push({ off: T_TOK, n: 256 }, { off: T_OF, n: 20 }, { off: T_ESCL, n: 21 }, { off: T_ESCM, n: 21 });

// ---------------------------------------------------------------- LZ77 parse
function parse(src, opts = {}) {
  const N = src.length, depth = opts.depth || 96;
  const HB = 18, head = new Int32Array(1 << HB).fill(-1), prev = new Int32Array(N);
  const head3 = new Int32Array(1 << 16).fill(-1);
  const h4 = (i) => (Math.imul(src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24), 2654435761 | 0) >>> (32 - HB));
  const h3 = (i) => (Math.imul(src[i] | (src[i + 1] << 8) | (src[i + 2] << 16), 506832829) >>> 16);
  const mlen = (a, b, max) => { let l = 0; while (l < max && src[a + l] === src[b + l]) l++; return l; };
  const ins = (i) => { if (i + 4 <= N) { const h = h4(i); prev[i] = head[h]; head[h] = i; head3[h3(i)] = i; } };
  const MAXD = WINDOW - 1;
  const find = (i, rep) => {
    let best = 0, bd = 0, br = -1;
    const max = Math.min(N - i, MAXMATCH);
    if (max < MINMATCH) return null;
    for (let r = 0; r < 3; r++) { const d = rep[r]; if (d > 0 && d <= i) { const l = mlen(i - d, i, max); if (l >= MINMATCH && l > best) { best = l; bd = d; br = r; } } }
    let gain = best ? best + 1 : 0;      // a repeat offset is worth about one more byte than a fresh one
    if (i + 4 <= N) {
      let p = head[h4(i)], n = depth;
      while (p >= 0 && i - p <= MAXD && n-- > 0) {
        const l = mlen(p, i, max);
        if (l >= 4 && l > Math.max(best, gain - 1)) { best = l; bd = i - p; br = -1; gain = l; if (l === max) break; }
        p = prev[p];
      }
    }
    if (best < 4 && br < 0 && i + 3 <= N) { const p = head3[h3(i)]; if (p >= 0 && i - p <= 4096) { const l = mlen(p, i, max); if (l >= 3 && l > best) { best = l; bd = i - p; } } }
    return best >= MINMATCH ? { len: best, dist: bd, rep: br } : null;
  };
  const seqs = [];                      // { pos, ll, ml, dist, rep }: ll literals end at pos, then the match
  const rep = [1, 4, 8];
  let i = 0, litStart = 0;
  while (i < N) {
    let m = find(i, rep);
    if (m) {
      for (let k = 0; k < 2 && i + 1 < N; k++) {        // lazy: is there something better one byte on?
        ins(i);
        const m2 = find(i + 1, rep);
        if (m2 && m2.len + (m2.rep >= 0 ? 1 : 0) > m.len + (m.rep >= 0 ? 1 : 0)) { i++; m = m2; } else break;
      }
      seqs.push({ pos: i, ll: i - litStart, ml: m.len, dist: m.dist, rep: m.rep });
      if (m.rep > 0) { const d = rep[m.rep]; rep.splice(m.rep, 1); rep.unshift(d); } else if (m.rep < 0) { rep.pop(); rep.unshift(m.dist); }
      const end = i + m.len;
      for (let j = i; j < end; j++) ins(j);
      i = end; litStart = i;
    } else { ins(i); i++; }
  }
  if (litStart < N) seqs.push({ pos: N, ll: N - litStart, ml: 0, dist: 0, rep: -1 });
  return seqs;
}

// ---------------------------------------------------------------- the symbol stream
const esc = (v) => { const k = 31 - Math.clz32(v + 1); return [k, v + 1 - (1 << k)]; };   // v >= 0 -> (k, k raw bits)
// [table offset, symbol] for coded symbols, [-1, k, value] for raw bits, in the order the unpacker reads them
function symbols(src, seqs) {
  const ops = [];
  for (const s of seqs) {
    const lc = Math.min(s.ll, 15), mc = s.ml ? Math.min(s.ml - MINMATCH, 15) : 0;
    ops.push([T_TOK, lc * 16 + mc]);
    if (lc === 15) { const [k, v] = esc(s.ll - 15); ops.push([T_ESCL, k]); if (k) ops.push([-1, k, v]); }
    for (let j = s.pos - s.ll; j < s.pos; j++) ops.push([T_LIT + ((j ? src[j - 1] : 0) >> 4) * 256, src[j]]);
    if (!s.ml) break;
    if (mc === 15) { const [k, v] = esc(s.ml - MINMATCH - 15); ops.push([T_ESCM, k]); if (k) ops.push([-1, k, v]); }
    if (s.rep >= 0) ops.push([T_OF, s.rep]);
    else { const k = 31 - Math.clz32(s.dist); ops.push([T_OF, 3 + k]); if (k) ops.push([-1, k, s.dist - (1 << k)]); }
  }
  return ops;
}
// counts -> 12-bit frequencies (every symbol that occurs gets at least 1; the total is exactly SCALE)
function quantize(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  const f = counts.map((c) => (c ? Math.max(1, Math.round(c * SCALE / total)) : 0));
  if (!total) { f[0] = SCALE; return f; }       // never used, but every table owns SCALE slots in the unpacker
  let sum = f.reduce((a, b) => a + b, 0);
  while (sum !== SCALE) {
    // move one unit where it costs the least bits
    let bi = -1, bc = Infinity;
    for (let i = 0; i < f.length; i++) {
      if (!counts[i]) continue;
      if (sum > SCALE) { if (f[i] > 1) { const c = counts[i] * Math.log2(f[i] / (f[i] - 1)); if (c < bc) { bc = c; bi = i; } } }
      else { const c = -counts[i] * Math.log2((f[i] + 1) / f[i]); if (c < bc) { bc = c; bi = i; } }
    }
    f[bi] += sum > SCALE ? -1 : 1; sum += sum > SCALE ? -1 : 1;
  }
  return f;
}
function buildTables(ops) {
  const counts = new Array(T_END).fill(0);
  for (const o of ops) if (o[0] >= 0) counts[o[0] + o[1]]++;
  const freq = new Array(T_END).fill(0), cum = new Array(T_END).fill(0);
  for (const t of TABLES) {
    const f = quantize(counts.slice(t.off, t.off + t.n));
    let c = 0;
    for (let i = 0; i < t.n; i++) { freq[t.off + i] = f[i]; cum[t.off + i] = c; c += f[i]; }
  }
  return { freq, cum };
}
// rANS: symbols go in back to front, digits come out back to front
function encode(ops, freq, cum) {
  const digits = [];
  let x = LOW;
  for (let i = ops.length - 1; i >= 0; i--) {
    const o = ops[i];
    if (o[0] >= 0) {
      const f = freq[o[0] + o[1]], c = cum[o[0] + o[1]];
      const xmax = (LOW / SCALE) * BASE * f;
      while (x >= xmax) { digits.push(x % BASE); x = Math.floor(x / BASE); }
      x = Math.floor(x / f) * SCALE + (x % f) + c;
    } else {
      const p = Math.pow(2, o[1]);
      const xmax = (LOW / p) * BASE;
      while (x >= xmax) { digits.push(x % BASE); x = Math.floor(x / BASE); }
      x = x * p + o[2];
    }
  }
  for (let i = 0; i < 6; i++) { digits.push(x % BASE); x = Math.floor(x / BASE); }      // the final state: 6 digits
  let text = '';
  const parts = [];
  for (let i = digits.length - 1; i >= 0; i--) { text += ALPHABET[digits[i]]; if (text.length >= 65536) { parts.push(text); text = ''; } }
  parts.push(text);
  return parts.join('');
}

// ---------------------------------------------------------------- reference unpacker (what emu/unpack.js does)
function unpack(text, freq, cum, outLen) {
  const val = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) val[ALPHABET.charCodeAt(i)] = i;
  const slot = new Int32Array(TABLES.length * SCALE);       // (table number, slot) -> index into freq / cum
  const base = new Map();
  TABLES.forEach((t, ti) => { base.set(t.off, ti * SCALE); let k = ti * SCALE; for (let s = 0; s < t.n; s++) for (let j = 0; j < freq[t.off + s]; j++) slot[k++] = t.off + s; });
  let zi = 0, x = 0;
  const digit = () => val[text.charCodeAt(zi++)];
  for (let i = 0; i < 6; i++) x = x * BASE + digit();
  const sym = (toff) => {
    const y = slot[base.get(toff) + (x % SCALE)];
    x = freq[y] * Math.floor(x / SCALE) + (x % SCALE) - cum[y];
    while (x < LOW) x = x * BASE + digit();
    return y - toff;
  };
  const raw = (k) => { const p = Math.pow(2, k), v = x % p; x = Math.floor(x / p); while (x < LOW) x = x * BASE + digit(); return v; };
  const escv = (toff) => { const k = sym(toff); return (1 << k) - 1 + (k ? raw(k) : 0); };
  const out = Buffer.alloc(outLen);
  let o = 0, r0 = 1, r1 = 4, r2 = 8;
  while (o < outLen) {
    const tok = sym(T_TOK);
    let ll = tok >> 4, mc = tok & 15;
    if (ll === 15) ll += escv(T_ESCL);
    for (let j = 0; j < ll; j++) { out[o] = sym(T_LIT + ((o ? out[o - 1] : 0) >> 4) * 256); o++; }
    if (o >= outLen) break;
    let ml = mc + MINMATCH;
    if (mc === 15) ml += escv(T_ESCM);
    const oc = sym(T_OF);
    let d;
    if (oc === 0) d = r0;
    else if (oc === 1) { d = r1; r1 = r0; r0 = d; }
    else if (oc === 2) { d = r2; r2 = r1; r1 = r0; r0 = d; }
    else { const k = oc - 3; d = (1 << k) + (k ? raw(k) : 0); r2 = r1; r1 = r0; r0 = d; }
    for (let j = 0; j < ml; j++) { out[o] = out[o - d]; o++; }
  }
  return { out, used: zi };
}

// image (from tools/mkimage.js) -> everything the build needs
function packImage(image, opts = {}) {
  const parts = [], dir = [];
  for (const c of image.chunks) {
    if (c.addr % 4096) throw new Error('zpack: segment not page aligned');
    const n = Math.ceil(c.buf.length / 4096);
    const b = Buffer.alloc(n * 4096); c.buf.copy(b);
    parts.push(b);
    const last = dir.length - 2;
    if (last >= 0 && dir[last] + dir[last + 1] === c.addr / 4096) dir[last + 1] += n; else dir.push(c.addr / 4096, n);
  }
  const src = Buffer.concat(parts);
  const seqs = parse(src, opts);
  const ops = symbols(src, seqs);
  const { freq, cum } = buildTables(ops);
  const text = encode(ops, freq, cum);
  const back = unpack(text, freq, cum, src.length);
  if (back.used !== text.length || Buffer.compare(back.out, src) !== 0) throw new Error('zpack: the packed image does not unpack to itself');
  // digit value per costume number of the terminal sprite (costume c + 1 is the glyph of character code c + 32)
  const zv = []; for (let c = 32; c < 127; c++) zv.push(Math.max(0, ALPHABET.indexOf(String.fromCharCode(c))));
  return { text, freq, dir, zv, bytes: src.length, pages: src.length / 4096, sequences: seqs.length,
    layout: { T_LIT, T_TOK, T_OF, T_ESCL, T_ESCM, T_END, NTAB: TABLES.length, tables: TABLES, WINDOW, BASE, SCALE, LOW, MINMATCH } };
}

module.exports = { packImage, parse, unpack, ALPHABET, WINDOW };

if (require.main === module) {
  const path = require('path');
  const { mkimage } = require('./mkimage');
  const image = mkimage(path.join(__dirname, '..', 'out', 'kernel', 'vmlinux'), { ramMB: 16, cmdline: 'console=ttyS0 clocksource=jiffies lpj=47727' });
  const t0 = Date.now();
  const p = packImage(image);
  console.log(`${p.bytes} bytes (${p.pages} pages) -> ${p.text.length} characters (${(100 * p.text.length / p.bytes).toFixed(1)}%), ${p.sequences} sequences, page runs ${JSON.stringify(p.dir)}, ${Date.now() - t0} ms, unpacks to itself`);
}
