'use strict';
// the seed: boot the kernel once on the js build (same handlers, same fusion, same dispatch ids as the build
// it is for) and keep every block the decoder produced, together with the memory words it was decoded from.
// the scratch project starts with those blocks already sitting in its trace lists (see seed_try in decode.js).
const { buildEmu } = require('../emu/build');
const { instantiate } = require('../sbl/backend_js');

// cfg: the exact configuration of the target build (minus target). returns the cfg.seed object for buildEmu.
function makeSeed(cfg, image, o = {}) {
  const maxEntries = o.maxEntries || 200000;
  const work = o.work !== undefined ? o.work : ['uname -a', 'ls', 'ls -l /', 'cat /proc/cpuinfo', 'free', 'ps', 'echo hello | tr a-z A-Z', 'cat /etc/motd', 'date', 'df', 'cd /tmp; pwd; cd'];
  const blocks = [];                     // { eip, ent: [[9 fields]...], words: [] }
  const seen = new Set();
  let M = null, entries = 0;
  const host = {
    rtc: (k) => [0, 0, 12, 4, 25, 11, 2026][k], stopall() {},
    seedblk: (t0, t1, dq, eip, dend) => {
      if (entries + (t1 - t0) > maxEntries) return;
      const L = M.lists;
      const words = [];
      for (let a = Math.floor(eip / 4); a <= Math.floor((dend - 1) / 4); a++) words.push(L.memw[dq + a - 1]);
      const key = eip + ':' + words.join(',');
      if (seen.has(key)) return;
      seen.add(key);
      const ent = [];
      for (let i = t0; i < t1; i++) ent.push([L.tH[i - 1], L.tA[i - 1], L.tB[i - 1], L.tC[i - 1], L.tD[i - 1], L.tE[i - 1], L.tF[i - 1], L.tI[i - 1], L.tO ? L.tO[i - 1] : 0]);
      blocks.push({ eip, ent, words });
      entries += ent.length;
    },
  };
  const built = buildEmu(Object.assign({}, cfg, { target: 'js', seedCapture: true, seed: undefined, sliceInsns: 512, lockstep: false, unitProf: false, profile: false }), image);
  const { inst } = instantiate(built.prog, host, built.data, {});
  M = inst;
  const { vars: v, lists: L, procs: P } = inst;
  P.reset();
  let out = '', line = 0, idle = 0, done = false;
  while (v.halted < 2 && !done && v.icount < 300e6) {
    P.machine_step();
    if (v.halted === 1 && v.irq_out === 0) {
      if (/(# |\n> )$/.test(out.slice(-40)) && L.uart_rx.length === 0) {
        if (line < work.length) { for (const c of Buffer.from(work[line++] + '\r')) L.uart_rx.push(c); out += '\0'; }
        else if (++idle > 5) done = true;
      }
      P.idle_skip();
    }
    if (L.uart_tx.length) { out += Buffer.from(L.uart_tx).toString('latin1'); L.uart_tx.length = 0; }
  }
  if (!/# /.test(out)) throw new Error('mkseed: the capture boot never reached a shell prompt');
  // lay the blocks out in the trace from entry 16, and index them by eip (open addressing, linear probing)
  const TR_FIRST = 16;
  const end = TR_FIRST + entries;
  const names = ['tH', 'tA', 'tB', 'tC', 'tD', 'tE', 'tF', 'tI', 'tO'];
  const trace = {}; for (const k of names) trace[k] = new Float64Array(end);
  let P2 = blocks.length * 3 + 1; const isPrime = (n) => { for (let d = 2; d * d <= n; d++) if (n % d === 0) return false; return true; };
  while (!isPrime(P2)) P2++;
  const sd_eip = new Array(P2).fill(0), sd_tp = new Array(P2).fill(0), sd_nw = new Array(P2).fill(0), sd_w0 = new Array(P2).fill(0), sd_words = [];
  let pos = TR_FIRST;
  for (const b of blocks) {
    let k = b.eip % P2; while (sd_eip[k] !== 0) k = (k + 1) % P2;
    sd_eip[k] = b.eip; sd_tp[k] = pos; sd_nw[k] = b.words.length; sd_w0[k] = sd_words.length + 1;
    for (const w of b.words) sd_words.push(w);
    for (const e of b.ent) { names.forEach((nm, f) => { trace[nm][pos - 1] = e[f]; }); pos++; }
  }
  if (!sd_words.length) sd_words.push(0);
  return { end, P: P2, trace, lists: { sd_eip, sd_tp, sd_nw, sd_w0, sd_words }, stats: { blocks: blocks.length, entries, words: sd_words.length, lines: line, dispatches: v.icount } };
}
module.exports = { makeSeed };
