#!/usr/bin/env node
'use strict';
// boot the very same kernel in qemu, for comparing with the scratch project (or for convincing somebody).
//   node tools/qemu.js                       a shell on this terminal. ctrl-a x leaves
//   node tools/qemu.js --input 'uname -a\ncat /proc/version\n'     type that at the prompt, print what happens, exit
// same vmlinux (out/kernel/vmlinux), same boot parameters and command line as the .sb3 gets, same kind of cpu
// (a 486 without fpu), same 16 MB. the kernel is entered the way the scratch emulator enters it: directly at its
// 32-bit entry point, by a 40-byte "bios" (tools/mkrom.js) that switches to protected mode and jumps.
// needs qemu-system-i386 (brew install qemu / apt install qemu-system-x86).
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { mkimage, writeFlat } = require('./mkimage');
const { mkrom } = require('./mkrom');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const RAM = +opt('--ram', 16);
const INPUT = opt('--input', null);
const root = path.join(__dirname, '..');
const dir = path.join(root, 'out', 'qemu');

if (spawnSync('qemu-system-i386', ['--version']).error) {
  console.error('qemu-system-i386 is not on the PATH.  macos: brew install qemu   debian / ubuntu: apt install qemu-system-x86');
  process.exit(1);
}
// what tools/build_sb3.js gives the project
const lpj = Math.round(11931.82 / 0.125 / 2);
const cmdline = opt('--append', `console=ttyS0 clocksource=jiffies lpj=${lpj}`);
const image = mkimage(opt('--vmlinux', path.join(root, 'out', 'kernel', 'vmlinux')), { ramMB: RAM, cmdline });
fs.mkdirSync(dir, { recursive: true });
const { kernelBase } = writeFlat(image, dir);
fs.writeFileSync(path.join(dir, 'rom.bin'), mkrom(image.entry, image.bootParams));

const rel = (f) => path.relative(process.cwd(), path.join(dir, f));
const qargs = ['-M', 'pc', '-cpu', '486,-fpu,-vme,-pse', '-m', String(RAM), '-nodefaults', '-vga', 'none', '-display', 'none', '-no-reboot',
  '-bios', rel('rom.bin'),
  '-device', `loader,file=${rel('kernel.bin')},addr=0x${kernelBase.toString(16)},force-raw=on`,
  '-device', `loader,file=${rel('bootparams.bin')},addr=0x${image.bootParams.toString(16)},force-raw=on`,
  '-serial', INPUT === null ? 'mon:stdio' : 'stdio'];
console.error(`qemu-system-i386 ${qargs.join(' ')}`);
console.error(`kernel command line: ${cmdline}`);

if (INPUT === null) {
  console.error('(ctrl-a x leaves qemu)\n');
  const q = spawn('qemu-system-i386', qargs, { stdio: 'inherit' });
  q.on('exit', (code) => process.exit(code || 0));
} else {
  // scripted: one line per shell prompt, everything the serial port says goes to stdout
  const lines = INPUT.replace(/\\n/g, '\n').split('\n').filter((l) => l.length);
  const q = spawn('qemu-system-i386', qargs, { stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '', sent = 0;
  const done = () => { try { q.kill('SIGKILL'); } catch (e) { /* gone */ } process.exit(0); };
  q.stdout.on('data', (d) => {
    process.stdout.write(d);
    out += d.toString('latin1');
    if (/# $/.test(out.slice(-40))) {
      out = '';
      if (sent < lines.length) q.stdin.write(lines[sent++] + '\r'); else { process.stdout.write('\n'); done(); }
    }
  });
  q.on('exit', () => process.exit(0));
  setTimeout(() => { console.error('\n[qemu] no prompt after 60 s, giving up'); done(); }, 60000);
}
