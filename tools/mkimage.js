'use strict';
// vmlinux (ELF32) -> the pc's initial memory image: kernel segments at their physical addresses plus a
// linux "zero page" (struct boot_params) and command line, the way a 32-bit boot protocol loader leaves them.
// we enter the uncompressed kernel directly at startup_32, so there is no bios, no real mode, no decompressor.
const fs = require('fs');

const BOOT_PARAMS = 0x10000;
const CMDLINE = 0x11000;

function mkimage(vmlinuxPath, opts) {
  if (!fs.existsSync(vmlinuxPath)) {
    console.error(`no kernel at ${vmlinuxPath}\nbuild one first: ./build/docker.sh (or ./build/build.sh on a debian / ubuntu machine)`);
    process.exit(1);
  }
  const elf = fs.readFileSync(vmlinuxPath);
  if (elf.readUInt32BE(0) !== 0x7f454c46 || elf[4] !== 1) throw new Error('not an ELF32 file');
  const entry = elf.readUInt32LE(0x18);
  const phoff = elf.readUInt32LE(0x1c), phentsize = elf.readUInt16LE(0x2a), phnum = elf.readUInt16LE(0x2c);
  const ramBytes = opts.ramMB * 1048576;
  const chunks = [];           // { addr, buf }
  let kernelEnd = 0;
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    if (elf.readUInt32LE(p) !== 1) continue;                    // PT_LOAD
    const off = elf.readUInt32LE(p + 4), paddr = elf.readUInt32LE(p + 12), filesz = elf.readUInt32LE(p + 16), memsz = elf.readUInt32LE(p + 20);
    if (paddr % 4) throw new Error('unaligned segment');
    if (paddr + memsz > ramBytes) throw new Error('kernel does not fit in ram');
    chunks.push({ addr: paddr, buf: elf.subarray(off, off + filesz) });
    kernelEnd = Math.max(kernelEnd, paddr + memsz);
  }
  // ---- boot_params
  const bp = Buffer.alloc(0x2000);
  const e820 = [
    [0, 0x9fc00, 1],
    [0x9fc00, 0x400, 2],
    [0xf0000, 0x10000, 2],
    [0x100000, ramBytes - 0x100000, 1],
  ];
  bp[0x1e8] = e820.length;
  e820.forEach(([addr, size, type], i) => {
    const o = 0x2d0 + i * 20;
    bp.writeUInt32LE(addr, o); bp.writeUInt32LE(0, o + 4);
    bp.writeUInt32LE(size, o + 8); bp.writeUInt32LE(0, o + 12);
    bp.writeUInt32LE(type, o + 16);
  });
  bp.writeUInt16LE(0xffff, 0x1fa);             // vid_mode: normal
  bp.writeUInt16LE(0xaa55, 0x1fe);             // boot_flag
  bp.writeUInt32LE(0x53726448, 0x202);         // "HdrS"
  bp.writeUInt16LE(0x020f, 0x206);             // boot protocol 2.15
  bp[0x210] = 0xff;                            // type_of_loader: unknown
  bp[0x211] = 0x01;                            // loadflags: LOADED_HIGH
  bp.writeUInt32LE(0x100000, 0x214);           // code32_start
  bp.writeUInt32LE(CMDLINE, 0x228);            // cmd_line_ptr
  bp.writeUInt32LE(0x7fffffff, 0x22c);         // initrd_addr_max
  bp.writeUInt32LE(0x100000, 0x230);           // kernel_alignment
  bp.writeUInt32LE(2047, 0x238);               // cmdline_size
  bp.writeUInt32LE(0x100000, 0x258);           // pref_address
  bp.writeUInt32LE(kernelEnd - 0x100000, 0x260);   // init_size
  // a setup_data node of type SETUP_RNG_SEED: the "boot loader" hands linux 32 bytes of entropy so it does
  // not spend millions of instructions trying to scrape jitter out of a machine that has none.
  // (the scratch build re-rolls these bytes with "pick random" at every power-on)
  const SEED_OFF = 0x1800;                     // inside our two boot_params pages, after the command line
  bp.writeUInt32LE(BOOT_PARAMS + SEED_OFF, 0x250);   // hdr.setup_data
  bp.writeUInt32LE(0, SEED_OFF); bp.writeUInt32LE(0, SEED_OFF + 4);   // next = NULL
  bp.writeUInt32LE(9, SEED_OFF + 8);           // type = SETUP_RNG_SEED
  bp.writeUInt32LE(32, SEED_OFF + 12);         // len
  const seed = opts.seed || require('crypto').createHash('sha256').update('scratch cat says meow').digest();
  seed.copy(bp, SEED_OFF + 16, 0, 32);
  const cmd = Buffer.from(opts.cmdline + '\0', 'latin1');
  if (cmd.length > 2047) throw new Error('command line too long');
  cmd.copy(bp, CMDLINE - BOOT_PARAMS);
  chunks.unshift({ addr: BOOT_PARAMS, buf: bp });

  // ---- words
  const img = [], imgdir = [];
  for (const c of chunks) {
    const n = Math.ceil(c.buf.length / 4);
    imgdir.push(c.addr / 4 + 1, n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      img.push(o + 4 <= c.buf.length ? c.buf.readUInt32LE(o) : (c.buf[o] | ((c.buf[o + 1] || 0) << 8) | ((c.buf[o + 2] || 0) << 16)) >>> 0);
    }
  }
  return { img, imgdir, entry, bootParams: BOOT_PARAMS, kernelEnd, chunks, seedAddr: BOOT_PARAMS + SEED_OFF + 16 };
}

// flat binaries for qemu's generic loader (lockstep runs): kernel.bin @ first load address, bootparams.bin @ BOOT_PARAMS
function writeFlat(image, dir) {
  const k = image.chunks.filter((c) => c.addr >= 0x100000);
  const base = k[0].addr, end = Math.max(...k.map((c) => c.addr + c.buf.length));
  const flat = Buffer.alloc(end - base);
  for (const c of k) c.buf.copy(flat, c.addr - base);
  fs.writeFileSync(dir + '/kernel.bin', flat);
  fs.writeFileSync(dir + '/bootparams.bin', image.chunks[0].buf);
  return { kernelBase: base };
}

module.exports = { mkimage, writeFlat, BOOT_PARAMS, CMDLINE };
