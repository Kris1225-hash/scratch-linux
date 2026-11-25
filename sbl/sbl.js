'use strict';
// SBL: a tiny imperative language that compiles to Scratch 3 blocks (.sb3) and to JavaScript.
//
// Scratch has numbers, strings, lists, global variables and custom blocks. No bitwise ops, no locals,
// no return values. SBL is exactly that, with C-ish syntax, so one source can run in a real Scratch VM
// and (compiled to JS) under node at full speed for debugging.
//
//   const N = 1 << 12;                    compile-time constant
//   var a = 0, b;                         scratch variable on the current target
//   list reg[16];                         zero-filled list
//   list t = [1, 2, 3];   list img = data("kernel");
//   proc name(x, y) { ... }               custom block, "run without screen refresh"
//   proc name(x) nowarp { ... }
//   on flag { ... }   on key "space" { ... }   on broadcast "msg" { ... }   on stageclick { ... }   on spriteclick { ... }
//   target Name;                          following items belong to that sprite / the stage
//
//   a = e;  a += e;  a -= e;  L[i] = e;  L[i] += e;
//   if (c) {..} else if (c) {..} else {..}   while (c) {..}   until (c) {..}   repeat (n) {..}   forever {..}
//   return;  stopall;  name(args);
//
// Lists are 1-based like Scratch. `%` is Scratch's floored mod. `L[i]` must be an in-range integer index
// (checked in strict JS builds); `itemf(L, i)` is the explicit "let Scratch floor the index" form.

class SblError extends Error {}

// ---------------------------------------------------------------- tokenizer

function tokenize(src, file) {
  const toks = [];
  let i = 0, line = 1;
  const n = src.length;
  const err = (m) => { throw new SblError(`${file}:${line}: ${m}`); };
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    if (c === '#' && src.startsWith('#line ', i)) {      // `#line 12 "file"` markers from the template assembler
      const m = /^#line (\d+) "([^"]*)"/.exec(src.slice(i, i + 200));
      if (!m) err('bad #line');
      line = +m[1] - 1; file = m[2];
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i;
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        j = i + 2; while (j < n && /[0-9a-fA-F_]/.test(src[j])) j++;
        toks.push({ k: 'num', v: parseInt(src.slice(i + 2, j).replace(/_/g, ''), 16), line, file });
      } else {
        while (j < n && /[0-9_]/.test(src[j])) j++;
        if (src[j] === '.' && /[0-9]/.test(src[j + 1])) { j++; while (j < n && /[0-9]/.test(src[j])) j++; }
        if ((src[j] === 'e' || src[j] === 'E') && /[-+0-9]/.test(src[j + 1])) { j += 2; while (j < n && /[0-9]/.test(src[j])) j++; }
        toks.push({ k: 'num', v: Number(src.slice(i, j).replace(/_/g, '')), line, file });
      }
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1; while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ k: 'id', v: src.slice(i, j), line, file }); i = j; continue;
    }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') { j++; const e = src[j]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e; }
        else { if (src[j] === '\n') line++; s += src[j]; }
        j++;
      }
      if (j >= n) err('unterminated string');
      toks.push({ k: 'str', v: s, line, file }); i = j + 1; continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '<<', '>>'].includes(two)) { toks.push({ k: 'op', v: two, line, file }); i += 2; continue; }
    if ('+-*/%<>=!()[]{},;'.includes(c)) { toks.push({ k: 'op', v: c, line, file }); i++; continue; }
    err(`unexpected character ${JSON.stringify(c)}`);
  }
  toks.push({ k: 'eof', v: '<eof>', line, file });
  return toks;
}

// ---------------------------------------------------------------- builtins

// expression builtins: name -> [argc, resultType]
const EXPR_BUILTINS = {
  floor: [1, 'num'], ceil: [1, 'num'], abs: [1, 'num'], round: [1, 'num'], sqrt: [1, 'num'],
  len: [1, 'num'], strlen: [1, 'num'], letter: [2, 'str'], join: [2, 'str'],
  indexof: [2, 'num'], contains: [2, 'bool'], itemf: [2, 'any'],
  timer: [0, 'num'], days2000: [0, 'num'], answer: [0, 'str'], keydown: [1, 'bool'], mousedown: [0, 'bool'],
  costume_num: [0, 'num'], current: [1, 'num'], hostf: [-1, 'num'], strcontains: [2, 'bool'],
  mousex: [0, 'num'], mousey: [0, 'num'], username: [0, 'str'],
};
// statement builtins: name -> argc
const STMT_BUILTINS = {
  push: 2, clear: 1, del: 2, insert: 3, wait: 1, broadcast: 1, broadcast_wait: 1, ask: 1,
  stamp: 0, pen_clear: 0, pen_down: 0, pen_up: 0, pen_color: 1, pen_size: 1,
  goto: 2, setx: 1, sety: 1, costume: 1, show: 0, hide: 0, size: 1, say: 1, think: 1, reset_timer: 0,
  show_list: 1, hide_list: 1, show_var: 1, hide_var: 1, front: 0, stop_other: 0, host: -1,
  set_effect: 2, clear_effects: 0, backdrop: 1,
};
const LIST_ARG0 = new Set(['len', 'indexof', 'contains', 'itemf', 'push', 'clear', 'del', 'insert', 'show_list', 'hide_list']);

// ---------------------------------------------------------------- parser

function smod(n, m) { let r = n % m; if (r / m < 0) r += m; return r; }

class Parser {
  constructor(src, file, consts) {
    this.toks = tokenize(src, file);
    this.p = 0;
    this.consts = consts;           // Map name -> number|string (shared across units)
  }
  get t() { return this.toks[this.p]; }
  err(m, tok) { tok = tok || this.t; throw new SblError(`${tok.file}:${tok.line}: ${m} (near ${JSON.stringify(String(tok.v))})`); }
  isOp(v) { const t = this.t; return t.k === 'op' && t.v === v; }
  isId(v) { const t = this.t; return t.k === 'id' && t.v === v; }
  eat(v) { if (this.isOp(v)) { this.p++; return true; } return false; }
  expect(v) { if (!this.eat(v)) this.err(`expected '${v}'`); }
  ident() { const t = this.t; if (t.k !== 'id') this.err('expected identifier'); this.p++; return t.v; }

  program() {
    const items = [];
    while (this.t.k !== 'eof') items.push(this.item());
    return items;
  }

  item() {
    const t = this.t;
    if (t.k !== 'id') this.err('expected a top-level item');
    switch (t.v) {
      case 'const': {
        this.p++; const name = this.ident(); this.expect('=');
        const e = this.expr(); this.expect(';');
        const v = this.constValue(e, t);
        if (this.consts.has(name) && this.consts.get(name) !== v) this.err(`const ${name} redefined with a different value`, t);
        this.consts.set(name, v);
        return { t: 'nop' };
      }
      case 'var': {
        this.p++; const decls = [];
        do {
          const name = this.ident(); let init = 0;
          if (this.eat('=')) init = this.constValue(this.expr(), t);
          decls.push({ name, init });
        } while (this.eat(','));
        this.expect(';');
        return { t: 'vars', decls, tok: t };
      }
      case 'list': {
        this.p++; const name = this.ident();
        if (this.eat('[')) {
          const size = this.constValue(this.expr(), t); this.expect(']'); this.expect(';');
          return { t: 'list', name, size, tok: t };
        }
        this.expect('=');
        if (this.isId('data')) {
          this.p++; this.expect('('); const key = this.t; if (key.k !== 'str') this.err('expected data key string'); this.p++;
          this.expect(')'); this.expect(';');
          return { t: 'list', name, dataKey: key.v, tok: t };
        }
        this.expect('['); const vals = [];
        if (!this.isOp(']')) do { vals.push(this.constValue(this.expr(), t)); } while (this.eat(','));
        this.expect(']'); this.expect(';');
        return { t: 'list', name, values: vals, tok: t };
      }
      case 'proc': {
        this.p++; const name = this.ident(); this.expect('(');
        const params = [];
        if (!this.isOp(')')) do { params.push(this.ident()); } while (this.eat(','));
        this.expect(')');
        let warp = true;
        if (this.isId('nowarp')) { this.p++; warp = false; }
        const body = this.block(new Set(params));
        return { t: 'proc', name, params, warp, body, tok: t };
      }
      case 'on': {
        this.p++; const kind = this.ident(); let arg = null;
        if (kind === 'key' || kind === 'broadcast') { const s = this.t; if (s.k !== 'str') this.err('expected string'); this.p++; arg = s.v; }
        else if (kind !== 'flag' && kind !== 'stageclick' && kind !== 'spriteclick') this.err('expected flag, key, broadcast, stageclick or spriteclick', t);
        const body = this.block(new Set());
        return { t: 'hat', kind, arg, body, tok: t };
      }
      case 'target': { this.p++; const name = this.ident(); this.expect(';'); return { t: 'target', name, tok: t }; }
    }
    this.err('expected const, var, list, proc, on or target');
  }

  constValue(e, tok) {
    if (e.t === 'num' || e.t === 'str') return e.v;
    this.err('expected a compile-time constant', tok);
  }

  block(params) {
    this.expect('{'); const out = [];
    while (!this.isOp('}')) { if (this.t.k === 'eof') this.err('unterminated block'); out.push(this.stmt(params)); }
    this.p++;
    return out;
  }

  stmt(params) {
    const t = this.t;
    if (t.k !== 'id') this.err('expected a statement');
    switch (t.v) {
      case 'if': {
        this.p++; this.expect('('); const c = this.expr(params); this.expect(')');
        const a = this.block(params); let b = null;
        if (this.isId('else')) { this.p++; b = this.isId('if') ? [this.stmt(params)] : this.block(params); }
        return { t: 'if', c, a, b, tok: t };
      }
      case 'while': { this.p++; this.expect('('); const c = this.expr(params); this.expect(')'); return { t: 'until', c: neg(c), body: this.block(params), tok: t }; }
      case 'until': { this.p++; this.expect('('); const c = this.expr(params); this.expect(')'); return { t: 'until', c, body: this.block(params), tok: t }; }
      case 'repeat': { this.p++; this.expect('('); const n = this.expr(params); this.expect(')'); return { t: 'repeat', n, body: this.block(params), tok: t }; }
      case 'forever': { this.p++; return { t: 'forever', body: this.block(params), tok: t }; }
      case 'return': { this.p++; this.expect(';'); return { t: 'return', tok: t }; }
      case 'stopall': { this.p++; this.expect(';'); return { t: 'stopall', tok: t }; }
    }
    const name = this.ident();
    if (this.eat('(')) {
      const args = [];
      if (!this.isOp(')')) do { args.push(this.callArg(name, args.length, params)); } while (this.eat(','));
      this.expect(')'); this.expect(';');
      return { t: 'call', name, args, tok: t };
    }
    if (this.eat('[')) {
      const idx = this.expr(params); this.expect(']');
      const op = this.t; this.p++;
      if (op.k !== 'op' || !['=', '+=', '-='].includes(op.v)) this.err("expected '=', '+=' or '-='", op);
      let e = this.expr(params); this.expect(';');
      if (op.v !== '=') e = fold({ t: 'bin', op: op.v[0], a: { t: 'item', list: name, idx, tok: t }, b: e, tok: t });
      return { t: 'lset', list: name, idx, e, tok: t };
    }
    const op = this.t; this.p++;
    if (op.k !== 'op' || !['=', '+=', '-='].includes(op.v)) this.err("expected '=', '+=', '-=', '(' or '['", op);
    const e = this.expr(params); this.expect(';');
    if (params.has(name) || this.consts.has(name)) this.err(`cannot assign to ${name}`, t);
    if (op.v === '=') return { t: 'set', name, e, tok: t };
    return { t: 'chg', name, e: op.v === '+=' ? e : fold({ t: 'un', op: '-', a: e, tok: t }), tok: t };
  }

  callArg(fname, idx, params) {
    // first argument of list builtins is a bare list name
    if (idx === 0 && LIST_ARG0.has(fname)) { const tok = this.t; return { t: 'listref', name: this.ident(), tok }; }
    return this.expr(params);
  }

  expr(params) { return this.or(params || new Set()); }
  or(ps) { let a = this.and(ps); while (this.isOp('||')) { const tok = this.t; this.p++; a = fold({ t: 'bin', op: '||', a, b: this.and(ps), tok }); } return a; }
  and(ps) { let a = this.cmp(ps); while (this.isOp('&&')) { const tok = this.t; this.p++; a = fold({ t: 'bin', op: '&&', a, b: this.cmp(ps), tok }); } return a; }
  cmp(ps) {
    let a = this.add(ps);
    while (this.t.k === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(this.t.v)) {
      const tok = this.t; this.p++; a = fold({ t: 'bin', op: tok.v, a, b: this.add(ps), tok });
    }
    return a;
  }
  add(ps) {
    let a = this.mul(ps);
    while (this.t.k === 'op' && (this.t.v === '+' || this.t.v === '-')) { const tok = this.t; this.p++; a = fold({ t: 'bin', op: tok.v, a, b: this.mul(ps), tok }); }
    return a;
  }
  mul(ps) {
    let a = this.unary(ps);
    while (this.t.k === 'op' && ['*', '/', '%', '<<', '>>'].includes(this.t.v)) { const tok = this.t; this.p++; a = fold({ t: 'bin', op: tok.v, a, b: this.unary(ps), tok }); }
    return a;
  }
  unary(ps) {
    const tok = this.t;
    if (this.eat('-')) return fold({ t: 'un', op: '-', a: this.unary(ps), tok });
    if (this.eat('!')) return neg(this.unary(ps));
    return this.primary(ps);
  }
  primary(ps) {
    const t = this.t;
    if (t.k === 'num') { this.p++; return { t: 'num', v: t.v, ty: 'num', tok: t }; }
    if (t.k === 'str') { this.p++; return { t: 'str', v: t.v, ty: 'str', tok: t }; }
    if (this.eat('(')) { const e = this.expr(ps); this.expect(')'); return e; }
    if (t.k !== 'id') this.err('expected an expression');
    this.p++;
    const name = t.v;
    if (this.eat('(')) {
      const args = [];
      if (!this.isOp(')')) do { args.push(this.callArg(name, args.length, ps)); } while (this.eat(','));
      this.expect(')');
      const bi = EXPR_BUILTINS[name];
      if (!bi) this.err(`unknown function ${name}() (procs have no return values)`, t);
      if (bi[0] >= 0 && bi[0] !== args.length) this.err(`${name}() takes ${bi[0]} argument(s)`, t);
      return fold({ t: 'fn', name, args, ty: bi[1], tok: t });
    }
    if (this.eat('[')) { const idx = this.expr(ps); this.expect(']'); return { t: 'item', list: name, idx, ty: 'any', tok: t }; }
    if (ps.has(name)) return { t: 'arg', name, ty: 'any', tok: t };
    if (this.consts.has(name)) { const v = this.consts.get(name); return typeof v === 'number' ? { t: 'num', v, ty: 'num', tok: t } : { t: 'str', v, ty: 'str', tok: t }; }
    return { t: 'var', name, ty: 'any', tok: t };
  }
}

const CMP_NEG = { '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
function neg(e) {
  if (e.t === 'un' && e.op === '!') return e.a;
  if (e.t === 'bin' && CMP_NEG[e.op]) return { ...e, op: CMP_NEG[e.op] };
  if (e.t === 'num') return { t: 'num', v: e.v ? 0 : 1, ty: 'num', tok: e.tok };
  return { t: 'un', op: '!', a: e, ty: 'bool', tok: e.tok };
}

const BOOL_OPS = new Set(['==', '!=', '<', '>', '<=', '>=', '&&', '||']);
function fold(e) {
  if (e.t === 'bin') {
    const { a, b, op } = e;
    e.ty = BOOL_OPS.has(op) ? 'bool' : 'num';
    if (a.t === 'num' && b.t === 'num') {
      let v;
      switch (op) {
        case '+': v = a.v + b.v; break; case '-': v = a.v - b.v; break; case '*': v = a.v * b.v; break;
        case '/': v = a.v / b.v; break; case '%': v = smod(a.v, b.v); break;
        case '<<': v = a.v * Math.pow(2, b.v); break; case '>>': v = Math.floor(a.v / Math.pow(2, b.v)); break;
        case '==': v = a.v === b.v ? 1 : 0; break; case '!=': v = a.v !== b.v ? 1 : 0; break;
        case '<': v = a.v < b.v ? 1 : 0; break; case '>': v = a.v > b.v ? 1 : 0; break;
        case '<=': v = a.v <= b.v ? 1 : 0; break; case '>=': v = a.v >= b.v ? 1 : 0; break;
        case '&&': v = (a.v && b.v) ? 1 : 0; break; case '||': v = (a.v || b.v) ? 1 : 0; break;
      }
      if (!Number.isFinite(v)) throw new SblError(`${e.tok.file}:${e.tok.line}: constant expression is not finite`);
      return { t: 'num', v, ty: 'num', tok: e.tok };
    }
    if (op === '<<' || op === '>>') {
      // shifts only exist at compile time; a shift by a constant becomes * or floor(/)
      if (b.t !== 'num') throw new SblError(`${e.tok.file}:${e.tok.line}: shift amount must be a constant`);
      const k = { t: 'num', v: Math.pow(2, b.v), ty: 'num', tok: e.tok };
      if (op === '<<') return fold({ t: 'bin', op: '*', a, b: k, tok: e.tok });
      return { t: 'fn', name: 'floor', args: [fold({ t: 'bin', op: '/', a, b: k, tok: e.tok })], ty: 'num', tok: e.tok };
    }
    // cheap identities
    if (op === '+' && b.t === 'num' && b.v === 0 && a.ty === 'num') return a;
    if (op === '+' && a.t === 'num' && a.v === 0 && b.ty === 'num') return b;
    if (op === '-' && b.t === 'num' && b.v === 0 && a.ty === 'num') return a;
    if (op === '*' && b.t === 'num' && b.v === 1 && a.ty === 'num') return a;
    if (op === '*' && a.t === 'num' && a.v === 1 && b.ty === 'num') return b;
    if (op === '/' && b.t === 'num' && b.v === 1 && a.ty === 'num') return a;
    return e;
  }
  if (e.t === 'un' && e.op === '-') {
    e.ty = 'num';
    if (e.a.t === 'num') return { t: 'num', v: -e.a.v, ty: 'num', tok: e.tok };
    return { t: 'bin', op: '-', a: { t: 'num', v: 0, ty: 'num', tok: e.tok }, b: e.a, ty: 'num', tok: e.tok };
  }
  if (e.t === 'fn') {
    const a = e.args;
    if (a.length === 1 && a[0].t === 'num') {
      const f = { floor: Math.floor, ceil: Math.ceil, abs: Math.abs, round: Math.round, sqrt: Math.sqrt }[e.name];
      if (f) return { t: 'num', v: f(a[0].v), ty: 'num', tok: e.tok };
    }
    if (e.name === 'join' && a[0].t !== 'var' && a[1].t !== 'var' && (a[0].t === 'str' || a[0].t === 'num') && (a[1].t === 'str' || a[1].t === 'num')) {
      return { t: 'str', v: String(a[0].v) + String(a[1].v), ty: 'str', tok: e.tok };
    }
    return e;
  }
  return e;
}

// ---------------------------------------------------------------- program model

// A Program collects parsed units per target and is consumed by the backends.
class Program {
  constructor(consts) {
    this.consts = new Map(Object.entries(consts || {}));
    this.targets = new Map();       // name -> { vars: Map, lists: Map, procs: Map, hats: [] }
    this.target('Stage');
  }
  target(name) {
    if (!this.targets.has(name)) this.targets.set(name, { name, vars: new Map(), lists: new Map(), procs: new Map(), hats: [] });
    return this.targets.get(name);
  }
  // parse a source unit; `file` names it in error messages
  add(src, file, targetName) {
    let cur = this.target(targetName || 'Stage');
    const items = new Parser(src, file || '<sbl>', this.consts).program();
    for (const it of items) {
      const where = it.tok ? `${it.tok.file}:${it.tok.line}` : file;
      if (it.t === 'target') cur = this.target(it.name);
      else if (it.t === 'vars') {
        for (const d of it.decls) {
          if (cur.vars.has(d.name) || cur.lists.has(d.name)) throw new SblError(`${where}: ${d.name} already declared`);
          cur.vars.set(d.name, { name: d.name, init: d.init });
        }
      } else if (it.t === 'list') {
        if (cur.vars.has(it.name) || cur.lists.has(it.name)) throw new SblError(`${where}: ${it.name} already declared`);
        cur.lists.set(it.name, { name: it.name, size: it.size, values: it.values, dataKey: it.dataKey });
      } else if (it.t === 'proc') {
        if (cur.procs.has(it.name)) throw new SblError(`${where}: proc ${it.name} already defined`);
        cur.procs.set(it.name, it);
      } else if (it.t === 'hat') cur.hats.push(it);
    }
    return this;
  }
}

// resolve a list's initial contents
function listInit(l, data) {
  if (l.values) return l.values;
  if (l.dataKey !== undefined) {
    if (!data || !(l.dataKey in data)) throw new SblError(`list ${l.name}: no data for key "${l.dataKey}"`);
    return data[l.dataKey];
  }
  return null;    // zero-filled, l.size entries
}

module.exports = { SblError, Program, EXPR_BUILTINS, STMT_BUILTINS, LIST_ARG0, neg, fold, smod, listInit };
