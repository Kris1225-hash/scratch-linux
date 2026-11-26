#!/usr/bin/env node
'use strict';
// boot out/linux.sb3 in the real scratch-vm (no browser), print what the terminal sprite shows
//   node tools/run_sb3.js [--secs N] [--sb3 path] [--keys "cmd\ncmd\n"] [--type "cmd\ncmd"]
//   --keys presses real keys (the keyboard path), --type taps the screen and answers the ask box (the touch path)
const fs = require('fs');
const path = require('path');
const { boot } = require('../sbl/vmrun');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const SECS = +opt('--secs', 60);
const FILE = opt('--sb3', path.join(__dirname, '..', 'out', 'linux.sb3'));
const TYPE = opt('--type', null);
const KEYS = opt('--keys', null);

(async () => {
  const t0 = Date.now();
  const m = await boot(fs.readFileSync(FILE));
  console.error(`[sb3] loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const term = m.target('term');
  const scr = () => m.getList('scr', term);
  const screen = () => {
    const s = scr(), top = +m.getVar('t_top', term), rows = [];
    for (let r = 0; r < 30; r++) {
      const base = ((top + r) % 30) * 80;
      let line = '';
      for (let c = 0; c < 80; c++) line += String.fromCharCode(+s[base + c] || 32);
      rows.push(line.replace(/\s+$/, ''));
    }
    while (rows.length && rows[rows.length - 1] === '') rows.pop();
    return rows.join('\n');
  };
  // answer the "ask" box with scripted lines once the shell prompt is on screen
  const lines = TYPE ? TYPE.split('\\n') : [];
  let asked = false;
  m.vm.runtime.on('QUESTION', (q) => { asked = q !== null; });
  m.flag();
  const start = Date.now(), cpu0 = process.cpuUsage();
  let last = '', lastPrint = 0, steps = 0, lastType = 0, tapped = false;
  // key presses: one character every couple of frames once the prompt is up
  const keyq = KEYS ? [...KEYS.replace(/\\n/g, '\n')] : [];
  let keyDown = null, keyWait = 0, keysStarted = false, bootSecs = 0, powerSecs = 0;
  const NAMES = { '\n': 'Enter', '\t': 'ArrowRight', '\b': 'ArrowLeft' };
  const atPrompt = () => /# $/.test(screen().split('\n').pop() + ' ');
  while ((Date.now() - start) / 1000 < SECS) {
    m.step(); steps++;
    if (TYPE) await null;                 // "ask and wait" resumes its thread from a promise: let that run
    const now = Date.now();
    if (now - lastPrint > 5000) {
      lastPrint = now;
      const ic = +m.getVar('icount'), el = (now - start) / 1000;
      console.error(`[sb3] t=${el.toFixed(0)}s icount=${ic} (${(ic / el / 1000).toFixed(0)}k insn/s) halted=${m.getVar('halted')} blocks=${m.getVar('nblocks')} kips=${m.getVar('kips')}`);
      if (process.env.DEBUG_TAP) console.error(`[sb3]   asked=${asked} tapped=${tapped} lines=${lines.length} asking=${m.getVar('asking')} touch=${m.getVar('touch')} has_kbd=${m.getVar('has_kbd')} kbd_lines=${m.getList('kbd_lines').length} threads=${m.threads()} atPrompt=${atPrompt()}`);
    }
    if (!powerSecs && +m.getVar('power') === 1) { powerSecs = (now - start) / 1000; console.error(`[sb3] power on after ${powerSecs.toFixed(1)}s (lists built, kernel in memory)`); }
    if (!bootSecs && steps % 8 === 0 && atPrompt()) {
      bootSecs = (now - start) / 1000;
      console.error(`[sb3] shell prompt after ${bootSecs.toFixed(1)}s (cpu ${(process.cpuUsage(cpu0).user / 1e6).toFixed(1)}s), ${m.getVar('icount')} dispatches, ${m.getVar('nblocks')} blocks (${m.getVar('n_seeded')} from the seed)`);
      if (args.includes('--until-prompt')) break;
    }
    if (lines.length && !tapped && atPrompt()) { tapped = true; const st = m.vm.runtime.startHats("event_whenstageclicked"); if (process.env.DEBUG_TAP) console.error("[sb3] tapped, hats:", st && st.length, "asked", asked); }
    if (lines.length && asked && now - lastType > 1500 && atPrompt()) {
      lastType = now;
      m.vm.runtime.emit('ANSWER', lines.shift());
    }
    if (keyDown !== null) { m.vm.postIOData('keyboard', { key: keyDown, isDown: false }); keyDown = null; keyWait = 2; }
    else if (keyq.length && --keyWait <= 0 && (keysStarted || (keysStarted = atPrompt()))) {
      let ch = keyq.shift();
      // capitals go through the shift stand-in (up arrow), like a person would have to
      if (ch >= 'A' && ch <= 'Z') { m.vm.postIOData('keyboard', { key: 'ArrowUp', isDown: true }); m.vm.postIOData('keyboard', { key: 'ArrowUp', isDown: false }); m.step(); ch = ch.toLowerCase(); }
      keyDown = NAMES[ch] || ch;
      m.vm.postIOData('keyboard', { key: keyDown, isDown: true });
      if (ch === '\n') keyWait = 60;
    }
    if (+m.getVar('halted') === 2) { for (let i = 0; i < 5; i++) m.step(); break; }
  }
  const el = (Date.now() - start) / 1000;
  console.log(screen());
  console.error(`\n[sb3] ${steps} vm steps in ${el.toFixed(1)}s, icount=${m.getVar('icount')} (${(+m.getVar('icount') / el / 1000).toFixed(0)}k insn/s), halted=${m.getVar('halted')} code=${m.getVar('halt_code')} info=${m.getVar('halt_info')}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
