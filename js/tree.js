/**
 * Interactive, collapsible JSON tree renderer.
 *
 * Design goals:
 *  - Self-contained: takes an AST (see parser.js) and a container element.
 *  - Performant on large input: children are built lazily (only when a node
 *    is expanded) and very large containers render in chunks. Toggling a node
 *    flips a CSS class in place rather than re-rendering the tree.
 *  - Rich: type-coloured values, container counts, array indices, branch
 *    guides, JSON path on select, long-string truncation, and search with
 *    highlight + ancestor auto-expand + next/previous navigation.
 */

import { escapeString, scalarToText, nodeToJSON } from './serialize.js';

const STRING_TRUNCATE = 150;
const CHILD_CHUNK = 200;
const MAX_EXPAND_NODES = 25000;
const SEARCH_HIGHLIGHT_CAP = 1500;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function quoteDisplay(str) {
  return '"' + escapeString(str) + '"';
}

function scalarClass(node) {
  switch (node.t) {
    case 'string': return 'jt-string';
    case 'number': return 'jt-number';
    case 'bool': return 'jt-boolean';
    case 'null': return 'jt-null';
    default: return '';
  }
}

function scalarDisplay(node) {
  switch (node.t) {
    case 'string': return quoteDisplay(node.v);
    case 'number': return node.raw;
    case 'bool': return node.v ? 'true' : 'false';
    case 'null': return 'null';
    default: return '';
  }
}

function isUnsafeInteger(node) {
  return (
    node.t === 'number' &&
    /^-?\d+$/.test(node.raw) &&
    !Number.isSafeInteger(Number(node.raw))
  );
}

function containerPreview(node) {
  if (node.t === 'object') {
    if (node.entries.length === 0) return '';
    const keys = node.entries.slice(0, 3).map((e) => e.key);
    const more = node.entries.length > 3 ? ', …' : '';
    return keys.join(', ') + more;
  }
  if (node.t === 'array') {
    if (node.items.length === 0) return '';
    const parts = node.items.slice(0, 3).map((it) => {
      if (it.t === 'object') return '{…}';
      if (it.t === 'array') return '[…]';
      const txt = scalarDisplay(it);
      return txt.length > 14 ? txt.slice(0, 14) + '…' : txt;
    });
    const more = node.items.length > 3 ? ', …' : '';
    return parts.join(', ') + more;
  }
  return '';
}

/**
 * @param {HTMLElement} container
 * @param {{ onSelect?: Function, onCopy?: Function, onNotice?: Function }} callbacks
 */
export function createTreeView(container, callbacks = {}) {
  const onSelect = callbacks.onSelect || (() => {});
  const onCopy = callbacks.onCopy || (() => {});
  const onNotice = callbacks.onNotice || (() => {});

  let rootAst = null;
  let rootWrapper = null;
  let totalNodes = 0;
  let selectedRow = null;

  // search state — shared by substring search and JSONPath queries.
  // matchMode decides how a match is shown: 'text' highlights the matching
  // substring inside a key/value span; 'path' highlights the whole matched row.
  let matches = [];
  let matchIndex = -1;
  let matchMode = 'text';
  const decorated = [];

  container.setAttribute('role', 'tree');

  // ---------- building ----------

  function makeWrapper(node, seg, parentWrapper, depth) {
    const wrapper = document.createElement('div');
    wrapper.className = 'jt-node';
    wrapper._node = node;
    wrapper._seg = seg;
    wrapper._parentNode = parentWrapper;
    wrapper._depth = depth;
    wrapper._built = false;

    const row = document.createElement('div');
    row.className = 'jt-row';
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    row.tabIndex = depth === 0 ? 0 : -1;
    wrapper._row = row;

    const isContainer = node.t === 'object' || node.t === 'array';

    if (isContainer) {
      const caret = document.createElement('span');
      caret.className = 'jt-caret';
      caret.setAttribute('aria-hidden', 'true');
      row.appendChild(caret);
      row.setAttribute('aria-expanded', 'false');
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'jt-caret jt-caret-empty';
      spacer.setAttribute('aria-hidden', 'true');
      row.appendChild(spacer);
    }

    // label (key or array index)
    if (seg) {
      const label = document.createElement('span');
      if (seg.type === 'key') {
        label.className = 'jt-key';
        label.textContent = quoteDisplay(seg.key);
      } else {
        label.className = 'jt-index';
        label.textContent = String(seg.index);
      }
      row.appendChild(label);
      const colon = document.createElement('span');
      colon.className = 'jt-colon';
      colon.textContent = ':';
      row.appendChild(colon);
    }

    if (isContainer) {
      const count = node.t === 'object' ? node.entries.length : node.items.length;
      const open = node.t === 'object' ? '{' : '[';
      const close = node.t === 'object' ? '}' : ']';

      const openBracket = document.createElement('span');
      openBracket.className = 'jt-bracket';
      openBracket.textContent = open;
      row.appendChild(openBracket);

      const badge = document.createElement('span');
      badge.className = 'jt-count';
      badge.textContent = String(count);
      badge.title = node.t === 'object' ? `${count} key${count === 1 ? '' : 's'}` : `${count} item${count === 1 ? '' : 's'}`;
      row.appendChild(badge);

      const preview = document.createElement('span');
      preview.className = 'jt-preview';
      preview.textContent = containerPreview(node);
      row.appendChild(preview);

      const closeBracket = document.createElement('span');
      closeBracket.className = 'jt-bracket jt-bracket-close';
      closeBracket.textContent = close;
      row.appendChild(closeBracket);

      wrapper.appendChild(row);

      const childrenEl = document.createElement('div');
      childrenEl.className = 'jt-children';
      childrenEl.setAttribute('role', 'group');
      wrapper._childrenEl = childrenEl;
      wrapper._renderedCount = 0;
      wrapper.appendChild(childrenEl);

      if (count === 0) {
        wrapper.classList.add('jt-leaf-container');
      }
    } else {
      const value = document.createElement('span');
      value.className = 'jt-value ' + scalarClass(node);
      if (node.t === 'string' && node.v.length > STRING_TRUNCATE) {
        value.dataset.full = scalarDisplay(node);
        value.dataset.short = '"' + escapeString(node.v.slice(0, STRING_TRUNCATE)) + '…"';
        value.dataset.expanded = '0';
        value.textContent = value.dataset.short;
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'jt-more';
        more.textContent = 'show more';
        row.appendChild(value);
        row.appendChild(more);
      } else {
        value.textContent = scalarDisplay(node);
        if (isUnsafeInteger(node)) {
          value.classList.add('jt-bignum');
          value.title = 'Large integer shown exactly as text (exceeds safe numeric precision)';
        }
        if (node.t === 'string') value.title = 'Click to copy value';
        row.appendChild(value);
      }
      wrapper.appendChild(row);
    }

    return wrapper;
  }

  function childCount(node) {
    return node.t === 'object' ? node.entries.length : node.items.length;
  }

  function childAt(node, idx) {
    if (node.t === 'object') {
      const e = node.entries[idx];
      return { node: e.node, seg: { type: 'key', key: e.key }, duplicate: e.duplicate };
    }
    const item = node.items[idx];
    return { node: item, seg: { type: 'index', index: idx } };
  }

  // Build the next chunk of children for a container wrapper.
  function buildChunk(wrapper, autoExpandLevels) {
    const node = wrapper._node;
    const total = childCount(node);
    const start = wrapper._renderedCount;
    const end = Math.min(start + CHILD_CHUNK, total);

    // Remove any existing "load more" control before appending.
    const existingMore = wrapper._childrenEl.querySelector(':scope > .jt-load-more');
    if (existingMore) existingMore.remove();

    const frag = document.createDocumentFragment();
    for (let idx = start; idx < end; idx++) {
      const { node: childNode, seg, duplicate } = childAt(node, idx);
      const childWrapper = makeWrapper(childNode, seg, wrapper, wrapper._depth + 1);
      if (duplicate) childWrapper._row.querySelector('.jt-key')?.classList.add('jt-key-dup');
      frag.appendChild(childWrapper);
      if (autoExpandLevels > 0 && (childNode.t === 'object' || childNode.t === 'array')) {
        // Defer auto-expansion until after insertion so children exist in DOM.
        childWrapper._autoExpand = autoExpandLevels - 1;
      }
    }
    wrapper._childrenEl.appendChild(frag);
    wrapper._renderedCount = end;

    if (end < total) {
      const loadMore = document.createElement('button');
      loadMore.type = 'button';
      loadMore.className = 'jt-load-more';
      loadMore.textContent = `Show ${Math.min(CHILD_CHUNK, total - end)} more (${total - end} remaining)`;
      loadMore.addEventListener('click', (e) => {
        e.stopPropagation();
        buildChunk(wrapper, 0);
      });
      wrapper._childrenEl.appendChild(loadMore);
    }

    // Apply deferred auto-expansion.
    for (let i = 0; i < wrapper._childrenEl.children.length; i++) {
      const child = wrapper._childrenEl.children[i];
      if (child._autoExpand != null) {
        const levels = child._autoExpand;
        child._autoExpand = null;
        expand(child, levels);
      }
    }
  }

  function ensureBuilt(wrapper, autoExpandLevels = 0) {
    if (wrapper._built) return;
    wrapper._built = true;
    if (childCount(wrapper._node) === 0) return;
    buildChunk(wrapper, autoExpandLevels);
  }

  // ---------- expand / collapse ----------

  function isContainerWrapper(wrapper) {
    return wrapper._node.t === 'object' || wrapper._node.t === 'array';
  }

  function expand(wrapper, autoExpandLevels = 0) {
    if (!isContainerWrapper(wrapper)) return;
    if (childCount(wrapper._node) === 0) return;
    ensureBuilt(wrapper, autoExpandLevels);
    wrapper.classList.add('is-open');
    wrapper._row.setAttribute('aria-expanded', 'true');
  }

  function collapse(wrapper) {
    if (!isContainerWrapper(wrapper)) return;
    wrapper.classList.remove('is-open');
    wrapper._row.setAttribute('aria-expanded', 'false');
  }

  function toggle(wrapper) {
    if (!isContainerWrapper(wrapper)) return;
    if (wrapper.classList.contains('is-open')) collapse(wrapper);
    else expand(wrapper, 0);
  }

  function expandAll() {
    if (totalNodes > MAX_EXPAND_NODES) {
      onNotice(`This document has ${totalNodes.toLocaleString()} nodes — expanding the first levels only to stay responsive.`);
      expandToDepth(3);
      return;
    }
    function rec(wrapper) {
      if (!isContainerWrapper(wrapper)) return;
      // Build every chunk for this container.
      while (wrapper._renderedCount < childCount(wrapper._node) || !wrapper._built) {
        ensureBuilt(wrapper);
        if (wrapper._renderedCount >= childCount(wrapper._node)) break;
        buildChunk(wrapper, 0);
      }
      wrapper.classList.add('is-open');
      wrapper._row.setAttribute('aria-expanded', 'true');
      for (const child of wrapper._childrenEl.children) {
        if (child.classList && child.classList.contains('jt-node')) rec(child);
      }
    }
    if (rootWrapper) rec(rootWrapper);
  }

  function collapseAll() {
    // Collapse every container except the root so the top level stays visible.
    const open = container.querySelectorAll('.jt-node.is-open');
    open.forEach((w) => {
      if (w !== rootWrapper) {
        w.classList.remove('is-open');
        w._row.setAttribute('aria-expanded', 'false');
      }
    });
    if (rootWrapper) expand(rootWrapper, 0);
  }

  function expandToDepth(targetDepth) {
    function rec(wrapper) {
      if (!isContainerWrapper(wrapper)) return;
      if (wrapper._depth < targetDepth) {
        expand(wrapper, 0);
        for (const child of wrapper._childrenEl.children) {
          if (child.classList && child.classList.contains('jt-node')) rec(child);
        }
      } else {
        collapse(wrapper);
      }
    }
    if (rootWrapper) rec(rootWrapper);
  }

  // ---------- path ----------

  function buildPath(wrapper) {
    const segs = [];
    let w = wrapper;
    while (w && w._seg) {
      segs.push(w._seg);
      w = w._parentNode;
    }
    segs.reverse();

    let dot = '';
    let bracket = '';
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.type === 'index') {
        dot += `[${seg.index}]`;
        bracket += `[${seg.index}]`;
      } else if (IDENT_RE.test(seg.key)) {
        dot += dot === '' ? seg.key : `.${seg.key}`;
        bracket += `["${escapeString(seg.key)}"]`;
      } else {
        dot += `["${escapeString(seg.key)}"]`;
        bracket += `["${escapeString(seg.key)}"]`;
      }
    }
    if (dot === '') dot = '(root)';
    if (bracket === '') bracket = '(root)';
    return { dotPath: dot, bracketPath: bracket };
  }

  function selectRow(wrapper) {
    if (selectedRow) selectedRow.classList.remove('is-selected');
    selectedRow = wrapper._row;
    selectedRow.classList.add('is-selected');
    // roving tabindex
    if (rootWrapper) {
      container.querySelectorAll('.jt-row').forEach((r) => (r.tabIndex = -1));
    }
    selectedRow.tabIndex = 0;

    const { dotPath, bracketPath } = buildPath(wrapper);
    onSelect({
      dotPath,
      bracketPath,
      node: wrapper._node,
      valueText: isContainerWrapper(wrapper) ? nodeToJSON(wrapper._node) : scalarToText(wrapper._node),
      type: wrapper._node.t,
    });
  }

  // ---------- events ----------

  container.addEventListener('click', (e) => {
    const target = e.target;
    if (target.classList.contains('jt-load-more')) return; // handled separately
    const wrapper = target.closest('.jt-node');
    if (!wrapper) return;

    if (target.classList.contains('jt-more')) {
      const value = wrapper._row.querySelector('.jt-value');
      const expanded = value.dataset.expanded === '1';
      value.textContent = expanded ? value.dataset.short : value.dataset.full;
      value.dataset.expanded = expanded ? '0' : '1';
      target.textContent = expanded ? 'show more' : 'show less';
      e.stopPropagation();
      return;
    }

    if (target.classList.contains('jt-caret')) {
      toggle(wrapper);
      return;
    }

    // Clicking a scalar value copies it.
    if (target.classList.contains('jt-value') && !isContainerWrapper(wrapper)) {
      selectRow(wrapper);
      onCopy(scalarToText(wrapper._node), 'Value copied');
      return;
    }

    // Clicking elsewhere on a container row toggles it; otherwise just select.
    selectRow(wrapper);
    if (isContainerWrapper(wrapper) && target.closest('.jt-row') === wrapper._row) {
      toggle(wrapper);
    }
  });

  container.addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('.jt-row');
    if (!row) return;
    const wrapper = row.closest('.jt-node');
    switch (e.key) {
      case 'Enter':
      case ' ': {
        e.preventDefault();
        selectRow(wrapper);
        if (isContainerWrapper(wrapper)) toggle(wrapper);
        break;
      }
      case 'ArrowRight': {
        e.preventDefault();
        if (isContainerWrapper(wrapper) && !wrapper.classList.contains('is-open')) {
          expand(wrapper, 0);
        } else {
          focusRelative(row, 1);
        }
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        if (isContainerWrapper(wrapper) && wrapper.classList.contains('is-open')) {
          collapse(wrapper);
        } else if (wrapper._parentNode) {
          focusRow(wrapper._parentNode._row);
        }
        break;
      }
      case 'ArrowDown':
        e.preventDefault();
        focusRelative(row, 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusRelative(row, -1);
        break;
    }
  });

  function visibleRows() {
    return Array.from(container.querySelectorAll('.jt-row')).filter(
      (r) => r.offsetParent !== null
    );
  }

  function focusRow(row) {
    if (!row) return;
    container.querySelectorAll('.jt-row').forEach((r) => (r.tabIndex = -1));
    row.tabIndex = 0;
    row.focus();
  }

  function focusRelative(row, delta) {
    const rows = visibleRows();
    const idx = rows.indexOf(row);
    if (idx === -1) return;
    const next = rows[idx + delta];
    if (next) focusRow(next);
  }

  // ---------- search ----------

  function clearHighlights() {
    for (const { el, text } of decorated) {
      el.textContent = text;
    }
    decorated.length = 0;
    container.querySelectorAll('.jt-row.is-current').forEach((r) => r.classList.remove('is-current'));
    container.querySelectorAll('.jt-row.jt-path-hit').forEach((r) => r.classList.remove('jt-path-hit'));
    matches = [];
    matchIndex = -1;
    matchMode = 'text';
    container._searchQuery = '';
  }

  function highlightSpan(span, query) {
    const text = span.dataset.expanded === '1' && span.dataset.full ? span.dataset.full : span.textContent;
    const lower = text.toLowerCase();
    const q = query.toLowerCase();
    let from = 0;
    let idx = lower.indexOf(q, from);
    if (idx === -1) return;
    decorated.push({ el: span, text: span.textContent });
    span.textContent = '';
    while (idx !== -1) {
      if (idx > from) span.appendChild(document.createTextNode(text.slice(from, idx)));
      const mark = document.createElement('mark');
      mark.className = 'jt-mark';
      mark.textContent = text.slice(idx, idx + q.length);
      span.appendChild(mark);
      from = idx + q.length;
      idx = lower.indexOf(q, from);
    }
    if (from < text.length) span.appendChild(document.createTextNode(text.slice(from)));
  }

  function collectMatches(query) {
    const q = query.toLowerCase();
    const found = [];
    function rec(node, address) {
      if (node.t === 'object') {
        node.entries.forEach((e, idx) => {
          const childAddr = address.concat(idx);
          if (e.key.toLowerCase().includes(q)) found.push({ address: childAddr, where: 'key' });
          rec(e.node, childAddr);
        });
      } else if (node.t === 'array') {
        node.items.forEach((item, idx) => rec(item, address.concat(idx)));
      } else {
        const text =
          node.t === 'string' ? node.v : node.t === 'number' ? node.raw : node.t === 'bool' ? String(node.v) : 'null';
        if (text.toLowerCase().includes(q)) found.push({ address, where: 'value' });
      }
    }
    rec(rootAst, []);
    return found;
  }

  // Navigate to a node by positional address, expanding ancestors on the way.
  function wrapperByAddress(address) {
    let wrapper = rootWrapper;
    for (const idx of address) {
      expand(wrapper, 0);
      // Ensure enough chunks built to reach idx.
      while (wrapper._renderedCount <= idx && wrapper._renderedCount < childCount(wrapper._node)) {
        buildChunk(wrapper, 0);
      }
      const children = Array.from(wrapper._childrenEl.children).filter(
        (c) => c.classList && c.classList.contains('jt-node')
      );
      wrapper = children[idx];
      if (!wrapper) return null;
    }
    return wrapper;
  }

  function decorateMatch(match) {
    const wrapper = wrapperByAddress(match.address);
    if (!wrapper) return null;
    const span = match.where === 'key' ? wrapper._row.querySelector('.jt-key') : wrapper._row.querySelector('.jt-value');
    if (span) {
      const query = container._searchQuery;
      if (query) highlightSpan(span, query);
    }
    return wrapper;
  }

  function search(query) {
    clearHighlights();
    container._searchQuery = query;
    if (!query) return { count: 0, index: 0 };

    matches = collectMatches(query);
    if (matches.length === 0) return { count: 0, index: 0 };

    // Pre-expand + highlight up to a cap to keep large documents responsive.
    const cap = Math.min(matches.length, SEARCH_HIGHLIGHT_CAP);
    for (let i = 0; i < cap; i++) {
      decorateMatch(matches[i]);
    }
    if (matches.length > SEARCH_HIGHLIGHT_CAP) {
      onNotice(`${matches.length.toLocaleString()} matches — highlighting the first ${SEARCH_HIGHLIGHT_CAP.toLocaleString()}.`);
    }
    matchIndex = 0;
    focusMatch();
    return { count: matches.length, index: matchIndex + 1 };
  }

  // Highlight a set of nodes located by positional address (as produced by the
  // JSONPath engine). Reuses the search match cursor so next/previous work too.
  function highlightPaths(addresses) {
    clearHighlights();
    matchMode = 'path';
    if (!addresses || addresses.length === 0) return { count: 0, index: 0 };

    matches = addresses.map((address) => ({ address }));

    // Expand ancestors + mark rows up to a cap to stay responsive on big docs.
    const cap = Math.min(matches.length, SEARCH_HIGHLIGHT_CAP);
    for (let i = 0; i < cap; i++) {
      const wrapper = wrapperByAddress(matches[i].address);
      if (wrapper) wrapper._row.classList.add('jt-path-hit');
    }
    if (matches.length > SEARCH_HIGHLIGHT_CAP) {
      onNotice(`${matches.length.toLocaleString()} matches — highlighting the first ${SEARCH_HIGHLIGHT_CAP.toLocaleString()}.`);
    }
    matchIndex = 0;
    focusMatch();
    return { count: matches.length, index: matchIndex + 1 };
  }

  function focusMatch() {
    if (matchIndex < 0 || matchIndex >= matches.length) return;
    container.querySelectorAll('.jt-row.is-current').forEach((r) => r.classList.remove('is-current'));
    const wrapper = wrapperByAddress(matches[matchIndex].address);
    if (!wrapper) return;
    // Make sure beyond-cap matches are decorated too (the up-front pass stops
    // at SEARCH_HIGHLIGHT_CAP). Path matches highlight the whole row; text
    // matches highlight the matching substring inside the key/value span.
    if (matchIndex >= SEARCH_HIGHLIGHT_CAP) {
      if (matchMode === 'path') wrapper._row.classList.add('jt-path-hit');
      else decorateMatch(matches[matchIndex]);
    }
    wrapper._row.classList.add('is-current');
    wrapper._row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function nextMatch() {
    if (matches.length === 0) return { count: 0, index: 0 };
    matchIndex = (matchIndex + 1) % matches.length;
    focusMatch();
    return { count: matches.length, index: matchIndex + 1 };
  }

  function prevMatch() {
    if (matches.length === 0) return { count: 0, index: 0 };
    matchIndex = (matchIndex - 1 + matches.length) % matches.length;
    focusMatch();
    return { count: matches.length, index: matchIndex + 1 };
  }

  // ---------- public render ----------

  function countNodes(ast) {
    let n = 0;
    const stack = [ast];
    while (stack.length) {
      const node = stack.pop();
      n++;
      if (n > MAX_EXPAND_NODES * 4) return n; // early-out; we only need a ballpark
      if (node.t === 'object') {
        for (const e of node.entries) stack.push(e.node);
      } else if (node.t === 'array') {
        for (const it of node.items) stack.push(it);
      }
    }
    return n;
  }

  function render(ast, options = {}) {
    const expandDepth = options.expandDepth != null ? options.expandDepth : 2;
    clearHighlights();
    container.innerHTML = '';
    selectedRow = null;
    rootAst = ast;
    totalNodes = countNodes(ast);

    rootWrapper = makeWrapper(ast, null, null, 0);
    container.appendChild(rootWrapper);
    expand(rootWrapper, Math.max(0, expandDepth - 1));

    return { totalNodes };
  }

  function clear() {
    clearHighlights();
    container.innerHTML = '';
    rootAst = null;
    rootWrapper = null;
    selectedRow = null;
  }

  return {
    render,
    clear,
    expandAll,
    collapseAll,
    expandToDepth,
    search,
    highlightPaths,
    nextMatch,
    prevMatch,
    clearSearch: clearHighlights,
    get totalNodes() {
      return totalNodes;
    },
  };
}
