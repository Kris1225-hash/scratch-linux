'use strict';
// i486SX core, part 3: the decoder. Turns x86 bytes at eip into trace entries (see handlers.js).
// It only runs the first time a piece of code is executed, so it is written for clarity, not speed.

module.exports = function decode(cfg) {
  // ---- opcode cases: [lo, hi, sbl]  (op: 0..255 one-byte map, 256..511 = 0F xx)
  const cases = [];
  const C = (lo, hi, code) => cases.push([lo, hi, code]);
  const UNK = cfg.strictOpcodes ? `emit(H_UNIMPL, 0, 0, 0, 0, 0, op);` : `emit(H_UD, 0, 0, 0, 0, 0, op);`;
  const T = '0 - 1';      // "no chain yet" marker for the epoch field of jumps

  // 00..3F: add or adc sbb and sub xor cmp, six forms each, plus the segment push/pops and bcd junk at x6/x7/xE/xF
  C(0x00, 0x3f, `
    d_k = floor(op / 8); d_f = op % 8;
    if (d_f < 6) { dec_alu(d_k, d_f); }
    else {
      if (op == 6) { emit(H_PUSH_SEG, 0, 0, 0, osz, 0, 0); }
      else { if (op == 7) { emit(H_POP_SEG, 0, 0, 0, osz, 0, 0); }
      else { if (op == 14) { emit(H_PUSH_SEG, 1, 0, 0, osz, 0, 0); }
      else { if (op == 22) { emit(H_PUSH_SEG, 2, 0, 0, osz, 0, 0); }
      else { if (op == 23) { emit(H_POP_SEG, 2, 0, 0, osz, 0, 0); }
      else { if (op == 30) { emit(H_PUSH_SEG, 3, 0, 0, osz, 0, 0); }
      else { if (op == 31) { emit(H_POP_SEG, 3, 0, 0, osz, 0, 0); }
      else { emit(H_UNIMPL, 0, 0, 0, 0, 0, op); } } } } } } }
    }`);
  C(0x40, 0x47, `if (p_osz == 1) { emit(H_G_INC, 0, 0, op - 63, 2, 0, 0); } else { emit(H_INC_R, op - 63, 0, 0, 0, 0, 0); }`);
  C(0x48, 0x4f, `if (p_osz == 1) { emit(H_G_DEC, 0, 0, op - 71, 2, 0, 0); } else { emit(H_DEC_R, op - 71, 0, 0, 0, 0, 0); }`);
  C(0x50, 0x57, `if (p_osz == 1) { emit(H_G_PUSH, 0, 0, op - 79, 2, 0, 0); } else { emit(H_PUSH_R, op - 79, 0, 0, 0, 0, 0); }`);
  C(0x58, 0x5f, `if (p_osz == 1) { emit(H_G_POP, 0, 0, op - 87, 2, 0, 0); } else { if (op == 92) { emit(H_G_POP, 0, 0, 5, 4, 0, 0); } else { emit(H_POP_R, op - 87, 0, 0, 0, 0, 0); } }`);
  C(0x60, 0x60, `emit(H_PUSHA, 0, 0, 0, osz, 0, 0);`);
  C(0x61, 0x61, `emit(H_POPA, 0, 0, 0, osz, 0, 0);`);
  C(0x68, 0x68, `dimmv(); if (p_osz == 1) { emit(H_G_PUSHW_I, 0, 0, 0, 0, 0, imm); } else { emit(H_PUSH_I, 0, 0, 0, 0, 0, imm); }`);
  C(0x6a, 0x6a, `dimm8s(); if (p_osz == 1) { emit(H_G_PUSHW_I, 0, 0, 0, 0, 0, imm % 65536); } else { emit(H_PUSH_I, 0, 0, 0, 0, 0, imm); }`);
  C(0x69, 0x69, `decode_modrm(); dimmv(); dec_imul3();`);
  C(0x6b, 0x6b, `decode_modrm(); dimm8s(); if (p_osz == 1) { imm = imm % 65536; } dec_imul3();`);
  C(0x70, 0x7f, `dimm8s(); emit(H_JO + op - 112, 0, ${T}, 0, 0, 0, (d_eip + imm) % M32);`);
  C(0x80, 0x83, `decode_modrm(); dec_grp1();`);
  C(0x84, 0x85, `decode_modrm(); dec_test_eg();`);
  C(0x86, 0x87, `decode_modrm(); if (op == 134) { emit_g(H_G_XCHG, m_reg + 1, 1, 0); } else { emit_g(H_G_XCHG, m_reg + 1, osz, 0); }`);
  C(0x88, 0x8b, `decode_modrm(); dec_mov();`);
  C(0x8c, 0x8c, `decode_modrm(); if (m_mem == 1) { emit_g(H_MOV_E_SEG, m_reg, 2, 0); } else { emit_g(H_MOV_E_SEG, m_reg, osz, 0); }`);
  C(0x8d, 0x8d, `decode_modrm(); p_seg = 0;
    if (m_mem == 0) { emit(H_UD, 0, 0, 0, 0, 0, op); }
    else { if (p_osz == 1) { ea_prep(0); emit(H_G_LEA, m_reg + 1, e_base, 0, 2, e_disp, 0); }
    else { ea_prep(1); emit(H_LEA_B + e_x, m_reg + 1, e_base, e_index, e_scale, e_disp, 0); } }`);
  C(0x8e, 0x8e, `decode_modrm(); if (m_reg == 1) { emit(H_UD, 0, 0, 0, 0, 0, op); } else { emit_g(H_MOV_SEG_E, m_reg, 2, 0); }`);
  C(0x8f, 0x8f, `decode_modrm(); if (m_mem == 0) { if (p_osz == 1 || m_rm == 4) { emit(H_G_POP, 0, 0, m_rm + 1, osz, 0, 0); } else { emit(H_POP_R, m_rm + 1, 0, 0, 0, 0, 0); } } else { emit_g(H_G_POP, 0, osz, 0); }`);
  C(0x90, 0x90, `emit(H_NOP, 0, 0, 0, 0, 0, 0);`);
  C(0x91, 0x97, `if (p_osz == 1) { emit(H_G_XCHG_AX, op - 143, 0, 0, osz, 0, 0); } else { emit(H_XCHG_AR, op - 143, 0, 0, 0, 0, 0); }`);
  C(0x98, 0x98, `if (p_osz == 1) { emit(H_CBW, 0, 0, 0, 0, 0, 0); } else { emit(H_CWDE, 0, 0, 0, 0, 0, 0); }`);
  C(0x99, 0x99, `if (p_osz == 1) { emit(H_CWD, 0, 0, 0, 0, 0, 0); } else { emit(H_CDQ, 0, 0, 0, 0, 0, 0); }`);
  C(0x9a, 0x9a, `dimmv(); d_t = imm; dfetch16(); emit(H_CALLF, dw, 0, 0, 0, d_eip, d_t); d_stop = 1;`);
  C(0x9b, 0x9b, `emit(H_FWAIT, 0, 0, 0, 0, 0, 0);`);
  C(0x9c, 0x9c, `emit(H_PUSHF, 0, 0, 0, osz, 0, 0);`);
  C(0x9d, 0x9d, `emit(H_POPF, 0, 0, 0, osz, 0, 0);`);
  C(0x9e, 0x9e, `emit(H_SAHF, 0, 0, 0, 0, 0, 0);`);
  C(0x9f, 0x9f, `emit(H_LAHF, 0, 0, 0, 0, 0, 0);`);
  // mov al/eax <-> [moffs]: same handlers as the modrm forms, with a bare displacement
  C(0xa0, 0xa3, `
    if (p_asz == 1) { dfetch16(); e_disp = dw; } else { dfetch32(); e_disp = dd; }
    m_mem = 1; m_reg = 0; e_base = 9; e_index = 9; e_scale = 1;
    op = op - 24;                                   // a0..a3 -> 8a 8b 88 89 with reg = eax
    if (op == 136) { op = 138; } else { if (op == 137) { op = 139; } else { if (op == 138) { op = 136; } else { op = 137; } } }
    dec_mov();`);
  for (const [lo, name] of [[0xa4, 'MOVS'], [0xa6, 'CMPS'], [0xaa, 'STOS'], [0xac, 'LODS'], [0xae, 'SCAS']]) {
    C(lo, lo + 1, `if (p_seg == 0) { p_seg = 13; } if (op % 2 == 0) { emit(H_STR_${name}, p_seg, 0, 0, 1, 0, p_rep); } else { emit(H_STR_${name}, p_seg, 0, 0, osz, 0, p_rep); }`);
  }
  C(0xa8, 0xa8, `dfetch8(); emit(H_TESTB_RI, 1, 0, 0, 0, 0, db + 1);`);
  C(0xa9, 0xa9, `dimmv(); if (p_osz == 1) { emit(H_G_TEST_EI, 0, 0, 1, 2, 0, imm); } else { dec_test_ri(1, imm); }`);
  C(0xb0, 0xb7, `dfetch8(); if (op < 180) { emit(H_MOVB_RI, op - 175, 0, 0, 0, 0, db); } else { emit(H_G_MOV_EI, 0, 0, op - 175, 1, 0, db); }`);
  C(0xb8, 0xbf, `dimmv(); if (p_osz == 1) { emit(H_G_MOV_EI, 0, 0, op - 183, 2, 0, imm); } else { emit(H_MOV_RI, op - 183, 0, 0, 0, 0, imm); }`);
  C(0xc0, 0xc1, `decode_modrm(); dfetch8(); dec_shift(db);`);
  C(0xd0, 0xd1, `decode_modrm(); dec_shift(1);`);
  C(0xd2, 0xd3, `decode_modrm(); dec_shift(256);`);
  C(0xc2, 0xc2, `dfetch16(); emit(H_RET_I, 0, 0, 0, 0, 0, dw); d_stop = 1;`);
  C(0xc3, 0xc3, `emit(H_RET, 0, 0, 0, 0, 0, 0); d_stop = 1;`);
  C(0xc4, 0xc5, `decode_modrm(); ea_prep(0); emit(H_LXS, m_reg + 1, e_base, 0, osz, e_disp, (op - 196) * 3);`);
  C(0xc6, 0xc6, `decode_modrm(); dfetch8();
    if (m_mem == 1) { ea_prep(1); emit(H_MOVB_MI_B + e_x, 0, e_base, e_index, e_scale, e_disp, db); }
    else { if (m_rm < 4) { emit(H_MOVB_RI, m_rm + 1, 0, 0, 0, 0, db); } else { emit(H_G_MOV_EI, 0, 0, m_rm + 1, 1, 0, db); } }`);
  C(0xc7, 0xc7, `decode_modrm(); dimmv();
    if (p_osz == 1) { if (m_mem == 1) { emit_m(H_MOVW_MI_B, 0, imm); } else { emit_g(H_G_MOV_EI, 0, 2, imm); } }
    else { if (m_mem == 1) { ea_prep(1); emit(H_MOV_MI_B + e_x, 0, e_base, e_index, e_scale, e_disp, imm); } else { emit(H_MOV_RI, m_rm + 1, 0, 0, 0, 0, imm); } }`);
  C(0xc8, 0xc8, `dfetch16(); dfetch8(); emit(H_ENTER, 0, 0, 0, 0, db, dw);`);
  C(0xc9, 0xc9, `emit(H_LEAVE, 0, 0, 0, 0, 0, 0);`);
  C(0xca, 0xca, `dfetch16(); emit(H_RETF, 0, 0, 0, 0, 0, dw); d_stop = 1;`);
  C(0xcb, 0xcb, `emit(H_RETF, 0, 0, 0, 0, 0, 0); d_stop = 1;`);
  C(0xcc, 0xcc, `emit(H_INT, 0, 0, 0, 0, d_eip, 3); d_stop = 1;`);
  C(0xcd, 0xcd, `dfetch8(); emit(H_INT, 0, 0, 0, 0, d_eip, db); d_stop = 1;`);
  C(0xce, 0xce, `emit(H_INTO, 0, 0, 0, 0, d_eip, 0);`);
  C(0xcf, 0xcf, `emit(H_IRET, 0, 0, 0, 0, 0, 0); d_stop = 1;`);
  C(0xd7, 0xd7, `if (p_seg == 0) { p_seg = 9; } emit(H_XLAT, 0, p_seg, 0, 0, 0, 0);`);
  C(0xd8, 0xdf, `decode_modrm(); emit(H_FPU, 0, 0, 0, 0, 0, 0);`);
  C(0xe0, 0xe3, `dimm8s(); emit(H_LOOPX, 0, ${T}, op - 224, p_asz * 65536, 0, (d_eip + imm) % M32);`);
  C(0xe4, 0xe5, `dfetch8(); if (op == 228) { emit(H_IN, 0, 0, 0, 1, 0, db); } else { emit(H_IN, 0, 0, 0, osz, 0, db); }`);
  C(0xe6, 0xe7, `dfetch8(); if (op == 230) { emit(H_OUT, 0, 0, 0, 1, 0, db); } else { emit(H_OUT, 0, 0, 0, osz, 0, db); }`);
  C(0xec, 0xed, `if (op == 236) { emit(H_IN, 0, 0, 0, 1, 0, 65536); } else { emit(H_IN, 0, 0, 0, osz, 0, 65536); }`);
  C(0xee, 0xef, `if (op == 238) { emit(H_OUT, 0, 0, 0, 1, 0, 65536); } else { emit(H_OUT, 0, 0, 0, osz, 0, 65536); }`);
  C(0xe8, 0xe8, `dimmv(); if (p_osz == 1) { imm = imm + (imm > 32767) * 4294901760; } emit(H_CALL, 0, ${T}, 0, 0, d_eip, (d_eip + imm) % M32); d_stop = 1;`);
  C(0xe9, 0xe9, `dimmv(); if (p_osz == 1) { imm = imm + (imm > 32767) * 4294901760; } emit(H_JMP, 0, ${T}, 0, 0, 0, (d_eip + imm) % M32); d_stop = 1;`);
  C(0xea, 0xea, `dimmv(); d_t = imm; dfetch16(); emit(H_JMPF, dw, 0, 0, 0, 0, d_t); d_stop = 1;`);
  C(0xeb, 0xeb, `dimm8s(); emit(H_JMP, 0, ${T}, 0, 0, 0, (d_eip + imm) % M32); d_stop = 1;`);
  C(0xf4, 0xf4, `emit(H_HLT, 0, 0, 0, 0, 0, 0); emit_end(d_eip);`);
  C(0xf5, 0xf5, `emit(H_CMC, 0, 0, 0, 0, 0, 0);`);
  C(0xf6, 0xf7, `decode_modrm(); dec_grp3();`);
  C(0xf8, 0xf8, `emit(H_CLC, 0, 0, 0, 0, 0, 0);`);
  C(0xf9, 0xf9, `emit(H_STC, 0, 0, 0, 0, 0, 0);`);
  C(0xfa, 0xfa, `emit(H_CLI, 0, 0, 0, 0, 0, 0);`);
  C(0xfb, 0xfb, `emit(H_STI, 0, 0, 0, 0, 0, 0);`);
  C(0xfc, 0xfc, `emit(H_CLD, 0, 0, 0, 0, 0, 0);`);
  C(0xfd, 0xfd, `emit(H_STD, 0, 0, 0, 0, 0, 0);`);
  C(0xfe, 0xfe, `decode_modrm(); if (m_reg == 0) { emit_g(H_G_INC, 0, 1, 0); } else { if (m_reg == 1) { emit_g(H_G_DEC, 0, 1, 0); } else { emit(H_UD, 0, 0, 0, 0, 0, op); } }`);
  C(0xff, 0xff, `decode_modrm(); dec_grp5();`);

  // ---- 0F xx
  C(0x100, 0x100, `decode_modrm(); emit_g(H_GRP6, m_reg, 2, 0);`);
  C(0x101, 0x101, `decode_modrm();
    if (m_reg == 7) { if (m_mem == 1) { ea_prep(0); emit(H_INVLPG, 0, e_base, 0, 0, e_disp, 0); } else { emit(H_UD, 0, 0, 0, 0, 0, op); } }
    else { if (m_reg == 4) { if (m_mem == 1) { emit_g(H_GRP7, m_reg, 2, 0); } else { emit_g(H_GRP7, m_reg, osz, 0); } } else { emit_g(H_GRP7, m_reg, osz, 0); } }`);
  C(0x106, 0x106, `emit(H_CLTS, 0, 0, 0, 0, 0, 0);`);
  C(0x108, 0x109, `emit(H_NOP, 0, 0, 0, 0, 0, 0);`);
  C(0x10b, 0x10b, `emit(H_UD, 0, 0, 0, 0, 0, op);`);
  C(0x10d, 0x10d, `decode_modrm(); emit(H_NOP, 0, 0, 0, 0, 0, 0);`);
  C(0x11f, 0x11f, `decode_modrm(); emit(H_NOP, 0, 0, 0, 0, 0, 0);`);
  C(0x120, 0x120, `decode_modrm(); emit(H_MOV_R_CR, m_rm + 1, 0, 0, 0, 0, m_reg);`);
  C(0x121, 0x121, `decode_modrm(); emit(H_MOV_R_DR, m_rm + 1, 0, 0, 0, 0, m_reg);`);
  C(0x122, 0x122, `decode_modrm(); emit(H_MOV_CR_R, m_rm + 1, 0, 0, 0, 0, m_reg); emit_end(d_eip);`);
  C(0x123, 0x123, `decode_modrm(); emit(H_MOV_DR_R, m_rm + 1, 0, 0, 0, 0, m_reg);`);
  C(0x130, 0x130, `emit(H_MSR, 0, 0, 0, 0, 0, 0);`);
  C(0x131, 0x131, `emit(H_RDTSC, 0, 0, 0, 0, 0, 0);`);
  C(0x132, 0x132, `emit(H_MSR, 0, 0, 0, 0, 0, 1);`);
  C(0x140, 0x14f, `decode_modrm(); emit_g(H_G_CMOV, m_reg + 1, osz, op - 320);`);
  C(0x180, 0x18f, `dimmv(); if (p_osz == 1) { imm = imm + (imm > 32767) * 4294901760; } emit(H_JO + op - 384, 0, ${T}, 0, 0, 0, (d_eip + imm) % M32);`);
  C(0x190, 0x19f, `decode_modrm(); if (m_mem == 0 && m_rm < 4) { emit(H_SETCC_R, m_rm + 1, 0, 0, 0, 0, op - 400); } else { emit_g(H_G_SETCC, op - 400, 1, 0); }`);
  C(0x1a0, 0x1a0, `emit(H_PUSH_SEG, 4, 0, 0, osz, 0, 0);`);
  C(0x1a1, 0x1a1, `emit(H_POP_SEG, 4, 0, 0, osz, 0, 0);`);
  C(0x1a2, 0x1a2, `emit(H_CPUID, 0, 0, 0, 0, 0, 0);`);
  C(0x1a8, 0x1a8, `emit(H_PUSH_SEG, 5, 0, 0, osz, 0, 0);`);
  C(0x1a9, 0x1a9, `emit(H_POP_SEG, 5, 0, 0, osz, 0, 0);`);
  C(0x1a3, 0x1a3, `decode_modrm(); emit_g(H_G_BT_R, m_reg + 1, osz, 0);`);
  C(0x1ab, 0x1ab, `decode_modrm(); emit_g(H_G_BTS_R, m_reg + 1, osz, 0);`);
  C(0x1b3, 0x1b3, `decode_modrm(); emit_g(H_G_BTR_R, m_reg + 1, osz, 0);`);
  C(0x1bb, 0x1bb, `decode_modrm(); emit_g(H_G_BTC_R, m_reg + 1, osz, 0);`);
  C(0x1ba, 0x1ba, `decode_modrm(); dfetch8();
    if (m_reg < 4) { emit(H_UD, 0, 0, 0, 0, 0, op); }
    else { if (m_mem == 0 && osz == 4 && m_reg < 7) { emit(H_BT_RI + m_reg - 4, m_rm + 1, 0, 0, 0, 0, POW2[db % 32 + 1]); }
    else { emit_g(H_G_BT_I + (m_reg - 4) * 2, 0, osz, db); } }`);
  C(0x1a4, 0x1a4, `decode_modrm(); dfetch8(); emit_g(H_G_SHLD, m_reg + 1, osz, db);`);
  C(0x1a5, 0x1a5, `decode_modrm(); emit_g(H_G_SHLD, m_reg + 1, osz, 256);`);
  C(0x1ac, 0x1ac, `decode_modrm(); dfetch8(); emit_g(H_G_SHRD, m_reg + 1, osz, db);`);
  C(0x1ad, 0x1ad, `decode_modrm(); emit_g(H_G_SHRD, m_reg + 1, osz, 256);`);
  C(0x1af, 0x1af, `decode_modrm();
    if (p_osz == 1) { emit_g(H_G_IMUL2, m_reg + 1, 2, 0); }
    else { if (m_mem == 1) { ea_prep(1); emit(H_IMUL_RM_B + e_x, m_reg + 1, e_base, e_index, e_scale, e_disp, 0); } else { emit(H_IMUL_RR, m_reg + 1, m_rm + 1, 0, 0, 0, 0); } }`);
  C(0x1b0, 0x1b1, `decode_modrm(); if (op == 432) { emit_g(H_G_CMPXCHG, m_reg + 1, 1, 0); } else { emit_g(H_G_CMPXCHG, m_reg + 1, osz, 0); }`);
  C(0x1b2, 0x1b2, `decode_modrm(); ea_prep(0); emit(H_LXS, m_reg + 1, e_base, 0, osz, e_disp, 2);`);
  C(0x1b4, 0x1b5, `decode_modrm(); ea_prep(0); emit(H_LXS, m_reg + 1, e_base, 0, osz, e_disp, op - 432);`);
  C(0x1b6, 0x1b7, `decode_modrm(); dec_movx(0);`);
  C(0x1be, 0x1bf, `decode_modrm(); dec_movx(1);`);
  C(0x1bc, 0x1bc, `decode_modrm(); emit_g(H_G_BSF, m_reg + 1, osz, 0);`);
  C(0x1bd, 0x1bd, `decode_modrm(); emit_g(H_G_BSR, m_reg + 1, osz, 0);`);
  C(0x1c0, 0x1c1, `decode_modrm(); if (op == 448) { emit_g(H_G_XADD, m_reg + 1, 1, 0); } else { emit_g(H_G_XADD, m_reg + 1, osz, 0); }`);
  C(0x1c8, 0x1cf, `emit(H_BSWAP, op - 455, 0, 0, 0, 0, 0);`);

  cases.sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < cases.length; i++) if (cases[i][0] <= cases[i - 1][1]) throw new Error('overlapping opcode cases at 0x' + cases[i][0].toString(16));
  // binary search over the ranges; gaps between ranges are unknown opcodes
  const tree = (lo, hi, ind) => {
    if (hi - lo === 1) {
      const [a, b, code] = cases[lo];
      const cond = a === b ? `op == ${a}` : `op >= ${a} && op <= ${b}`;
      return `${ind}if (${cond}) {${code}\n${ind}} else { ${UNK} }\n`;
    }
    const mid = (lo + hi) >> 1;
    return `${ind}if (op < ${cases[mid][0]}) {\n${tree(lo, mid, ind + '  ')}${ind}} else {\n${tree(mid, hi, ind + '  ')}${ind}}\n`;
  };

  const hasFuse = !!(cfg.fuse && cfg.fuse.patterns && cfg.fuse.patterns.length);
  const FUSION = hasFuse ? `// ---- fusion (see handlers.js): the instruction just emitted at tw - 1 joins the entry at f_tw
const NHF = ${cfg.nhandlers || 1};
list FUSE = data("fuse"); list FMAP = data("fmap"); list FPOW = data("fpow");
var f_prev = 0, f_tw = 0, f_g = 0, f_s = 0, f_m = 0, e_last = 0, fuse_on = ${cfg.fuseOff ? 0 : 1}, n_fused = 0;
proc fuse_put(k, v) {
  if (k == 0) { return; }
  if (k == 1) { tA[f_tw] = v; return; }
  if (k == 2) { tB[f_tw] = v; return; }
  if (k == 3) { tC[f_tw] = v; return; }
  if (k == 4) { tD[f_tw] = v; return; }
  if (k == 5) { tE[f_tw] = v; return; }
  tF[f_tw] = v;
}
proc fuse_try() {
  if (f_prev > 0) {
    f_g = FUSE[(f_prev - 1) * NHF + e_last];
    if (f_g > 0) {
      f_s = tw - 1; f_m = (f_g - 1) * 6;
      fuse_put(FMAP[f_m + 1], tA[f_s]); fuse_put(FMAP[f_m + 2], tB[f_s]); fuse_put(FMAP[f_m + 3], tC[f_s]);
      fuse_put(FMAP[f_m + 4], tD[f_s]); fuse_put(FMAP[f_m + 5], tE[f_s]); fuse_put(FMAP[f_m + 6], tF[f_s]);
      tO[f_tw] += (tI[f_s] - tI[f_tw]) * FPOW[f_g];
      tH[f_tw] = HMAP[f_g];
      tw -= 1; f_prev = f_g; n_fused += 1;
      return;
    }
  }
  f_prev = e_last; f_tw = tw - 1;
}

` : 'var f_prev = 0, n_fused = 0;';
  return `
const MAXBLK = ${cfg.maxBlock || 48};
list PFX = data("pfx");                 // per opcode byte: 0 = not a prefix
var d_eip = 0, d_q = 0, d_pageend = 0, d_first = 0, d_abort = 0, d_cross = 0, d_fault = 0, d_stop = 0, d_unc = 0;
var db = 0, dw = 0, dd = 0, imm = 0, osz = 4;
var op = 0, p_osz = 0, p_asz = 0, p_seg = 0, p_rep = 0, p_lock = 0, insn_eip = 0;
var m_mod = 0, m_reg = 0, m_rm = 0, m_mem = 0;
var e_base = 9, e_index = 9, e_scale = 1, e_disp = 0, e_x = 0;
var d_n = 0, d_cn = 0, d_k = 0, d_f = 0, d_t = 0, d_tag = 0, d_ci = 0, d_pp = 0, d_tw0 = 0, d_dst = 0, d_src = 0;

list WRA = data("wra");                 // by static handler id: 1 = stores into reg[tA]
var d_spw = 0;
proc emit(hh, x1, x2, x3, x4, x5, x6) {
  ${hasFuse ? 'e_last = hh; tO[tw] = 0;' : ''}
  if (x1 == 5) { if (WRA[hh] == 1) { d_spw = 1; } }     // esp gets written behind the stack window's back
  tH[tw] = HMAP[hh]; tA[tw] = x1; tB[tw] = x2; tC[tw] = x3; tD[tw] = x4; tE[tw] = x5; tF[tw] = x6; tI[tw] = insn_eip;
  tw += 1;
}
proc emit_end(target) {
  tH[tw] = HMAP[H_END]; tA[tw] = 0; tB[tw] = 0 - 1; tC[tw] = 0; tD[tw] = 0; tE[tw] = 0; tF[tw] = target; tI[tw] = target;
  tw += 1; d_stop = 1;
}

// ---- instruction byte fetch. code bytes are read through the page the block lives in; an instruction that
// runs off the end of that page is either pushed into the next block, or (when it is the first one) decoded
// through a second translation and executed uncached.
proc dfetch8() {
  if (d_fault == 1) { db = 0; return; }
  if (d_eip >= d_pageend) {
    if (d_first == 0) { d_abort = 1; db = 0; d_eip += 1; return; }
    if (d_cross == 0) {
      d_cross = 1;
      q = tlbR[floor(d_eip / 4096) + tlbOff];
      if (q == 0) {
        fetching = 1; flt = 0;
        tlb_fill(d_eip, 0);
        fetching = 0;
        if (flt == 1) { d_fault = 1; db = 0; return; }
      }
      d_q = q; d_pageend += 4096;
    }
  }
  db = floor(itemf(memw, d_q + d_eip / 4) / POW256[d_eip % 4 + 1]) % 256;
  d_eip += 1;
}
proc dfetch16() { dfetch8(); dw = db; dfetch8(); dw += db * 256; }
proc dfetch32() { dfetch8(); dd = db; dfetch8(); dd += db * 256; dfetch8(); dd += db * 65536; dfetch8(); dd += db * 16777216; }
proc dimm8s() { dfetch8(); imm = db + (db > 127) * 4294967040; }
proc dimmv() { if (p_osz == 1) { dfetch16(); imm = dw; } else { dfetch32(); imm = dd; } }

proc decode_modrm() {
  dfetch8();
  m_mod = floor(db / 64); m_reg = floor(db / 8) % 8; m_rm = db % 8;
  if (m_mod == 3) { m_mem = 0; return; }
  m_mem = 1; e_index = 9; e_scale = 1; e_disp = 0;
  if (p_asz == 1) { decode_modrm16(); return; }
  if (m_rm == 4) {
    dfetch8();
    d_t = floor(db / 8) % 8;
    if (d_t != 4) { e_index = d_t + 1; e_scale = POW2[floor(db / 64) + 1]; }
    e_base = db % 8 + 1;
    if (e_base == 6) { if (m_mod == 0) { e_base = 9; dfetch32(); e_disp = dd; return; } }
  } else {
    if (m_rm == 5) { if (m_mod == 0) { e_base = 9; dfetch32(); e_disp = dd; return; } }
    e_base = m_rm + 1;
  }
  if (m_mod == 1) { dfetch8(); e_disp = db + (db > 127) * 4294967040; }
  if (m_mod == 2) { dfetch32(); e_disp = dd; }
}
// 16-bit addressing: rare enough that it is always lowered through LEA16_TMP
proc decode_modrm16() {
  e_base = 9; e_index = 9;
  if (m_rm == 0) { e_base = 4; e_index = 7; } else { if (m_rm == 1) { e_base = 4; e_index = 8; }
  else { if (m_rm == 2) { e_base = 6; e_index = 7; } else { if (m_rm == 3) { e_base = 6; e_index = 8; }
  else { if (m_rm == 4) { e_base = 7; } else { if (m_rm == 5) { e_base = 8; }
  else { if (m_rm == 6) { if (m_mod > 0) { e_base = 6; } } else { e_base = 4; } } } } } } }
  if (m_mod == 0) { if (m_rm == 6) { dfetch16(); e_disp = dw; } }
  if (m_mod == 1) { dfetch8(); e_disp = db + (db > 127) * 65280; }
  if (m_mod == 2) { dfetch16(); e_disp = dw; }
  if (p_seg == 0) { p_seg = 9; }
  emit(H_LEA16_TMP, p_seg, e_base, e_index, 0, e_disp, 0);
  p_seg = 0; e_base = 16; e_index = 9; e_scale = 1; e_disp = 0;
}
// fold a segment override into the address and pick the B (base + disp) or X (base + index * scale + disp) form.
// handlers without an X variant get the address precomputed into reg[16] by a LEA_TMP entry.
proc ea_prep(hasx) {
  if (p_seg > 0) {
    if (e_index == 9) {
      if (e_base == 9) { e_base = p_seg; } else { e_index = p_seg; e_scale = 1; }
    } else {
      if (e_base == 9) { e_base = p_seg; }
      else { emit(H_LEA_TMP, p_seg, e_base, e_index, e_scale, e_disp, 0); e_base = 16; e_index = 9; e_scale = 1; e_disp = 0; }
    }
    p_seg = 0;
  }
  if (e_index == 9) { e_x = 0; }
  else {
    if (hasx == 1) { e_x = 1; }
    else { emit(H_LEA_TMP, 9, e_base, e_index, e_scale, e_disp, 0); e_base = 16; e_index = 9; e_scale = 1; e_disp = 0; e_x = 0; }
  }
  if (p_lock == 1) { emit(H_LOCK_PROBE, 0, e_base, e_index, e_scale, e_disp, 0); p_lock = 0; }
}
// generic-lane entry: r/m operand in tB/tC/tE, size in tD
proc emit_g(hh, av, sz, fv) {
  if (m_mem == 1) { ea_prep(0); emit(hh, av, e_base, 0, sz, e_disp, fv); }
  else { emit(hh, av, 0, m_rm + 1, sz, 0, fv); }
}
// specialised memory form with _B / _X variants (ids hb, hb + 1)
proc emit_m(hb, av, fv) {
  ea_prep(1);
  emit(hb + e_x, av, e_base, e_index, e_scale, e_disp, fv);
}

// ---- alu block 00..3f
proc dec_alu_ri(k, ri, v) {
  if (ri == 5) { if (v % 4 == 0 && v > 0 && v < 4096) {
    if (k == 0) { emit(H_ADDSP_I, 0, 0, 0, v / 4, 1023 - v / 4, v); return; }
    if (k == 5) { emit(H_SUBSP_I, 0, 0, 0, v / 4, v / 4 - 1, v); return; }
  } }
  if (k == 4) {
    if (v == UMAX) { emit(H_TESTSELF_R, ri, 0, 0, 0, 0, 0); return; }
    if (indexof(POW2, v + 1) > 0) { emit(H_ANDLO_RI, ri, 0, 0, 0, 0, v + 1); return; }
    if (indexof(POW2, M32 - v) > 0) { emit(H_ANDHI_RI, ri, 0, 0, 0, 0, M32 - v); return; }
  }
  emit(H_ADD_RI + k * 8, ri, 0, 0, 0, 0, v);
}
proc dec_test_ri(ri, v) {
  if (v > 0) {
    if (indexof(POW2, v) > 0) { emit(H_TESTBIT_RI, ri, 0, 0, 0, 0, v); return; }
    if (indexof(POW2, v + 1) > 0) { emit(H_TESTLO_RI, ri, 0, 0, 0, 0, v + 1); return; }
  }
  emit(H_TEST_RI, ri, 0, 0, 0, 0, v);
}
proc dec_alu(k, f) {
  if (f == 4) {                                   // al, imm8
    dfetch8();
    if (k == 7) { emit(H_CMPB_RI, 1, 0, 0, 0, 0, db * 16777216); }
    else { if (k == 4) { emit(H_ANDB_RI, 1, 0, 0, 0, 0, db + 1); } else { emit(H_G_ADD_EI + k * 3, 0, 0, 1, 1, 0, db); } }
    return;
  }
  if (f == 5) {                                   // eax, imm
    dimmv();
    if (p_osz == 1) { emit(H_G_ADD_EI + k * 3, 0, 0, 1, 2, 0, imm); } else { dec_alu_ri(k, 1, imm); }
    return;
  }
  decode_modrm();
  if (f % 2 == 0) {                               // 8-bit: f = 0 Eb,Gb   f = 2 Gb,Eb
    if (k == 7) { if (m_reg < 4) {
      if (m_mem == 1) { if (f == 0) { emit_m(H_CMPB_MR_B, m_reg + 1, 0); } else { emit_m(H_CMPB_RM_B, m_reg + 1, 0); } return; }
      if (m_rm < 4) { if (f == 0) { emit(H_CMPB_RR, m_rm + 1, m_reg + 1, 0, 0, 0, 0); } else { emit(H_CMPB_RR, m_reg + 1, m_rm + 1, 0, 0, 0, 0); } return; }
    } }
    emit_g(H_G_ADD_EG + k * 3 + f / 2, m_reg + 1, 1, 0);
    return;
  }
  if (p_osz == 1) { emit_g(H_G_ADD_EG + k * 3 + (f - 1) / 2, m_reg + 1, 2, 0); return; }
  if (m_mem == 1) {
    if (f == 1) { emit_m(H_ADD_MR_B + k * 8, m_reg + 1, 0); } else { emit_m(H_ADD_RM_B + k * 8, m_reg + 1, 0); }
    return;
  }
  if (f == 1) { d_dst = m_rm + 1; d_src = m_reg + 1; } else { d_dst = m_reg + 1; d_src = m_rm + 1; }
  if (d_dst == d_src) {
    if (k == 6 || k == 5) { emit(H_ZERO_R, d_dst, 0, 0, 0, 0, 0); return; }
    if (k == 4 || k == 1) { emit(H_TESTSELF_R, d_dst, 0, 0, 0, 0, 0); return; }
  }
  emit(H_ADD_RR + k * 8, d_dst, d_src, 0, 0, 0, 0);
}
// 80..83: op r/m, imm
proc dec_grp1() {
  if (op == 129) { dimmv(); } else { if (op == 131) { dimm8s(); if (p_osz == 1) { imm = imm % 65536; } } else { dfetch8(); imm = db; } }
  if (op % 2 == 0) {                              // 80 / 82: 8-bit
    if (m_reg == 7) {
      if (m_mem == 1) { emit_m(H_CMPB_MI_B, 0, imm * 16777216); return; }
      if (m_rm < 4) { emit(H_CMPB_RI, m_rm + 1, 0, 0, 0, 0, imm * 16777216); return; }
    }
    if (m_reg == 4) { if (m_mem == 0 && m_rm < 4) { emit(H_ANDB_RI, m_rm + 1, 0, 0, 0, 0, imm + 1); return; } }
    emit_g(H_G_ADD_EI + m_reg * 3, 0, 1, imm);
    return;
  }
  if (p_osz == 1) { emit_g(H_G_ADD_EI + m_reg * 3, 0, 2, imm); return; }
  if (m_mem == 1) { emit_m(H_ADD_MI_B + m_reg * 8, 0, imm); } else { dec_alu_ri(m_reg, m_rm + 1, imm); }
}
proc dec_test_eg() {
  if (op == 132) {
    if (m_mem == 0) { if (m_rm < 4) { if (m_reg < 4) { emit(H_TESTB_RR, m_rm + 1, m_reg + 1, 0, 0, 0, 0); return; } } }
    emit_g(H_G_TEST_EG, m_reg + 1, 1, 0);
    return;
  }
  if (p_osz == 1) { emit_g(H_G_TEST_EG, m_reg + 1, 2, 0); return; }
  if (m_mem == 1) { emit_m(H_TEST_MR_B, m_reg + 1, 0); return; }
  if (m_rm == m_reg) { emit(H_TESTSELF_R, m_rm + 1, 0, 0, 0, 0, 0); } else { emit(H_TEST_RR, m_rm + 1, m_reg + 1, 0, 0, 0, 0); }
}
// 88..8b
proc dec_mov() {
  if (op == 136) {                                // Eb <- Gb
    if (m_reg < 4) {
      if (m_mem == 1) { emit_m(H_MOVB_MR_B, m_reg + 1, 0); return; }
      if (m_rm < 4) { emit(H_MOVB_RR, m_rm + 1, m_reg + 1, 0, 0, 0, 0); return; }
    }
    emit_g(H_G_MOV_EG, m_reg + 1, 1, 0); return;
  }
  if (op == 138) {                                // Gb <- Eb
    if (m_reg < 4) {
      if (m_mem == 1) { emit_m(H_MOVB_RM_B, m_reg + 1, 0); return; }
      if (m_rm < 4) { emit(H_MOVB_RR, m_reg + 1, m_rm + 1, 0, 0, 0, 0); return; }
    }
    emit_g(H_G_MOV_GE, m_reg + 1, 1, 0); return;
  }
  // [esp + 4n] with nothing else going on reads and writes straight through the stack window
  d_t = 0;
  if (m_mem == 1) { if (e_base == 5 && e_index == 9 && p_seg == 0 && p_lock == 0) { if (e_disp < 4096 && e_disp % 4 == 0) { d_t = 1; } } }
  if (op == 137) {                                // Ev <- Gv
    if (p_osz == 1) { if (m_mem == 1) { emit_m(H_MOVW_MR_B, m_reg + 1, 0); } else { emit_g(H_G_MOV_EG, m_reg + 1, 2, 0); } return; }
    if (d_t == 1) { emit(H_MOV_MR_SP, m_reg + 1, 0, 0, 0, e_disp / 4, 1023 - e_disp / 4); return; }
    if (m_mem == 1) { emit_m(H_MOV_MR_B, m_reg + 1, 0); } else { emit(H_MOV_RR, m_rm + 1, m_reg + 1, 0, 0, 0, 0); }
    return;
  }
  if (p_osz == 1) { if (m_mem == 1) { emit_m(H_MOVW_RM_B, m_reg + 1, 0); } else { emit_g(H_G_MOV_GE, m_reg + 1, 2, 0); } return; }
  if (d_t == 1 && m_reg != 4) { emit(H_MOV_RM_SP, m_reg + 1, 0, 0, 0, e_disp / 4, 1023 - e_disp / 4); return; }
  if (m_mem == 1) { emit_m(H_MOV_RM_B, m_reg + 1, 0); } else { emit(H_MOV_RR, m_reg + 1, m_rm + 1, 0, 0, 0, 0); }
}
// 0f b6/b7/be/bf
proc dec_movx(sgn) {
  d_t = 1 + op % 2;                               // source size
  if (p_osz == 1) { emit_g(H_G_MOVZX + sgn, m_reg + 1, d_t, 2); return; }
  if (d_t == 1) {
    if (m_mem == 1) { if (sgn == 1) { emit_m(H_MOVSXB_RM_B, m_reg + 1, 0); } else { emit_m(H_MOVZXB_RM_B, m_reg + 1, 0); } return; }
    if (m_rm < 4) { if (sgn == 1) { emit(H_MOVSXB_RR, m_reg + 1, m_rm + 1, 0, 0, 0, 0); } else { emit(H_MOVZXB_RR, m_reg + 1, m_rm + 1, 0, 0, 0, 0); } return; }
    emit_g(H_G_MOVZX + sgn, m_reg + 1, 1, 4); return;
  }
  if (m_mem == 1) { if (sgn == 1) { emit_m(H_MOVSXW_RM_B, m_reg + 1, 0); } else { emit_m(H_MOVZXW_RM_B, m_reg + 1, 0); } return; }
  if (sgn == 1) { emit(H_MOVSXW_RR, m_reg + 1, m_rm + 1, 0, 0, 0, 0); } else { emit(H_MOVZXW_RR, m_reg + 1, m_rm + 1, 0, 0, 0, 0); }
}
proc dec_imul3() {
  if (p_osz == 1) { emit_g(H_G_IMUL3, m_reg + 1, 2, imm); return; }
  if (m_mem == 1) { emit_g(H_G_IMUL3, m_reg + 1, 4, imm); } else { emit(H_IMUL_RRI, m_reg + 1, m_rm + 1, 0, 0, 0, imm); }
}
// c0 c1 d0..d3: rotate / shift r/m by cnt (256 = cl)
proc dec_shift(cnt) {
  if (op % 2 == 0) { emit_g(H_G_SHIFT, m_reg, 1, cnt); return; }
  if (p_osz == 1) { emit_g(H_G_SHIFT, m_reg, 2, cnt); return; }
  if (m_mem == 0) { if (cnt == 256) {
    if (m_reg == 4 || m_reg == 6) { emit(H_SHL_RC, m_rm + 1, 0, 0, 0, 0, 0); return; }
    if (m_reg == 5) { emit(H_SHR_RC, m_rm + 1, 0, 0, 0, 0, 0); return; }
  } }
  if (m_mem == 0) { if (cnt < 256) {
    d_cn = cnt % 32;
    if (d_cn == 0) { emit(H_NOP, 0, 0, 0, 0, 0, 0); return; }
    if (m_reg == 4 || m_reg == 6) { emit(H_SHL_RI, m_rm + 1, 0, 0, 0, POW2[33 - d_cn], POW2[d_cn + 1]); return; }
    if (m_reg == 5) { emit(H_SHR_RI, m_rm + 1, 0, 0, d_cn == 1, POW2[d_cn], POW2[d_cn + 1]); return; }
    if (m_reg == 7) { emit(H_SAR_RI, m_rm + 1, 0, M32 - POW2[33 - d_cn], 0, POW2[d_cn], POW2[d_cn + 1]); return; }
  } }
  emit_g(H_G_SHIFT, m_reg, 4, cnt);
}
// f6 / f7
proc dec_grp3() {
  d_t = osz; if (op == 246) { d_t = 1; }
  if (m_reg < 2) {                                // test r/m, imm
    if (d_t == 1) {
      dfetch8();
      if (m_mem == 1) { emit_m(H_TESTB_MI_B, 0, db + 1); return; }
      if (m_rm < 4) { emit(H_TESTB_RI, m_rm + 1, 0, 0, 0, 0, db + 1); return; }
      emit_g(H_G_TEST_EI, 0, 1, db); return;
    }
    dimmv();
    if (d_t == 2) { emit_g(H_G_TEST_EI, 0, 2, imm); return; }
    if (m_mem == 0) { dec_test_ri(m_rm + 1, imm); return; }
    if (imm > 0) { if (indexof(POW2, imm) > 0) { emit_m(H_TESTBIT_MI_B, 0, imm); return; } }
    emit_m(H_TEST_MI_B, 0, imm); return;
  }
  if (d_t == 4) { if (m_mem == 0) {
    if (m_reg == 2) { emit(H_NOT_R, m_rm + 1, 0, 0, 0, 0, 0); return; }
    if (m_reg == 3) { emit(H_NEG_R, m_rm + 1, 0, 0, 0, 0, 0); return; }
  } }
  emit_g(H_G_NOT + m_reg - 2, 0, d_t, 0);         // G_NOT G_NEG G_MUL G_IMUL1 G_DIV G_IDIV are consecutive
}
// ff
proc dec_grp5() {
  if (m_reg < 2) {
    if (p_osz == 1) { emit_g(H_G_INC + m_reg, 0, 2, 0); return; }
    if (m_mem == 1) { emit_m(H_INC_M_B + m_reg * 2, 0, 0); } else { emit(H_INC_R + m_reg, m_rm + 1, 0, 0, 0, 0, 0); }
    return;
  }
  if (m_reg == 2) {
    if (m_mem == 1) { emit_m(H_CALL_M_B, 0, d_eip); } else { emit(H_CALL_R, m_rm + 1, 0, 0, 0, d_eip, 0); }
    d_stop = 1; return;
  }
  if (m_reg == 4) {
    if (m_mem == 1) { emit_m(H_JMP_M_B, 0, 0); } else { emit(H_JMP_R, m_rm + 1, 0, 0, 0, 0, 0); }
    d_stop = 1; return;
  }
  if (m_reg == 6) {
    if (p_osz == 1) { emit_g(H_G_PUSH, 0, 2, 0); return; }
    if (m_mem == 1) { emit_m(H_PUSH_M_B, 0, 0); } else { emit(H_PUSH_R, m_rm + 1, 0, 0, 0, 0, 0); }
    return;
  }
  if (m_mem == 1) {
    if (m_reg == 3) { ea_prep(0); emit(H_CALLF_M, 0, e_base, 0, osz, e_disp, d_eip); d_stop = 1; return; }
    if (m_reg == 5) { ea_prep(0); emit(H_JMPF_M, 0, e_base, 0, osz, e_disp, 0); d_stop = 1; return; }
  }
  emit(H_UD, 0, 0, 0, 0, 0, op);
}

${FUSION}
// decode one instruction at d_eip into trace entries at tw
proc decode_insn() {
  insn_eip = d_eip; p_osz = 0; p_asz = 0; p_seg = 0; p_rep = 0; p_lock = 0; osz = 4; d_spw = 0;
  dfetch8(); op = db;
  until (PFX[op + 1] == 0) {
    d_t = PFX[op + 1];
    if (d_t == 1) { p_osz = 1; osz = 2; } else { if (d_t == 3) { p_lock = 1; } if (d_t == 2) { p_asz = 1; } else { if (d_t == 4) { p_rep = 2; } else { if (d_t == 5) { p_rep = 1; } else { if (d_t > 13) { p_seg = d_t; } } } } }
    if (d_abort == 1 || d_fault == 1) { return; }
    dfetch8(); op = db;
  }
  if (op == 15) { dfetch8(); op = 256 + db; }
${tree(0, cases.length, '  ')}
}

// ---- the seed: blocks that were decoded when the project was built (tools/mkseed.js boots the same kernel on
// the js build and keeps what the decoder produced). they sit in the trace lists from the start. a seed block
// is used when it was decoded at this eip from exactly the memory words that are there now.
const SEED_P = ${cfg.seedP || 61};
list sd_eip = data("sd_eip"); list sd_tp = data("sd_tp"); list sd_nw = data("sd_nw"); list sd_w0 = data("sd_w0"); list sd_words = data("sd_words");
var s_hit = 0, s_i = 0, s_k = 0, s_a = 0, s_ok = 0, n_seeded = 0, seed_on = ${cfg.seedOff ? 0 : 1};
proc seed_try() {
  s_hit = 0;
  if (seed_on == 0) { return; }
  s_i = eip % SEED_P + 1;
  until (sd_eip[s_i] == 0) {
    if (sd_eip[s_i] == eip) {
      s_k = sd_w0[s_i]; s_a = d_q + floor(eip / 4); s_ok = 1;
      repeat (sd_nw[s_i]) { if (memw[s_a] != sd_words[s_k]) { s_ok = 0; } s_a += 1; s_k += 1; }
      if (s_ok == 1) { s_hit = 1; return; }
    }
    s_i = s_i % SEED_P + 1;
  }
}

// decode the block at eip (find_block has already set vp, q, pk, ci) and point tp at it
proc decode_block() {
  d_ci = ci;
  if (d_unc == 1) { chain_ok = 0; d_unc = 0; }    // the previous decode left an uncached block at tnext: we are about to overwrite it
  if (tnext > TR_LIMIT) { flush_blocks(); }
  d_pp = floor((pk - 4) / 4096);
  d_tag = pk + vp * 33554432 + pgGen[d_pp + 1] * GENMUL;
  if (codepg[d_pp + 1] == 0) { codepg[d_pp + 1] = 1; tlbw_flush(); }
  d_q = q; d_pageend = (vp + 1) * 4096;
  seed_try();
  if (s_hit == 1) { bkTag[d_ci] = d_tag; bkTp[d_ci] = sd_tp[s_i]; tp = sd_tp[s_i]; nblocks += 1; n_seeded += 1; return; }
  d_eip = eip; tw = tnext; d_first = 1; d_abort = 0; d_cross = 0; d_fault = 0; d_stop = 0; d_n = 0; f_prev = 0;
  until (d_stop == 1) {
    d_tw0 = tw;
    decode_insn();
    ${cfg.unitProf ? 'if (tw > d_tw0) { tL[tw - 1] = d_eip - insn_eip; }' : ''}
    if (d_fault == 1) { flt = 0; return; }        // #PF while fetching: delivered, tp is at the handler
    if (d_cross == 1) {
      // the first instruction straddles two pages: run it once from here without caching it
      if (d_stop == 0) { emit_end(d_eip); }
      tp = tnext; d_unc = 1; chain_ok = 0;
      return;
    }
    if (d_abort == 1) { tw = d_tw0; emit_end(insn_eip); }
    else {
      d_first = 0; d_n += 1;
      // one plain trace entry for this instruction: see whether it fuses onto the one before
      ${hasFuse ? 'if (tw == d_tw0 + 1 && d_spw == 0) { if (fuse_on == 1) { fuse_try(); } } else { f_prev = 0; }' : ''}
      // it wrote esp without telling the stack window. the fix-up entry belongs to the next instruction (that
      // is where an interrupt taken between the two resumes; interrupt delivery resets the window itself)
      if (d_spw == 1) { insn_eip = d_eip; emit(H_SPSYNC, 0, 0, 0, 0, 0, 0); d_spw = 0; }
      if (d_stop == 0) { if (d_n >= MAXBLK || d_eip >= d_pageend) { emit_end(d_eip); } }
    }
  }
  bkTag[d_ci] = d_tag; bkTp[d_ci] = tnext;
  ${cfg.unitProf ? 'host("blk", tnext, tw, d_q);' : ''}${cfg.seedCapture ? 'host("seedblk", tnext, tw, d_q, eip, d_eip);' : ''}
  tp = tnext; tnext = tw; nblocks += 1;
}
`;
};
