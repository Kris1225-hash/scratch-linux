'use strict';
// profile for the unit compiler: which straight-line runs of instructions does the machine spend its time in?
// runs the js build (interpreter only) with a per-trace-entry counter through a boot and a shell session, and
// records every decoded instruction with its bytes and how often it ran, during boot and afterwards.
//   node tools/unitprof.js [--out out/units.json] [--max N] [--show]
const fs = require('fs');
const path = require('path');
const { makeMachine } = require('./run');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const OUT = opt('--out', path.join(__dirname, '..', 'out', 'units.json'));
const MAX = +opt('--max', 400e6);
// a bit of everything somebody poking at the shell is likely to do
const WORK = [
  'uname -a', 'ls', 'ls -l /', 'ls /bin', 'cat /proc/cpuinfo', 'free', 'ps', 'df', 'mount', 'uptime', 'date', 'id', 'whoami', 'pwd', 'hostname',
  'cat /etc/motd', 'cat /root/README', 'echo hello world', 'echo $((6*7)) $PATH', 'cd /tmp', 'cd', 'nosuchcommand', 'ls /nope',
  'echo hello world | tr a-z A-Z', 'seq 1 300 | sort -rn | tail -3', 'wc -l /etc/passwd', 'grep -c root /etc/passwd', 'sed -n 1p /etc/passwd',
  'head -c 3000 /bin/busybox | md5sum', 'head -c 2000 /bin/busybox | od -x | tail -2', 'find /etc -type f', 'cat /proc/meminfo | head -4', 'dmesg | tail -3',
  'for i in 1 2 3 4 5 6 7 8 9 10; do echo $((i*i)); done', 'x=0; while [ $x -lt 60 ]; do x=$((x+1)); done; echo $x',
  'echo "3.5 2" | awk "{print \\$1*\\$2, sqrt(\\$1)}"', 'echo "2^64" | bc', 'expr 6 \\* 7', 'printf "%05d %x %s\\n" 42 255 hi', 'factor 360360',
  'mkdir /tmp/a; cd /tmp/a; for f in 1 2 3; do echo file$f > f$f; done; cat f1 f2 f3 | sort -r; ls -la', 'cp f1 g; mv g h; touch i; ls; rm h i; cd /; rm -r /tmp/a',
  'f() { echo "arg $1"; }; f one; f two', 'cat <<EOF | wc -c\nsome text here\nEOF', 'sleep 1; echo done', 'true && echo yes || echo no', 'ls -l /bin | head -5 | cut -c1-40',
  'cat /proc/uptime /proc/loadavg /proc/version', 'env | sort | head -4', 'echo abc > /tmp/x; cat /tmp/x /tmp/x | uniq -c; rm /tmp/x', 'help | head -3', 'yes | head -3',
  'date +%s', 'basename /a/b/c.txt .txt; dirname /a/b/c.txt', 'strings /init | head -3', 'ls -R /etc | wc -l', 'time true', 'kill -0 1 && echo alive', 'sleep 2 & wait; echo bg',
].join('\n').split('\n');

const bytesAt = new Map();
let M = null;
const m = makeMachine({ ramMB: +(opt('--ram', 16)), cfg: { unitProf: true, aotOff: true }, host: {
  blk: (t0, t1, dq) => {
    const { lists: L } = M.inst;
    for (let i = t0; i < t1; i++) {
      const len = L.tL[i - 1];
      if (!len) continue;
      const eip = L.tI[i - 1];
      const b = [];
      for (let k = 0; k < len; k++) { const a = eip + k; const w = L.memw[dq + Math.floor(a / 4) - 1]; b.push(Math.floor(w / Math.pow(256, a % 4)) % 256); }
      bytesAt.set(i, b);
    }
  },
} });
M = m;
const { vars: v, lists: L, procs: P } = m.inst;
const HN = m.built.dispatchNames;
P.reset();
let out = '', bootI = 0, bootCounts = null, line = 0, done = false, idleSince = 0;
const t0 = Date.now();
const atPrompt = () => /(# |\n> )$/.test(out.slice(-40));
while (v.halted < 2 && v.icount < MAX && !done) {
  P.machine_step();
  if (v.halted === 1 && v.irq_out === 0) {
    // idle: if the shell is waiting at its prompt, give it the next line
    if (atPrompt() && L.uart_rx.length === 0) {
      if (!bootCounts) { bootCounts = Float64Array.from(L.tpc); bootI = v.icount; }
      if (line < WORK.length) { for (const c of Buffer.from(WORK[line++] + '\r')) L.uart_rx.push(c); out += '\0'; }
      else if (++idleSince > 20) done = true;
    }
    P.idle_skip();
  }
  if (L.uart_tx.length) { out += Buffer.from(L.uart_tx).toString('latin1'); L.uart_tx.length = 0; }
}
console.error(`[unitprof] ${v.icount} dispatches (boot ${bootI}), ${line}/${WORK.length} lines typed, ${((Date.now() - t0) / 1000).toFixed(1)}s, blocks ${v.nblocks}, trace ${v.tnext}, flushes ${v.nflush}`);
if (process.argv.includes('--show')) process.stderr.write(out.replace(/\0/g, ''));
if (v.nflush > 0) console.error('[unitprof] WARNING: the trace was flushed during the run, early counts are lost');

const ent = [];
let total = 0;
for (let i = 16; i < v.tnext; i++) {
  const h = L.tH[i - 1]; const c = L.tpc[i - 1];
  total += c;
  if (c > 0 || L.tL[i - 1] > 0) ent.push({ i, name: HN[h - 1], c, cb: bootCounts ? bootCounts[i - 1] : 0, eip: L.tI[i - 1] >>> 0, len: L.tL[i - 1], f: [L.tA[i - 1], L.tB[i - 1], L.tC[i - 1], L.tD[i - 1], L.tE[i - 1], L.tF[i - 1]], bytes: bytesAt.get(i) || null });
}
fs.writeFileSync(OUT, JSON.stringify({ total, boot: bootI, ent }));
console.error(`[unitprof] ${ent.length} trace entries, ${total} dispatches counted -> ${OUT}`);
