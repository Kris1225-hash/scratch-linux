'use strict';
// SBL -> Scratch 3 project (.sb3).
//
//   const proj = new Project();
//   proj.stage.costumes.push(svgCostume('bg', '<svg .../>'));
//   proj.addSprite('term', { costumes: [...] });
//   genSb3(program, proj, { data });
//   const buf = await proj.toSb3();
//
// Block-shape rules that matter for speed in the stock interpreter:
//  - number literals are emitted as JSON numbers (the VM then skips a string->number parse per use)
//  - `a != b`, `<=`, `>=`, `!c` in an if are compiled by swapping the branches instead of adding a `not`
//  - `x += e` becomes "change x by", `x -= c` "change x by -c"

const crypto = require('crypto');
const { SblError, STMT_BUILTINS, neg, listInit } = require('./sbl');

const T_NUM = 4, T_POS = 5, T_WHOLE = 6, T_INT = 7, T_TEXT = 10;

class Target {
  constructor(name, isStage, opts = {}) {
    this.name = name; this.isStage = isStage;
    this.variables = {}; this.lists = {}; this.broadcasts = {}; this.blocks = {};
    this.costumes = opts.costumes || [];
    this.currentCostume = opts.currentCostume || 0;
    this.props = isStage
      ? { tempo: 60, videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null }
      : { visible: opts.visible !== false, x: opts.x || 0, y: opts.y || 0, size: opts.size || 100, direction: 90,
          draggable: false, rotationStyle: opts.rotationStyle || "don't rotate" };
  }
}

function svgCostume(name, svg, cx = 0, cy = 0) {
  const md5 = crypto.createHash('md5').update(svg).digest('hex');
  return { name, dataFormat: 'svg', assetId: md5, md5ext: md5 + '.svg', rotationCenterX: cx, rotationCenterY: cy, data: svg };
}
function pngCostume(name, buf, cx = 0, cy = 0, res = 1) {
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  return { name, dataFormat: 'png', assetId: md5, md5ext: md5 + '.png', bitmapResolution: res, rotationCenterX: cx, rotationCenterY: cy, data: buf };
}

class Project {
  constructor() {
    this.stage = new Target('Stage', true);
    this.sprites = [];
    this.extensions = new Set();
    this.nextId = 0;
    this.meta = { semver: '3.0.0', vm: '0.2.0', agent: 'sbl' };
  }
  addSprite(name, opts) { const t = new Target(name, false, opts); this.sprites.push(t); return t; }
  target(name) { return name === 'Stage' ? this.stage : this.sprites.find((s) => s.name === name); }
  uid(prefix = '') { return prefix + (this.nextId++).toString(36); }

  toJSON() {
    const tj = (t, i) => {
      if (!t.costumes.length) throw new SblError(`target ${t.name} has no costumes`);
      return Object.assign({
        isStage: t.isStage, name: t.name, variables: t.variables, lists: Object.assign({}, t.lists), broadcasts: t.broadcasts,
        blocks: t.blocks, comments: {}, currentCostume: t.currentCostume,
        costumes: t.costumes.map(({ data, ...c }) => c), sounds: [], volume: 100, layerOrder: i,
      }, t.props);
    };
    return { targets: [this.stage, ...this.sprites].map(tj), monitors: [], extensions: [...this.extensions], meta: this.meta };
  }
  // serialise by hand so multi-million-entry lists don't go through one giant JSON.stringify string
  projectJsonChunks() {
    const j = this.toJSON();
    const chunks = [];
    const big = [];
    for (const t of j.targets) {
      for (const id of Object.keys(t.lists)) {
        const arr = t.lists[id][1];
        if (arr.length > 4096) { big.push(arr); t.lists[id] = [t.lists[id][0], `@@BIG${big.length - 1}@@`]; }
        else if (ArrayBuffer.isView(arr)) t.lists[id] = [t.lists[id][0], Array.from(arr)];
      }
    }
    const s = JSON.stringify(j);
    let pos = 0;
    const re = /"@@BIG(\d+)@@"/g; let m;
    while ((m = re.exec(s))) {
      chunks.push(s.slice(pos, m.index)); pos = m.index + m[0].length;
      const arr = big[+m[1]];
      chunks.push('[');
      const STEP = 65536;
      for (let i = 0; i < arr.length; i += STEP) {
        const part = Array.prototype.slice.call(arr, i, Math.min(arr.length, i + STEP));
        chunks.push((i ? ',' : '') + part.join(','));
      }
      chunks.push(']');
    }
    chunks.push(s.slice(pos));
    return chunks;
  }
  async toSb3() {
    const JSZip = require('jszip');
    const zip = new JSZip();
    zip.file('project.json', Buffer.concat(this.projectJsonChunks().map((c) => Buffer.from(c, 'utf8'))));
    const seen = new Set();
    for (const t of [this.stage, ...this.sprites]) for (const c of t.costumes) {
      if (seen.has(c.md5ext)) continue; seen.add(c.md5ext);
      zip.file(c.md5ext, c.data);
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  }
}

// ---------------------------------------------------------------- code generation

function genSb3(program, project, opts = {}) {
  const data = opts.data || {};
  const stats = { blocks: 0 };
  const stageP = program.targets.get('Stage');

  // declare variables / lists on every target first so sprites can see stage globals
  const sym = new Map();     // target name -> { vars: Map name->id, lists: Map name->id, procs: Map name->{argIds, proccode, warp} }
  for (const [name, pt] of program.targets) {
    const tgt = project.target(name);
    if (!tgt) throw new SblError(`program uses target ${name} but the project has no such sprite`);
    const s = { vars: new Map(), lists: new Map(), procs: new Map() };
    sym.set(name, s);
    for (const v of pt.vars.values()) { const id = project.uid('v'); s.vars.set(v.name, id); tgt.variables[id] = [v.name, v.init]; }
    for (const l of pt.lists.values()) {
      const id = project.uid('l'); s.lists.set(l.name, id);
      let init = listInit(l, data);
      if (init === null) init = new Uint8Array(l.size);          // zeros; serialised as 0,0,0,...
      tgt.lists[id] = [l.name, init];
    }
    for (const p of pt.procs.values()) {
      s.procs.set(p.name, { argIds: p.params.map(() => project.uid('p')), proccode: [p.name, ...p.params.map(() => '%s')].join(' '), warp: p.warp, params: p.params });
    }
  }

  for (const [name, pt] of program.targets) {
    const tgt = project.target(name);
    const my = sym.get(name), glob = sym.get('Stage');
    const B = tgt.blocks;
    let params = null;
    let topY = 0;
    const fail = (tok, m) => { throw new SblError(`${tok ? tok.file + ':' + tok.line : '?'}: ${m}`); };

    const blk = (opcode, parent, inputs, fields, extra) => {
      const id = project.uid();
      B[id] = Object.assign({ opcode, next: null, parent: parent || null, inputs: inputs || {}, fields: fields || {}, shadow: false, topLevel: false }, extra);
      stats.blocks++;
      return id;
    };
    const top = (id) => { B[id].topLevel = true; B[id].x = 0; B[id].y = topY; topY += 400; };
    const varField = (n, tok) => {
      if (my.vars.has(n)) return [n, my.vars.get(n)];
      if (glob.vars.has(n)) return [n, glob.vars.get(n)];
      fail(tok, (my.lists.has(n) || glob.lists.has(n)) ? `${n} is a list` : `unknown variable ${n}`);
    };
    const listField = (e, tok) => {
      const n = typeof e === 'string' ? e : e.name;
      if (my.lists.has(n)) return [n, my.lists.get(n)];
      if (glob.lists.has(n)) return [n, glob.lists.get(n)];
      fail(tok || e.tok, `unknown list ${n}`);
    };
    const bcast = (name) => {
      const st = project.stage;
      for (const [id, n] of Object.entries(st.broadcasts)) if (n === name) return id;
      const id = project.uid('m'); st.broadcasts[id] = name; return id;
    };

    // an expression block; returns block id. `parent` is patched by the caller via setParent
    function exprBlock(e, parent) {
      switch (e.t) {
        case 'arg': return blk('argument_reporter_string_number', parent, {}, { VALUE: [e.name, null] });
        case 'item': {
          const id = blk('data_itemoflist', parent, {}, { LIST: listField(e.list, e.tok) });
          B[id].inputs.INDEX = numIn(e.idx, id, T_INT);
          return id;
        }
        case 'un': {
          const id = blk('operator_not', parent);
          B[id].inputs.OPERAND = boolIn(e.a, id);
          return id;
        }
        case 'bin': {
          const { op, a, b } = e;
          const arith = { '+': 'operator_add', '-': 'operator_subtract', '*': 'operator_multiply', '/': 'operator_divide', '%': 'operator_mod' }[op];
          if (arith) {
            const id = blk(arith, parent);
            B[id].inputs.NUM1 = numIn(a, id, T_NUM); B[id].inputs.NUM2 = numIn(b, id, T_NUM);
            return id;
          }
          const cmp = { '<': 'operator_lt', '>': 'operator_gt', '==': 'operator_equals' }[op];
          if (cmp) {
            const id = blk(cmp, parent);
            B[id].inputs.OPERAND1 = numIn(a, id, T_TEXT); B[id].inputs.OPERAND2 = numIn(b, id, T_TEXT);
            return id;
          }
          if (op === '!=' || op === '<=' || op === '>=') {
            const id = blk('operator_not', parent);
            B[id].inputs.OPERAND = [2, exprBlock(neg(e), id)];
            return id;
          }
          if (op === '&&' || op === '||') {
            const id = blk(op === '&&' ? 'operator_and' : 'operator_or', parent);
            B[id].inputs.OPERAND1 = boolIn(a, id); B[id].inputs.OPERAND2 = boolIn(b, id);
            return id;
          }
          fail(e.tok, `bad operator ${op}`); break;
        }
        case 'fn': {
          const a = e.args;
          const one = (opcode, inName, ty, fields) => { const id = blk(opcode, parent, {}, fields); B[id].inputs[inName] = numIn(a[0], id, ty); return id; };
          switch (e.name) {
            case 'floor': return one('operator_mathop', 'NUM', T_NUM, { OPERATOR: ['floor', null] });
            case 'ceil': return one('operator_mathop', 'NUM', T_NUM, { OPERATOR: ['ceiling', null] });
            case 'abs': return one('operator_mathop', 'NUM', T_NUM, { OPERATOR: ['abs', null] });
            case 'sqrt': return one('operator_mathop', 'NUM', T_NUM, { OPERATOR: ['sqrt', null] });
            case 'round': return one('operator_round', 'NUM', T_NUM);
            case 'strlen': return one('operator_length', 'STRING', T_TEXT);
            case 'len': return blk('data_lengthoflist', parent, {}, { LIST: listField(a[0]) });
            case 'itemf': { const id = blk('data_itemoflist', parent, {}, { LIST: listField(a[0]) }); B[id].inputs.INDEX = numIn(a[1], id, T_INT); return id; }
            case 'indexof': { const id = blk('data_itemnumoflist', parent, {}, { LIST: listField(a[0]) }); B[id].inputs.ITEM = numIn(a[1], id, T_TEXT); return id; }
            case 'contains': { const id = blk('data_listcontainsitem', parent, {}, { LIST: listField(a[0]) }); B[id].inputs.ITEM = numIn(a[1], id, T_TEXT); return id; }
            case 'strcontains': { const id = blk('operator_contains', parent); B[id].inputs.STRING1 = numIn(a[0], id, T_TEXT); B[id].inputs.STRING2 = numIn(a[1], id, T_TEXT); return id; }
            case 'letter': { const id = blk('operator_letter_of', parent); B[id].inputs.STRING = numIn(a[0], id, T_TEXT); B[id].inputs.LETTER = numIn(a[1], id, T_WHOLE); return id; }
            case 'join': { const id = blk('operator_join', parent); B[id].inputs.STRING1 = numIn(a[0], id, T_TEXT); B[id].inputs.STRING2 = numIn(a[1], id, T_TEXT); return id; }
            case 'timer': return blk('sensing_timer', parent);
            case 'days2000': return blk('sensing_dayssince2000', parent);
            case 'answer': return blk('sensing_answer', parent);
            case 'mousedown': return blk('sensing_mousedown', parent);
            case 'mousex': return blk('sensing_mousex', parent);
            case 'mousey': return blk('sensing_mousey', parent);
            case 'username': return blk('sensing_username', parent);
            case 'costume_num': return blk('looks_costumenumbername', parent, {}, { NUMBER_NAME: ['number', null] });
            case 'current':
              if (a[0].t !== 'str') fail(e.tok, 'current() needs a literal like "year"');
              return blk('sensing_current', parent, {}, { CURRENTMENU: [a[0].v.toUpperCase(), null] });
            case 'keydown': {
              const id = blk('sensing_keypressed', parent);
              const sh = blk('sensing_keyoptions', id, {}, { KEY_OPTION: [a[0].t === 'str' ? a[0].v : 'space', null] }, { shadow: true });
              B[id].inputs.KEY_OPTION = a[0].t === 'str' ? [1, sh] : [3, exprBlock(a[0], id), sh];
              return id;
            }
            case 'hostf': fail(e.tok, 'hostf() only exists in the js build');
          }
          fail(e.tok, `no scratch block for ${e.name}()`); break;
        }
      }
      fail(e.tok, `cannot compile expression node ${e.t}`);
    }
    // input descriptor for a value slot
    function numIn(e, parent, ty) {
      if (e.t === 'num') return [1, [ty, e.v]];
      if (e.t === 'str') return [1, [T_TEXT, e.v]];
      if (e.t === 'var') { const f = varField(e.name, e.tok); return [3, [12, f[0], f[1]], [ty, '']]; }
      if (e.t === 'listref') fail(e.tok, 'a list cannot be used as a value');
      return [3, exprBlock(e, parent), [ty, '']];
    }
    function boolIn(e, parent) {
      if (e.ty !== 'bool') fail(e.tok, 'condition must be a comparison (scratch needs a boolean block here)');
      return [2, exprBlock(e, parent)];
    }

    // statements: each returns { first, last } block ids or null when it compiles to nothing
    function seq(list, parent) {
      let first = null, last = null;
      for (const s of list) {
        const r = stmt(s, last || parent);
        if (!r) continue;
        if (last) { B[last].next = r.first; B[r.first].parent = last; } else first = r.first;
        last = r.last;
      }
      return first ? { first, last } : null;
    }
    const single = (id) => ({ first: id, last: id });
    function sub(id, name, list) { const r = seq(list, id); if (r) { B[id].inputs[name] = [2, r.first]; B[r.first].parent = id; } }

    function stmt(s, parent) {
      switch (s.t) {
        case 'set': { const id = blk('data_setvariableto', parent, {}, { VARIABLE: varField(s.name, s.tok) }); B[id].inputs.VALUE = numIn(s.e, id, T_TEXT); return single(id); }
        case 'chg': { const id = blk('data_changevariableby', parent, {}, { VARIABLE: varField(s.name, s.tok) }); B[id].inputs.VALUE = numIn(s.e, id, T_NUM); return single(id); }
        case 'lset': {
          const id = blk('data_replaceitemoflist', parent, {}, { LIST: listField(s.list, s.tok) });
          B[id].inputs.INDEX = numIn(s.idx, id, T_INT); B[id].inputs.ITEM = numIn(s.e, id, T_TEXT);
          return single(id);
        }
        case 'if': {
          let { c, a, b } = s;
          if (c.t === 'num') return seq(c.v ? a : (b || []), parent);
          b = b || [];
          const negated = (c.t === 'un' && c.op === '!') || (c.t === 'bin' && (c.op === '!=' || c.op === '<=' || c.op === '>='));
          if (negated) { c = neg(c); const t = a; a = b; b = t; }
          const id = blk(b.length ? 'control_if_else' : 'control_if', parent);
          B[id].inputs.CONDITION = boolIn(c, id);
          sub(id, 'SUBSTACK', a);
          if (b.length) sub(id, 'SUBSTACK2', b);
          return single(id);
        }
        case 'until': { const id = blk('control_repeat_until', parent); B[id].inputs.CONDITION = boolIn(s.c, id); sub(id, 'SUBSTACK', s.body); return single(id); }
        case 'repeat': { const id = blk('control_repeat', parent); B[id].inputs.TIMES = numIn(s.n, id, T_WHOLE); sub(id, 'SUBSTACK', s.body); return single(id); }
        case 'forever': { const id = blk('control_forever', parent); sub(id, 'SUBSTACK', s.body); return single(id); }
        case 'return': return single(blk('control_stop', parent, {}, { STOP_OPTION: ['this script', null] }, { mutation: { tagName: 'mutation', children: [], hasnext: 'false' } }));
        case 'stopall': return single(blk('control_stop', parent, {}, { STOP_OPTION: ['all', null] }, { mutation: { tagName: 'mutation', children: [], hasnext: 'false' } }));
        case 'call': return call(s, parent);
      }
      fail(s.tok, `cannot compile statement node ${s.t}`);
    }

    function call(s, parent) {
      const a = s.args;
      const proc = my.procs.get(s.name);
      if (proc) {
        if (proc.params.length !== a.length) fail(s.tok, `${s.name}() takes ${proc.params.length} argument(s)`);
        const id = blk('procedures_call', parent, {}, {}, { mutation: { tagName: 'mutation', children: [], proccode: proc.proccode, argumentids: JSON.stringify(proc.argIds), warp: String(proc.warp) } });
        a.forEach((x, i) => { B[id].inputs[proc.argIds[i]] = numIn(x, id, T_TEXT); });
        return single(id);
      }
      if (!(s.name in STMT_BUILTINS)) fail(s.tok, `unknown proc ${s.name}`);
      if (STMT_BUILTINS[s.name] >= 0 && STMT_BUILTINS[s.name] !== a.length) fail(s.tok, `${s.name}() takes ${STMT_BUILTINS[s.name]} argument(s)`);
      const simple = (opcode, spec, fields) => {
        const id = blk(opcode, parent, {}, fields);
        (spec || []).forEach(([inName, ty], i) => { B[id].inputs[inName] = numIn(a[i + (fields && fields.LIST ? 1 : 0)], id, ty); });
        return single(id);
      };
      switch (s.name) {
        case 'push': return simple('data_addtolist', [['ITEM', T_TEXT]], { LIST: listField(a[0]) });
        case 'clear': return simple('data_deletealloflist', [], { LIST: listField(a[0]) });
        case 'del': return simple('data_deleteoflist', [['INDEX', T_INT]], { LIST: listField(a[0]) });
        case 'insert': {
          const id = blk('data_insertatlist', parent, {}, { LIST: listField(a[0]) });
          B[id].inputs.INDEX = numIn(a[1], id, T_INT); B[id].inputs.ITEM = numIn(a[2], id, T_TEXT);
          return single(id);
        }
        case 'show_list': return simple('data_showlist', [], { LIST: listField(a[0]) });
        case 'hide_list': return simple('data_hidelist', [], { LIST: listField(a[0]) });
        case 'show_var': return single(blk('data_showvariable', parent, {}, { VARIABLE: varField(a[0].name, s.tok) }));
        case 'hide_var': return single(blk('data_hidevariable', parent, {}, { VARIABLE: varField(a[0].name, s.tok) }));
        case 'wait': return simple('control_wait', [['DURATION', T_POS]]);
        case 'ask': return simple('sensing_askandwait', [['QUESTION', T_TEXT]]);
        case 'say': return simple('looks_say', [['MESSAGE', T_TEXT]]);
        case 'think': return simple('looks_think', [['MESSAGE', T_TEXT]]);
        case 'reset_timer': return simple('sensing_resettimer');
        case 'show': return simple('looks_show');
        case 'hide': return simple('looks_hide');
        case 'size': return simple('looks_setsizeto', [['SIZE', T_NUM]]);
        case 'front': return single(blk('looks_gotofrontback', parent, {}, { FRONT_BACK: ['front', null] }));
        case 'clear_effects': return simple('looks_cleargraphiceffects');
        case 'set_effect': {
          if (a[0].t !== 'str') fail(s.tok, 'set_effect needs a literal effect name');
          const id = blk('looks_seteffectto', parent, {}, { EFFECT: [a[0].v.toUpperCase(), null] });
          B[id].inputs.VALUE = numIn(a[1], id, T_NUM);
          return single(id);
        }
        case 'goto': return simple('motion_gotoxy', [['X', T_NUM], ['Y', T_NUM]]);
        case 'setx': return simple('motion_setx', [['X', T_NUM]]);
        case 'sety': return simple('motion_sety', [['Y', T_NUM]]);
        case 'stop_other': return single(blk('control_stop', parent, {}, { STOP_OPTION: ['other scripts in sprite', null] }, { mutation: { tagName: 'mutation', children: [], hasnext: 'true' } }));
        case 'stamp': project.extensions.add('pen'); return simple('pen_stamp');
        case 'pen_clear': project.extensions.add('pen'); return simple('pen_clear');
        case 'pen_down': project.extensions.add('pen'); return simple('pen_penDown');
        case 'pen_up': project.extensions.add('pen'); return simple('pen_penUp');
        case 'pen_size': project.extensions.add('pen'); return simple('pen_setPenSizeTo', [['SIZE', T_NUM]]);
        case 'pen_color': {
          project.extensions.add('pen');
          const id = blk('pen_setPenColorToColor', parent);
          B[id].inputs.COLOR = a[0].t === 'str' ? [1, [9, a[0].v]] : [3, exprBlock(a[0], id), [9, '#000000']];
          return single(id);
        }
        case 'costume': case 'backdrop': {
          const isBd = s.name === 'backdrop';
          const id = blk(isBd ? 'looks_switchbackdropto' : 'looks_switchcostumeto', parent);
          const names = (isBd ? project.stage : tgt).costumes.map((c) => c.name);
          const lit = a[0].t === 'str' ? a[0].v : names[0];
          const sh = blk(isBd ? 'looks_backdrops' : 'looks_costume', id, {}, { [isBd ? 'BACKDROP' : 'COSTUME']: [lit, null] }, { shadow: true });
          B[id].inputs[isBd ? 'BACKDROP' : 'COSTUME'] = a[0].t === 'str' ? [1, sh] : [3, exprBlock(a[0], id), sh];
          return single(id);
        }
        case 'broadcast': case 'broadcast_wait': {
          if (a[0].t !== 'str') fail(s.tok, 'broadcast needs a literal message name');
          const id = blk(s.name === 'broadcast' ? 'event_broadcast' : 'event_broadcastandwait', parent);
          B[id].inputs.BROADCAST_INPUT = [1, [11, a[0].v, bcast(a[0].v)]];
          return single(id);
        }
        case 'host': fail(s.tok, 'host() only exists in the js build');
      }
      fail(s.tok, `no scratch block for ${s.name}()`);
    }

    for (const p of pt.procs.values()) {
      const info = my.procs.get(p.name);
      params = new Set(p.params);
      const def = blk('procedures_definition', null); top(def);
      const proto = blk('procedures_prototype', def, {}, {}, { shadow: true, mutation: {
        tagName: 'mutation', children: [], proccode: info.proccode, argumentids: JSON.stringify(info.argIds),
        argumentnames: JSON.stringify(p.params), argumentdefaults: JSON.stringify(p.params.map(() => '')), warp: String(p.warp) } });
      p.params.forEach((n, i) => { B[proto].inputs[info.argIds[i]] = [1, blk('argument_reporter_string_number', proto, {}, { VALUE: [n, null] }, { shadow: true })]; });
      B[def].inputs.custom_block = [1, proto];
      const r = seq(p.body, def);
      if (r) { B[def].next = r.first; B[r.first].parent = def; }
    }
    params = null;
    for (const h of pt.hats) {
      let id;
      if (h.kind === 'flag') id = blk('event_whenflagclicked', null);
      else if (h.kind === 'key') id = blk('event_whenkeypressed', null, {}, { KEY_OPTION: [h.arg, null] });
      else if (h.kind === 'stageclick') id = blk('event_whenstageclicked', null);
      else if (h.kind === 'spriteclick') id = blk('event_whenthisspriteclicked', null);
      else id = blk('event_whenbroadcastreceived', null, {}, { BROADCAST_OPTION: [h.arg, bcast(h.arg)] });
      top(id);
      const r = seq(h.body, id);
      if (r) { B[id].next = r.first; B[r.first].parent = id; }
    }
    void params;
  }
  void stageP;
  return stats;
}

module.exports = { Project, Target, svgCostume, pngCostume, genSb3 };
