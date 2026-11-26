'use strict';
// SBL -> JavaScript. Same semantics as the Scratch build, minus the Scratch.
//
// genJS(program, opts) returns JS source for a factory `(H, D) => instance`:
//   H = host object (functions reachable through host()/hostf() and Scratch-only builtins)
//   D = data for `list x = data("key")`
//   instance = { vars (getters/setters), lists, procs, hats }
//
// opts.strict: every list access is checked to be an in-range integer index and every stored value a
// finite number. Scratch would silently floor / ignore / coerce; in the emulator any of those is a bug.

const { SblError } = require('./sbl');

function genJS(program, opts = {}) {
  const strict = !!opts.strict;
  const tgt = program.targets.get(opts.target || 'Stage');
  const out = [];
  const jsStr = (s) => JSON.stringify(s);
  const fail = (tok, m) => { throw new SblError(`${tok ? tok.file + ':' + tok.line : '?'}: ${m}`); };

  // which lists are structurally mutated (need a real Array)?
  const dynamic = new Set();
  const scan = (stmts) => {
    for (const s of stmts) {
      if (s.t === 'call' && ['push', 'clear', 'del', 'insert'].includes(s.name)) dynamic.add(s.args[0].name);
      if (s.a) scan(s.a); if (s.b) scan(s.b); if (s.body) scan(s.body);
    }
  };
  for (const p of tgt.procs.values()) scan(p.body);
  for (const h of tgt.hats) scan(h.body);

  let scope = null;   // current proc params
  let tmp = 0;

  const isNumLit = (e) => e.t === 'num';
  function num(e) {            // expression in numeric context
    const s = expr(e);
    return e.ty === 'bool' ? `+(${s})` : s;
  }
  function bool(e) {           // expression in boolean context
    if (e.t === 'num') return e.v ? 'true' : 'false';
    if (e.ty !== 'bool') fail(e.tok, 'condition must be a comparison (scratch needs a boolean block here)');
    return expr(e);
  }
  function listName(e, tok) {
    const n = e.t === 'listref' ? e.name : e;
    if (!tgt.lists.has(n)) fail(tok || e.tok, `unknown list ${n}`);
    return 'L_' + n;
  }
  function expr(e) {
    switch (e.t) {
      case 'num': return e.v < 0 || Object.is(e.v, -0) ? `(${e.v})` : String(e.v);
      case 'str': return jsStr(e.v);
      case 'arg': return 'a_' + e.name;
      case 'var':
        if (!tgt.vars.has(e.name)) fail(e.tok, tgt.lists.has(e.name) ? `${e.name} is a list` : `unknown variable ${e.name}`);
        return 'v_' + e.name;
      case 'item': {
        const L = listName(e.list, e.tok);
        return strict ? `rd(${L}, ${num(e.idx)}, ${jsStr(e.list)})` : `${L}[${num(e.idx)} - 1]`;
      }
      case 'un': return `!(${bool(e.a)})`;
      case 'bin': {
        const { op, a, b } = e;
        switch (op) {
          case '+': case '-': case '*': case '/': return `(${num(a)} ${op} ${num(b)})`;
          case '%': return `mod(${num(a)}, ${num(b)})`;
          case '==': return `(${num(a)} === ${num(b)})`;
          case '!=': return `(${num(a)} !== ${num(b)})`;
          case '<': case '>': case '<=': case '>=': return `(${num(a)} ${op} ${num(b)})`;
          case '&&': case '||': return `(${bool(a)} ${op} ${bool(b)})`;
        }
        fail(e.tok, `bad operator ${op}`); break;
      }
      case 'fn': {
        const a = e.args;
        switch (e.name) {
          case 'floor': return `Math.floor(${num(a[0])})`;
          case 'ceil': return `Math.ceil(${num(a[0])})`;
          case 'abs': return `Math.abs(${num(a[0])})`;
          case 'round': return `Math.round(${num(a[0])})`;
          case 'sqrt': return `Math.sqrt(${num(a[0])})`;
          case 'len': return `${listName(a[0])}.length`;
          case 'itemf': {
            const L = listName(a[0]);
            return strict ? `rdf(${L}, ${num(a[1])}, ${jsStr(a[0].name)})` : `${L}[Math.floor(${num(a[1])}) - 1]`;
          }
          case 'indexof': return `(Array.prototype.indexOf.call(${listName(a[0])}, ${num(a[1])}) + 1)`;
          case 'contains': return `(Array.prototype.indexOf.call(${listName(a[0])}, ${num(a[1])}) >= 0)`;
          case 'strlen': return `String(${expr(a[0])}).length`;
          case 'letter': return `(String(${expr(a[0])})[${num(a[1])} - 1] || "")`;
          case 'join': return `("" + ${expr(a[0])} + ${expr(a[1])})`;
          case 'hostf': {
            if (a[0].t !== 'str') fail(e.tok, 'hostf needs a function name string');
            return `H.${a[0].v}(${a.slice(1).map(num).join(', ')})`;
          }
          default: return `H.${e.name}(${a.map((x) => x.t === 'listref' ? listName(x) : expr(x)).join(', ')})`;
        }
      }
    }
    fail(e.tok, `cannot compile expression node ${e.t}`);
  }

  // ---- optional block accounting: OPS counts the scratch blocks that would have run, CALLS the custom block calls
  const countOps = !!opts.countOps;
  function eops(e) {
    if (!e) return 0;
    switch (e.t) {
      case 'num': case 'str': case 'listref': return 0;
      case 'var': case 'arg': return 1;
      case 'item': return 1 + eops(e.idx);
      case 'un': return 1 + eops(e.a);
      case 'bin': return 1 + eops(e.a) + eops(e.b);
      case 'fn': return 1 + e.args.reduce((n, x) => n + eops(x), 0);
    }
    return 0;
  }
  // estimated cost in the stock scratch interpreter, from test/bench_ops.js on an m5: a statement is ~55 ns,
  // each reporter block ~25 ns, entering a substack ~45 ns, a loop iteration ~75 ns, a custom block call ~250 ns
  function sns(s) {
    switch (s.t) {
      case 'set': case 'chg': return 55 + 25 * eops(s.e);
      case 'lset': return 55 + 25 * (eops(s.idx) + eops(s.e));
      case 'if': return s.c.t === 'num' ? 0 : 73 + 25 * eops(s.c);
      case 'call': return (tgt.procs.has(s.name) ? 250 : 55) + 25 * s.args.reduce((n, x) => n + eops(x), 0);
      case 'return': case 'stopall': return 55;
    }
    return 0;
  }
  function sops(s) {
    switch (s.t) {
      case 'set': case 'chg': return 1 + eops(s.e);
      case 'lset': return 1 + eops(s.idx) + eops(s.e);
      case 'if': return s.c.t === 'num' ? 0 : 1 + eops(s.c);
      case 'call': return 1 + s.args.reduce((n, x) => n + eops(x), 0);
      case 'return': case 'stopall': return 1;
    }
    return 0;
  }
  function stmts(list, ind, branch) {
    if (countOps && branch) out.push(`${ind}NS += 45;`);
    for (const s of list) {
      if (countOps) {
        const k = sops(s);
        if (k) out.push(`${ind}OPS += ${k}; NS += ${sns(s)};${s.t === 'call' && tgt.procs.has(s.name) ? ` CALLS++; PC.${s.name} = (PC.${s.name} || 0) + 1;` : ''}`);
      }
      stmt(s, ind);
    }
  }
  function stmt(s, ind) {
    switch (s.t) {
      case 'set':
        if (!tgt.vars.has(s.name)) fail(s.tok, `unknown variable ${s.name}`);
        out.push(strict ? `${ind}v_${s.name} = ck(${num(s.e)}, ${jsStr(s.name)});` : `${ind}v_${s.name} = ${num(s.e)};`);
        return;
      case 'chg':
        if (!tgt.vars.has(s.name)) fail(s.tok, `unknown variable ${s.name}`);
        out.push(strict ? `${ind}v_${s.name} = ck(v_${s.name} + ${num(s.e)}, ${jsStr(s.name)});` : `${ind}v_${s.name} += ${num(s.e)};`);
        return;
      case 'lset': {
        const L = listName(s.list, s.tok);
        out.push(strict ? `${ind}wr(${L}, ${num(s.idx)}, ${num(s.e)}, ${jsStr(s.list)});` : `${ind}${L}[${num(s.idx)} - 1] = ${num(s.e)};`);
        return;
      }
      case 'if': {
        if (s.c.t === 'num') { stmts(s.c.v ? s.a : (s.b || []), ind); return; }
        out.push(`${ind}if (${bool(s.c)}) {`); stmts(s.a, ind + '  ', true);
        if (s.b && s.b.length) { out.push(`${ind}} else {`); stmts(s.b, ind + '  ', true); }
        out.push(`${ind}}`);
        return;
      }
      case 'until':
        out.push(countOps ? `${ind}while ((OPS += ${1 + eops(s.c)}), (NS += ${110 + 25 * eops(s.c)}), !(${bool(s.c)})) {` : `${ind}while (!(${bool(s.c)})) {`); stmts(s.body, ind + '  '); out.push(`${ind}}`);
        return;
      case 'repeat': {
        const r = 'r' + (tmp++);
        out.push(`${ind}for (let ${r} = Math.round(${num(s.n)}); ${r} > 0; ${r}--) {`); if (countOps) out.push(`${ind}  OPS += ${1 + eops(s.n)}; NS += ${75 + 25 * eops(s.n)};`); stmts(s.body, ind + '  '); out.push(`${ind}}`);
        return;
      }
      case 'forever':
        out.push(`${ind}for (;;) {`); if (countOps) out.push(`${ind}  OPS += 1; NS += 75;`); stmts(s.body, ind + '  '); out.push(`${ind}}`);
        return;
      case 'return': out.push(`${ind}return;`); return;
      case 'stopall': out.push(`${ind}H.stopall(); return;`); return;
      case 'call': {
        const a = s.args;
        if (tgt.procs.has(s.name)) {
          const p = tgt.procs.get(s.name);
          if (p.params.length !== a.length) fail(s.tok, `${s.name}() takes ${p.params.length} argument(s)`);
          out.push(`${ind}p_${s.name}(${a.map(num).join(', ')});`);
          return;
        }
        switch (s.name) {
          case 'push': out.push(`${ind}${listName(a[0])}.push(${num(a[1])});`); return;
          case 'clear': out.push(`${ind}${listName(a[0])}.length = 0;`); return;
          case 'del': out.push(`${ind}${listName(a[0])}.splice(${num(a[1])} - 1, 1);`); return;
          case 'insert': out.push(`${ind}${listName(a[0])}.splice(${num(a[1])} - 1, 0, ${num(a[2])});`); return;
          case 'host':
            if (a[0].t !== 'str') fail(s.tok, 'host needs a function name string');
            out.push(`${ind}H.${a[0].v}(${a.slice(1).map(num).join(', ')});`);
            return;
        }
        fail(s.tok, `unknown proc ${s.name} (scratch-only builtins are not available in the js build)`);
      }
    }
    fail(s.tok, `cannot compile statement node ${s.t}`);
  }

  out.push(`(function (H, D) {`, `'use strict';`);
  out.push(`const mod = (n, m) => { let r = n % m; if (r / m < 0) r += m; return r; };`);
  if (opts.countOps) out.push(`let OPS = 0, CALLS = 0, NS = 0; const PC = {};`);
  if (strict) {
    out.push(
      `function rd(L, i, nm) { if (!(Number.isInteger(i) && i >= 1 && i <= L.length)) throw new Error('list ' + nm + ': bad read index ' + i + ' (len ' + L.length + ')'); return L[i - 1]; }`,
      `function rdf(L, i, nm) { const j = Math.floor(i); if (!(j >= 1 && j <= L.length)) throw new Error('list ' + nm + ': bad read index ' + i + ' (len ' + L.length + ')'); return L[j - 1]; }`,
      `function wr(L, i, v, nm) { if (!(Number.isInteger(i) && i >= 1 && i <= L.length)) throw new Error('list ' + nm + ': bad write index ' + i + ' (len ' + L.length + ')'); if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('list ' + nm + ': bad value ' + v); L[i - 1] = v; }`,
      `function ck(v, nm) { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('var ' + nm + ': bad value ' + v); return v; }`);
  }
  for (const v of tgt.vars.values()) out.push(v.dataKey !== undefined ? `let v_${v.name} = D[${jsStr(v.dataKey)}];` : `let v_${v.name} = ${jsStr(v.init)};`);
  for (const l of tgt.lists.values()) {
    if (dynamic.has(l.name)) {
      if (l.dataKey !== undefined) out.push(`const L_${l.name} = Array.from(D[${jsStr(l.dataKey)}]);`);
      else if (l.values) out.push(`const L_${l.name} = ${JSON.stringify(l.values)};`);
      else out.push(`const L_${l.name} = new Array(${l.size}).fill(0);`);
    } else if (l.dataKey !== undefined) out.push(`const L_${l.name} = Float64Array.from(D[${jsStr(l.dataKey)}]);`);
    else if (l.values) {
      if (l.values.every((x) => typeof x === 'number')) out.push(`const L_${l.name} = Float64Array.from(${JSON.stringify(l.values)});`);
      else out.push(`const L_${l.name} = ${JSON.stringify(l.values)};`);
    } else out.push(`const L_${l.name} = new Float64Array(${l.size});`);
  }
  for (const p of tgt.procs.values()) {
    scope = p;
    out.push(`function p_${p.name}(${p.params.map((x) => 'a_' + x).join(', ')}) {`);
    stmts(p.body, '  ');
    out.push(`}`);
  }
  const hatNames = [];
  tgt.hats.forEach((h, i) => {
    hatNames.push(`{ kind: ${jsStr(h.kind)}, arg: ${jsStr(h.arg)}, run: hat_${i} }`);
    out.push(`function hat_${i}() {`); stmts(h.body, '  '); out.push(`}`);
  });
  out.push(`return {`);
  out.push(`  vars: {`);
  for (const v of tgt.vars.values()) out.push(`    get ${v.name}() { return v_${v.name}; }, set ${v.name}(x) { v_${v.name} = x; },`);
  out.push(`  },`);
  out.push(`  lists: { ${[...tgt.lists.keys()].map((n) => `${n}: L_${n}`).join(', ')} },`);
  out.push(`  procs: { ${[...tgt.procs.keys()].map((n) => `${n}: p_${n}`).join(', ')} },`);
  out.push(`  hats: [${hatNames.join(', ')}],`);
  if (opts.countOps) out.push(`  ops: () => OPS, calls: () => CALLS, ns: () => NS, pcalls: () => PC,`);
  out.push(`};`, `})`);
  void scope; void isNumLit;
  return out.join('\n');
}

// compile + instantiate
function instantiate(program, host, data, opts = {}) {
  const src = genJS(program, opts);
  // eslint-disable-next-line no-new-func
  const factory = (0, eval)(src);
  return { inst: factory(host || {}, data || {}), src };
}

module.exports = { genJS, instantiate };
