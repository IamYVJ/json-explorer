/**
 * Serialize an AST (see parser.js) back to JSON text.
 *
 * Works directly on the AST rather than a native value so that raw number
 * literals are preserved exactly — no precision loss on large integers.
 */

const ESCAPE_MAP = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

// Escape double-quote, backslash, named control chars, and any remaining
// control character (code point < 0x20) as a \uXXXX sequence.
export function escapeString(str) {
  let out = '';
  for (let k = 0; k < str.length; k++) {
    const ch = str[k];
    const mapped = ESCAPE_MAP[ch];
    if (mapped) {
      out += mapped;
    } else if (str.charCodeAt(k) < 0x20) {
      out += '\\u' + str.charCodeAt(k).toString(16).padStart(4, '0');
    } else {
      out += ch;
    }
  }
  return out;
}

export function quote(str) {
  return '"' + escapeString(str) + '"';
}

function entriesFor(node, sortKeys) {
  if (!sortKeys) return node.entries;
  return node.entries
    .slice()
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Pretty-print an AST.
 * @param {object} ast
 * @param {{ indent?: string, sortKeys?: boolean }} [opts]
 */
export function format(ast, opts = {}) {
  const indent = opts.indent != null ? opts.indent : '  ';
  const sortKeys = !!opts.sortKeys;

  function walk(node, depth) {
    switch (node.t) {
      case 'object': {
        const entries = entriesFor(node, sortKeys);
        if (entries.length === 0) return '{}';
        const pad = indent.repeat(depth + 1);
        const closePad = indent.repeat(depth);
        const body = entries
          .map((e) => `${pad}${quote(e.key)}: ${walk(e.node, depth + 1)}`)
          .join(',\n');
        return `{\n${body}\n${closePad}}`;
      }
      case 'array': {
        if (node.items.length === 0) return '[]';
        const pad = indent.repeat(depth + 1);
        const closePad = indent.repeat(depth);
        const body = node.items
          .map((item) => `${pad}${walk(item, depth + 1)}`)
          .join(',\n');
        return `[\n${body}\n${closePad}]`;
      }
      case 'string':
        return quote(node.v);
      case 'number':
        return node.raw;
      case 'bool':
        return node.v ? 'true' : 'false';
      case 'null':
        return 'null';
      default:
        return 'null';
    }
  }

  return walk(ast, 0);
}

/**
 * Compact single-line JSON.
 * @param {object} ast
 * @param {{ sortKeys?: boolean }} [opts]
 */
export function minify(ast, opts = {}) {
  const sortKeys = !!opts.sortKeys;

  function walk(node) {
    switch (node.t) {
      case 'object': {
        const entries = entriesFor(node, sortKeys);
        return '{' + entries.map((e) => `${quote(e.key)}:${walk(e.node)}`).join(',') + '}';
      }
      case 'array':
        return '[' + node.items.map(walk).join(',') + ']';
      case 'string':
        return quote(node.v);
      case 'number':
        return node.raw;
      case 'bool':
        return node.v ? 'true' : 'false';
      case 'null':
        return 'null';
      default:
        return 'null';
    }
  }

  return walk(ast);
}

/**
 * Serialize a single node (used when copying a subtree's value).
 */
export function nodeToJSON(node, indent = '  ') {
  return format(node, { indent });
}

/**
 * Convert a scalar node to a plain, copy-friendly string.
 * Strings are returned unquoted (the decoded value).
 */
export function scalarToText(node) {
  switch (node.t) {
    case 'string':
      return node.v;
    case 'number':
      return node.raw;
    case 'bool':
      return node.v ? 'true' : 'false';
    case 'null':
      return 'null';
    default:
      return '';
  }
}
