/**
 * Tiny, dependency-free JSONPath evaluator that runs over the parser.js AST
 * (see parser.js for node shapes). For every match it returns the positional
 * "address" of the node — the chain of child indices from the root — so the
 * tree view can locate, expand and highlight it, plus the matched node itself
 * (used to copy the matched values).
 *
 * Supported syntax (a practical subset):
 *   $                      the root value
 *   .key   ['key']  ["k"]  child by name (the bracket form allows any chars)
 *   [0]   [-1]             array index (negative counts from the end)
 *   *   [*]                wildcard — every child
 *   ..                     recursive descent (e.g. $..id, $..*, $..[0])
 *   [0,2]   ['a','b']      union of indices or names
 *   [start:end:step]       array slice (any part optional, negatives allowed)
 *   [?(<expr>)]            filter — keep children where <expr> is true
 *
 * Filter expressions are hand-parsed and evaluated — never eval/new Function:
 *   @                      the current item   (@.a.b, @['a'], @[0] navigate it)
 *   == != < <= > >=        comparisons (numbers numerically, strings lexically)
 *   && || !                boolean logic, with ( ) grouping
 *   literals               123  -4.5  'text'  "text"  true  false  null
 *   bare @.key             true when that key/path exists
 *
 * Not supported: script expressions, function calls (e.g. length()), and
 * regular-expression matching. Anything unrecognised returns a friendly error.
 *
 * @param {object} ast    Root AST node from parseJSON().
 * @param {string} query  The JSONPath query.
 * @returns {{ ok: true, matches: {address:number[], node:object}[], truncated: boolean }
 *          | { ok: false, error: string }}
 */

const MAX_RESULTS = 5000; // stop after this many matches (keeps the UI responsive)
const MAX_VISITS = 250000; // guards recursive descent on huge documents

const UNDEF = Symbol('undefined'); // "no value at this path"
const CONTAINER = Symbol('container'); // an object/array where a scalar was expected

export function evaluateJSONPath(ast, query) {
  if (ast == null) return { ok: false, error: 'No JSON loaded' };

  let steps;
  try {
    steps = parsePath(String(query));
  } catch (e) {
    return { ok: false, error: e.message };
  }

  try {
    const ctx = { visits: 0, truncated: false };
    let current = [{ node: ast, address: [] }];

    for (const step of steps) {
      const next = [];
      const seen = new Set();
      for (const item of current) {
        const bases = step.recursive ? descendantsOrSelf(item, ctx) : [item];
        for (const base of bases) {
          applySelector(step.sel, base, next, seen, ctx);
          if (ctx.truncated) break;
        }
        if (ctx.truncated) break;
      }
      current = next;
      if (ctx.truncated) break;
    }

    // Final de-dup — recursive descent can reach the same node by two routes.
    const matches = [];
    const seenFinal = new Set();
    for (const item of current) {
      const key = item.address.join(',');
      if (seenFinal.has(key)) continue;
      seenFinal.add(key);
      matches.push({ address: item.address, node: item.node });
      if (matches.length >= MAX_RESULTS) { ctx.truncated = true; break; }
    }
    return { ok: true, matches, truncated: ctx.truncated };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// =====================================================================
// Evaluation
// =====================================================================

function pushMatch(out, seen, address, node, ctx) {
  const key = address.join(',');
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ address, node });
  if (out.length >= MAX_RESULTS) ctx.truncated = true;
}

function descendantsOrSelf(item, ctx) {
  const out = [];
  (function rec(it) {
    if (++ctx.visits > MAX_VISITS) throw new Error('Query is too expensive on a document this large');
    out.push(it);
    const n = it.node;
    if (n.t === 'object') n.entries.forEach((e, idx) => rec({ node: e.node, address: it.address.concat(idx) }));
    else if (n.t === 'array') n.items.forEach((c, idx) => rec({ node: c, address: it.address.concat(idx) }));
  })(item);
  return out;
}

function applySelector(sel, base, out, seen, ctx) {
  const node = base.node;
  switch (sel.type) {
    case 'child':
      if (node.t === 'object') {
        node.entries.forEach((e, idx) => {
          if (e.key === sel.name) pushMatch(out, seen, base.address.concat(idx), e.node, ctx);
        });
      }
      break;

    case 'index':
      if (node.t === 'array') {
        let idx = sel.index;
        if (idx < 0) idx += node.items.length;
        if (idx >= 0 && idx < node.items.length) {
          pushMatch(out, seen, base.address.concat(idx), node.items[idx], ctx);
        }
      }
      break;

    case 'wildcard':
      if (node.t === 'object') node.entries.forEach((e, idx) => pushMatch(out, seen, base.address.concat(idx), e.node, ctx));
      else if (node.t === 'array') node.items.forEach((c, idx) => pushMatch(out, seen, base.address.concat(idx), c, ctx));
      break;

    case 'union':
      for (const m of sel.members) {
        applySelector(m, base, out, seen, ctx);
        if (ctx.truncated) break;
      }
      break;

    case 'slice':
      if (node.t === 'array') applySlice(sel, node, base, out, seen, ctx);
      break;

    case 'filter':
      if (node.t === 'object') {
        node.entries.forEach((e, idx) => {
          if (evalExpr(sel.expr, e.node)) pushMatch(out, seen, base.address.concat(idx), e.node, ctx);
        });
      } else if (node.t === 'array') {
        node.items.forEach((c, idx) => {
          if (evalExpr(sel.expr, c)) pushMatch(out, seen, base.address.concat(idx), c, ctx);
        });
      }
      break;
  }
}

function applySlice(sel, node, base, out, seen, ctx) {
  const len = node.items.length;
  const step = sel.step == null ? 1 : sel.step;
  if (step === 0) return;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  if (step > 0) {
    let start = sel.start == null ? 0 : sel.start < 0 ? len + sel.start : sel.start;
    let end = sel.end == null ? len : sel.end < 0 ? len + sel.end : sel.end;
    start = clamp(start, 0, len);
    end = clamp(end, 0, len);
    for (let k = start; k < end; k += step) pushMatch(out, seen, base.address.concat(k), node.items[k], ctx);
  } else {
    let start = sel.start == null ? len - 1 : sel.start < 0 ? len + sel.start : sel.start;
    let end = sel.end == null ? -1 : sel.end < 0 ? len + sel.end : sel.end;
    start = clamp(start, -1, len - 1);
    end = clamp(end, -1, len - 1);
    for (let k = start; k > end; k += step) {
      if (k >= 0 && k < len) pushMatch(out, seen, base.address.concat(k), node.items[k], ctx);
    }
  }
}

// =====================================================================
// Filter expression evaluation
// =====================================================================

function evalExpr(e, node) {
  switch (e.k) {
    case 'or': return evalExpr(e.a, node) || evalExpr(e.b, node);
    case 'and': return evalExpr(e.a, node) && evalExpr(e.b, node);
    case 'not': return !evalExpr(e.a, node);
    case 'has': {
      const v = evalValue(e.a, node);
      if (e.a.k === 'cur') return v !== UNDEF; // existence test
      return Boolean(v !== UNDEF && v !== false && v !== null && v !== '');
    }
    case 'cmp': return compare(e.op, evalValue(e.a, node), evalValue(e.b, node));
  }
  return false;
}

function evalValue(v, node) {
  if (v.k === 'lit') return v.v;
  if (v.k === 'cur') return resolveCur(v.path, node);
  return UNDEF;
}

function resolveCur(path, node) {
  let cur = node;
  for (const acc of path) {
    if (acc.type === 'key') {
      if (!cur || cur.t !== 'object') return UNDEF;
      const e = cur.entries.find((en) => en.key === acc.name);
      if (!e) return UNDEF;
      cur = e.node;
    } else {
      if (!cur || cur.t !== 'array') return UNDEF;
      let idx = acc.index;
      if (idx < 0) idx += cur.items.length;
      if (idx < 0 || idx >= cur.items.length) return UNDEF;
      cur = cur.items[idx];
    }
  }
  return materialize(cur);
}

function materialize(node) {
  switch (node.t) {
    case 'string': return node.v;
    case 'number': return node.v;
    case 'bool': return node.v;
    case 'null': return null;
    default: return CONTAINER;
  }
}

function compare(op, a, b) {
  if (a === UNDEF || b === UNDEF) return false;
  if (a === CONTAINER || b === CONTAINER) {
    // Containers only support (in)equality and are never equal to a scalar.
    if (op === '==') return false;
    if (op === '!=') return true;
    return false;
  }
  switch (op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '<': return typeof a === typeof b && a < b;
    case '<=': return typeof a === typeof b && a <= b;
    case '>': return typeof a === typeof b && a > b;
    case '>=': return typeof a === typeof b && a >= b;
  }
  return false;
}

// =====================================================================
// Path parsing
// =====================================================================

const NAME_STOP = /[.[\]]/;

function parsePath(query) {
  const q = query.trim();
  if (q === '') throw new Error('Enter a path, e.g. $.items[*].name');

  let i = 0;
  if (q[i] === '$') i++;

  function readName() {
    const start = i;
    while (i < q.length && !NAME_STOP.test(q[i])) i++;
    if (i === start) throw new Error(`Expected a property name at position ${start + 1}`);
    return q.slice(start, i);
  }

  const steps = [];
  while (i < q.length) {
    const c = q[i];
    if (c === '.') {
      if (q[i + 1] === '.') {
        // recursive descent — the following selector matches at any depth
        i += 2;
        if (q[i] === '[') {
          const { sel, next } = parseBracket(q, i);
          steps.push({ recursive: true, sel });
          i = next;
        } else if (q[i] === '*') {
          steps.push({ recursive: true, sel: { type: 'wildcard' } });
          i++;
        } else {
          steps.push({ recursive: true, sel: { type: 'child', name: readName() } });
        }
      } else {
        i++;
        if (q[i] === '*') {
          steps.push({ recursive: false, sel: { type: 'wildcard' } });
          i++;
        } else {
          steps.push({ recursive: false, sel: { type: 'child', name: readName() } });
        }
      }
    } else if (c === '[') {
      const { sel, next } = parseBracket(q, i);
      steps.push({ recursive: false, sel });
      i = next;
    } else if (c === '*') {
      steps.push({ recursive: false, sel: { type: 'wildcard' } });
      i++;
    } else if (!NAME_STOP.test(c)) {
      // a bare leading key, e.g. "store.book"
      steps.push({ recursive: false, sel: { type: 'child', name: readName() } });
    } else {
      throw new Error(`Unexpected character '${c}' at position ${i + 1}`);
    }
  }
  return steps;
}

function parseBracket(q, start) {
  // q[start] === '['. Walk to the matching ']' while respecting quotes and
  // nested brackets (filters may contain @[0] and strings with ']').
  let i = start + 1;
  let depth = 1;
  let quote = null;
  let content = '';
  while (i < q.length) {
    const c = q[i];
    if (quote) {
      content += c;
      if (c === '\\' && i + 1 < q.length) { content += q[i + 1]; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; content += c; i++; continue; }
    if (c === '[') { depth++; content += c; i++; continue; }
    if (c === ']') { depth--; if (depth === 0) { i++; break; } content += c; i++; continue; }
    content += c;
    i++;
  }
  if (depth !== 0) throw new Error("Unbalanced '[' in path");
  return { sel: parseBracketContent(content.trim()), next: i };
}

function parseBracketContent(s) {
  if (s === '') throw new Error('Empty [ ] selector');
  if (s === '*') return { type: 'wildcard' };

  if (s[0] === '?') {
    const m = /^\?\s*\(([\s\S]*)\)\s*$/.exec(s);
    if (!m) throw new Error('Malformed filter — expected [?(expression)]');
    return { type: 'filter', expr: parseFilter(m[1]) };
  }

  // A top-level ':' (outside quotes) means an array slice.
  if (splitTopLevel(s, ':').length > 1) return parseSlice(s);

  const members = splitTopLevel(s, ',').map(parseUnionMember);
  return members.length === 1 ? members[0] : { type: 'union', members };
}

function parseUnionMember(raw) {
  const p = raw.trim();
  if (p === '') throw new Error('Empty selector inside [ ]');
  if ((p[0] === "'" && p[p.length - 1] === "'") || (p[0] === '"' && p[p.length - 1] === '"')) {
    return { type: 'child', name: unquote(p) };
  }
  if (/^-?\d+$/.test(p)) return { type: 'index', index: parseInt(p, 10) };
  throw new Error(`Invalid selector '${p}' inside [ ] — use a number, 'name', or *`);
}

function parseSlice(s) {
  const parts = splitTopLevel(s, ':');
  const toNum = (x) => {
    const t = (x || '').trim();
    if (t === '') return null;
    if (!/^-?\d+$/.test(t)) throw new Error(`Invalid slice bound '${t}'`);
    return parseInt(t, 10);
  };
  return {
    type: 'slice',
    start: toNum(parts[0]),
    end: toNum(parts[1]),
    step: parts.length > 2 ? toNum(parts[2]) : null,
  };
}

function unquote(p) {
  const inner = p.slice(1, -1);
  return inner.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c));
}

// Split on a delimiter that appears at the top level (not inside quotes,
// parentheses or brackets).
function splitTopLevel(s, delim) {
  const parts = [];
  let cur = '';
  let quote = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\' && i + 1 < s.length) { cur += s[i + 1]; i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === '(' || c === '[') { depth++; cur += c; continue; }
    if (c === ')' || c === ']') { depth--; cur += c; continue; }
    if (c === delim && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

// =====================================================================
// Filter expression parsing  (recursive descent, no eval)
// =====================================================================

function parseFilter(src) {
  const toks = tokenizeFilter(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t) => {
    const tk = toks[p];
    if (!tk || tk.t !== t) throw new Error(`Expected '${t}' in filter`);
    return toks[p++];
  };

  function parseExpr() { return parseOr(); }
  function parseOr() {
    let a = parseAnd();
    while (peek() && peek().t === '||') { next(); a = { k: 'or', a, b: parseAnd() }; }
    return a;
  }
  function parseAnd() {
    let a = parseNot();
    while (peek() && peek().t === '&&') { next(); a = { k: 'and', a, b: parseNot() }; }
    return a;
  }
  function parseNot() {
    if (peek() && peek().t === '!') { next(); return { k: 'not', a: parseNot() }; }
    return parseAtom();
  }
  function parseAtom() {
    if (peek() && peek().t === '(') { next(); const e = parseExpr(); expect(')'); return e; }
    return parseComparison();
  }
  function parseComparison() {
    const a = parseOperand();
    if (peek() && peek().t === 'op') { const op = next().v; return { k: 'cmp', op, a, b: parseOperand() }; }
    return { k: 'has', a };
  }
  function parseOperand() {
    const tk = peek();
    if (!tk) throw new Error('Unexpected end of filter');
    if (tk.t === '@') { next(); return { k: 'cur', path: parseAccessors() }; }
    if (tk.t === 'num' || tk.t === 'str') { next(); return { k: 'lit', v: tk.v }; }
    if (tk.t === 'name') {
      next();
      if (tk.v === 'true') return { k: 'lit', v: true };
      if (tk.v === 'false') return { k: 'lit', v: false };
      if (tk.v === 'null') return { k: 'lit', v: null };
      throw new Error(`Unexpected '${tk.v}' in filter`);
    }
    throw new Error('Unexpected token in filter');
  }
  function parseAccessors() {
    const path = [];
    for (;;) {
      const tk = peek();
      if (tk && tk.t === '.') {
        next();
        const nm = peek();
        if (!nm || nm.t !== 'name') throw new Error("Expected a name after '.' in filter");
        next();
        path.push({ type: 'key', name: nm.v });
      } else if (tk && tk.t === '[') {
        next();
        const inner = peek();
        if (inner && inner.t === 'str') { next(); expect(']'); path.push({ type: 'key', name: inner.v }); }
        else if (inner && inner.t === 'num') { next(); expect(']'); path.push({ type: 'idx', index: inner.v }); }
        else throw new Error("Expected a name or index inside [ ] in filter");
      } else {
        break;
      }
    }
    return path;
  }

  const expr = parseExpr();
  if (p < toks.length) throw new Error('Unexpected trailing characters in filter');
  return expr;
}

function tokenizeFilter(s) {
  const toks = [];
  let i = 0;
  const isDigit = (c) => c >= '0' && c <= '9';
  const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdent = (c) => /[A-Za-z0-9_$]/.test(c);

  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '@') { toks.push({ t: '@' }); i++; continue; }
    if (c === '.') { toks.push({ t: '.' }); i++; continue; }
    if (c === '(') { toks.push({ t: '(' }); i++; continue; }
    if (c === ')') { toks.push({ t: ')' }); i++; continue; }
    if (c === '[') { toks.push({ t: '[' }); i++; continue; }
    if (c === ']') { toks.push({ t: ']' }); i++; continue; }

    if (c === '!') {
      if (s[i + 1] === '=') { toks.push({ t: 'op', v: '!=' }); i += 2; } else { toks.push({ t: '!' }); i++; }
      continue;
    }
    if (c === '=') {
      if (s[i + 1] === '=') { toks.push({ t: 'op', v: '==' }); i += 2; continue; }
      throw new Error("Use '==' for equality in filters");
    }
    if (c === '<') {
      if (s[i + 1] === '=') { toks.push({ t: 'op', v: '<=' }); i += 2; } else { toks.push({ t: 'op', v: '<' }); i++; }
      continue;
    }
    if (c === '>') {
      if (s[i + 1] === '=') { toks.push({ t: 'op', v: '>=' }); i += 2; } else { toks.push({ t: 'op', v: '>' }); i++; }
      continue;
    }
    if (c === '&') {
      if (s[i + 1] === '&') { toks.push({ t: '&&' }); i += 2; continue; }
      throw new Error("Use '&&' for AND in filters");
    }
    if (c === '|') {
      if (s[i + 1] === '|') { toks.push({ t: '||' }); i += 2; continue; }
      throw new Error("Use '||' for OR in filters");
    }

    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      let str = '';
      while (i < s.length && s[i] !== quote) {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[i + 1];
          str += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
          i += 2;
          continue;
        }
        str += s[i];
        i++;
      }
      if (i >= s.length) throw new Error('Unterminated string in filter');
      i++; // closing quote
      toks.push({ t: 'str', v: str });
      continue;
    }

    if (isDigit(c) || (c === '-' && isDigit(s[i + 1]))) {
      let j = i;
      if (s[j] === '-') j++;
      while (isDigit(s[j])) j++;
      if (s[j] === '.') { j++; while (isDigit(s[j])) j++; }
      if (s[j] === 'e' || s[j] === 'E') { j++; if (s[j] === '+' || s[j] === '-') j++; while (isDigit(s[j])) j++; }
      const v = Number(s.slice(i, j));
      if (!Number.isFinite(v)) throw new Error('Invalid number in filter');
      toks.push({ t: 'num', v });
      i = j;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < s.length && isIdent(s[j])) j++;
      toks.push({ t: 'name', v: s.slice(i, j) });
      i = j;
      continue;
    }

    throw new Error(`Unexpected '${c}' in filter`);
  }
  return toks;
}
