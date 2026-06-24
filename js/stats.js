/**
 * Compute structural statistics from an AST.
 */

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

export function byteLength(text) {
  if (encoder) return encoder.encode(text).length;
  // Fallback UTF-8 byte count.
  return unescape(encodeURIComponent(text)).length;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Walk the AST and gather counts.
 * @param {object} ast
 */
export function computeStats(ast) {
  const s = {
    objects: 0,
    arrays: 0,
    keys: 0,
    strings: 0,
    numbers: 0,
    booleans: 0,
    nulls: 0,
    nodes: 0,
    maxDepth: 0,
  };

  function walk(node, depth) {
    s.nodes++;
    if (depth > s.maxDepth) s.maxDepth = depth;
    switch (node.t) {
      case 'object':
        s.objects++;
        for (const entry of node.entries) {
          s.keys++;
          walk(entry.node, depth + 1);
        }
        break;
      case 'array':
        s.arrays++;
        for (const item of node.items) walk(item, depth + 1);
        break;
      case 'string':
        s.strings++;
        break;
      case 'number':
        s.numbers++;
        break;
      case 'bool':
        s.booleans++;
        break;
      case 'null':
        s.nulls++;
        break;
    }
  }

  walk(ast, 1);
  return s;
}
