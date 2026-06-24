/**
 * Lightweight, dependency-free JSON parser.
 *
 * Produces an AST that preserves the *raw* text of number literals so that
 * values beyond Number.MAX_SAFE_INTEGER are displayed and re-serialized
 * faithfully (native JSON.parse would silently lose precision).
 *
 * Reports the line/column and a friendly message on failure, detects
 * duplicate object keys, and supports an opt-in "tolerant" mode that strips
 * // and /* *​/ comments and allows trailing commas.
 *
 * AST node shapes:
 *   { t: 'object', entries: [{ key, node, duplicate }] }
 *   { t: 'array',  items:   [node] }
 *   { t: 'string', v: <decoded string> }
 *   { t: 'number', raw: '123', v: <Number> }
 *   { t: 'bool',   v: true|false }
 *   { t: 'null' }
 */

const CH = {
  TAB: 9,
  LF: 10,
  CR: 13,
  SPACE: 32,
};

class ParseError extends Error {
  constructor(message, index) {
    super(message);
    this.name = 'ParseError';
    this.index = index;
  }
}

/**
 * Parse JSON text.
 * @param {string} text
 * @param {{ tolerant?: boolean }} [options]
 * @returns {{ ok: boolean, ast?: object, error?: object, warnings: object[], empty?: boolean }}
 */
export function parseJSON(text, options = {}) {
  const tolerant = !!options.tolerant;
  const warnings = [];
  const len = text.length;
  let i = 0;

  function isWhitespace(code) {
    return code === CH.SPACE || code === CH.TAB || code === CH.LF || code === CH.CR;
  }

  function skipWhitespace() {
    while (i < len) {
      const code = text.charCodeAt(i);
      if (isWhitespace(code)) {
        i++;
        continue;
      }
      if (tolerant && code === 47 /* / */) {
        const next = text.charCodeAt(i + 1);
        if (next === 47 /* / */) {
          i += 2;
          while (i < len && text.charCodeAt(i) !== CH.LF) i++;
          continue;
        }
        if (next === 42 /* * */) {
          i += 2;
          let closed = false;
          while (i < len) {
            if (text.charCodeAt(i) === 42 && text.charCodeAt(i + 1) === 47) {
              i += 2;
              closed = true;
              break;
            }
            i++;
          }
          if (!closed) throw new ParseError('Unterminated block comment', i);
          continue;
        }
      }
      break;
    }
  }

  function locate(index) {
    let line = 1;
    let col = 1;
    const stop = Math.min(index, len);
    for (let k = 0; k < stop; k++) {
      if (text.charCodeAt(k) === CH.LF) {
        line++;
        col = 1;
      } else {
        col++;
      }
    }
    return { line, column: col };
  }

  function fail(message, index = i) {
    throw new ParseError(message, index);
  }

  function describeChar(index) {
    if (index >= len) return 'end of input';
    const ch = text[index];
    if (ch === '\n') return 'newline';
    if (ch === '\t') return 'tab';
    return `'${ch}'`;
  }

  function parseValue() {
    skipWhitespace();
    if (i >= len) fail('Unexpected end of input — a value was expected');
    const code = text.charCodeAt(i);
    switch (code) {
      case 123: // {
        return parseObject();
      case 91: // [
        return parseArray();
      case 34: // "
        return { t: 'string', v: parseString() };
      case 116: // t
        return parseKeyword('true', { t: 'bool', v: true });
      case 102: // f
        return parseKeyword('false', { t: 'bool', v: false });
      case 110: // n
        return parseKeyword('null', { t: 'null' });
      default:
        if (code === 45 /* - */ || (code >= 48 && code <= 57)) {
          return parseNumber();
        }
        fail(`Unexpected token ${describeChar(i)} — a value was expected`);
    }
  }

  function parseKeyword(word, node) {
    for (let k = 0; k < word.length; k++) {
      if (text[i + k] !== word[k]) {
        fail(`Unexpected token ${describeChar(i)} — did you mean '${word}'?`);
      }
    }
    i += word.length;
    return node;
  }

  function parseObject() {
    i++; // consume {
    const entries = [];
    const seen = new Set();
    skipWhitespace();
    if (text.charCodeAt(i) === 125 /* } */) {
      i++;
      return { t: 'object', entries };
    }
    for (;;) {
      skipWhitespace();
      if (text.charCodeAt(i) !== 34 /* " */) {
        if (i >= len) fail('Unexpected end of input — expected a property name');
        fail(`Expected a property name in double quotes but found ${describeChar(i)}`);
      }
      const keyStart = i;
      const key = parseString();
      const duplicate = seen.has(key);
      if (duplicate) {
        warnings.push({
          type: 'duplicate-key',
          message: `Duplicate key "${key}"`,
          ...locate(keyStart),
        });
      }
      seen.add(key);
      skipWhitespace();
      if (text.charCodeAt(i) !== 58 /* : */) {
        fail(`Expected ':' after property name but found ${describeChar(i)}`);
      }
      i++; // consume :
      const node = parseValue();
      entries.push({ key, node, duplicate });
      skipWhitespace();
      const next = text.charCodeAt(i);
      if (next === 44 /* , */) {
        i++;
        skipWhitespace();
        if (text.charCodeAt(i) === 125 /* } */) {
          if (tolerant) {
            i++;
            return { t: 'object', entries };
          }
          fail("Trailing comma is not allowed in JSON (enable lenient parsing to permit it)");
        }
        continue;
      }
      if (next === 125 /* } */) {
        i++;
        return { t: 'object', entries };
      }
      if (i >= len) fail("Unexpected end of input — expected ',' or '}'");
      fail(`Expected ',' or '}' but found ${describeChar(i)}`);
    }
  }

  function parseArray() {
    i++; // consume [
    const items = [];
    skipWhitespace();
    if (text.charCodeAt(i) === 93 /* ] */) {
      i++;
      return { t: 'array', items };
    }
    for (;;) {
      const node = parseValue();
      items.push(node);
      skipWhitespace();
      const next = text.charCodeAt(i);
      if (next === 44 /* , */) {
        i++;
        skipWhitespace();
        if (text.charCodeAt(i) === 93 /* ] */) {
          if (tolerant) {
            i++;
            return { t: 'array', items };
          }
          fail('Trailing comma is not allowed in JSON (enable lenient parsing to permit it)');
        }
        continue;
      }
      if (next === 93 /* ] */) {
        i++;
        return { t: 'array', items };
      }
      if (i >= len) fail("Unexpected end of input — expected ',' or ']'");
      fail(`Expected ',' or ']' but found ${describeChar(i)}`);
    }
  }

  function parseString() {
    // assumes current char is the opening quote
    i++; // consume opening "
    let result = '';
    let chunkStart = i;
    for (;;) {
      if (i >= len) fail('Unterminated string — missing closing quote', i);
      const code = text.charCodeAt(i);
      if (code === 34 /* " */) {
        result += text.slice(chunkStart, i);
        i++;
        return result;
      }
      if (code === 92 /* \ */) {
        result += text.slice(chunkStart, i);
        i++;
        result += parseEscape();
        chunkStart = i;
        continue;
      }
      if (code < 0x20) {
        fail('Invalid character in string — control characters must be escaped', i);
      }
      i++;
    }
  }

  function parseEscape() {
    if (i >= len) fail('Unterminated escape sequence', i);
    const code = text.charCodeAt(i);
    i++;
    switch (code) {
      case 34: return '"';
      case 92: return '\\';
      case 47: return '/';
      case 98: return '\b';
      case 102: return '\f';
      case 110: return '\n';
      case 114: return '\r';
      case 116: return '\t';
      case 117: { // u
        let hex = '';
        for (let k = 0; k < 4; k++) {
          const c = text[i + k];
          if (!c || !/[0-9a-fA-F]/.test(c)) {
            fail('Invalid unicode escape — expected 4 hexadecimal digits', i - 2);
          }
          hex += c;
        }
        i += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      default:
        fail(`Invalid escape sequence '\\${String.fromCharCode(code)}'`, i - 2);
    }
  }

  function parseNumber() {
    const start = i;
    if (text.charCodeAt(i) === 45 /* - */) i++;
    if (text.charCodeAt(i) === 48 /* 0 */) {
      i++;
    } else if (text.charCodeAt(i) >= 49 && text.charCodeAt(i) <= 57) {
      i++;
      while (i < len && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) i++;
    } else {
      fail('Invalid number', start);
    }
    if (text.charCodeAt(i) === 46 /* . */) {
      i++;
      if (!(text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57)) {
        fail('Invalid number — a digit is required after the decimal point', i);
      }
      while (i < len && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) i++;
    }
    const e = text.charCodeAt(i);
    if (e === 101 /* e */ || e === 69 /* E */) {
      i++;
      const sign = text.charCodeAt(i);
      if (sign === 43 /* + */ || sign === 45 /* - */) i++;
      if (!(text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57)) {
        fail('Invalid number — a digit is required in the exponent', i);
      }
      while (i < len && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) i++;
    }
    const raw = text.slice(start, i);
    return { t: 'number', raw, v: Number(raw) };
  }

  // ---- entry ----
  try {
    skipWhitespace();
    if (i >= len) {
      return { ok: false, empty: true, warnings, error: { message: 'No JSON to parse', line: 1, column: 1, index: 0 } };
    }
    const ast = parseValue();
    skipWhitespace();
    if (i < len) {
      fail(`Unexpected token ${describeChar(i)} after JSON value`);
    }
    return { ok: true, ast, warnings };
  } catch (err) {
    if (err instanceof ParseError) {
      const { line, column } = locate(err.index);
      return {
        ok: false,
        warnings,
        error: { message: err.message, line, column, index: err.index },
      };
    }
    // Never leak an uncaught error.
    return {
      ok: false,
      warnings,
      error: { message: 'Could not parse input', line: 1, column: 1, index: 0 },
    };
  }
}
