/**
 * JSON Explorer — UI wiring.
 *
 * Connects the editor, parser, serializer, stats and tree renderer. All work
 * happens locally; nothing is ever transmitted.
 */

import { parseJSON } from './parser.js';
import { format, minify } from './serialize.js';
import { computeStats, byteLength, formatBytes } from './stats.js';
import { createTreeView } from './tree.js';
import { SAMPLE_JSON } from './sample.js';

const $ = (id) => document.getElementById(id);

// ---- elements ----
const editor = $('input-editor');
const editorWrap = $('editor-wrap');
const gutter = $('gutter');
const dropOverlay = $('drop-overlay');
const fileInput = $('file-input');

const statusState = $('status-state');
const statusDetail = $('status-detail');
const btnJumpError = $('btn-jump-error');
const statsRow = $('stats-row');

const tabs = Array.from(document.querySelectorAll('.tab'));
const views = {
  tree: $('view-tree'),
  formatted: $('view-formatted'),
  minified: $('view-minified'),
};
const treeToolbar = $('tree-toolbar');
const textToolbar = $('text-toolbar');
const emptyState = $('empty-state');

const indentSelect = $('indent-select');
const sortKeysToggle = $('sort-keys');
const lenientToggle = $('lenient');

const treeContainer = $('tree-container');
const formattedPre = $('formatted-pre');
const minifiedPre = $('minified-pre');

const pathBar = $('path-bar');
const pathText = $('path-text');

const searchInput = $('search-input');
const searchCount = $('search-count');

const filenameInput = $('filename');
const toastEl = $('toast');

// ---- state ----
let currentView = 'tree';
let lastResult = null; // { ok, ast, error, warnings }
let selectedNode = null; // { dotPath, bracketPath, valueText }
let debounceTimer = null;

// ============================================================
// Toast
// ============================================================
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  requestAnimationFrame(() => toastEl.classList.add('is-visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('is-visible');
    setTimeout(() => (toastEl.hidden = true), 220);
  }, 1900);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(label || 'Copied');
  } catch {
    // Fallback for non-secure contexts.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(label || 'Copied');
    } catch {
      toast('Copy failed — select and copy manually');
    }
    ta.remove();
  }
}

// ============================================================
// Tree view controller
// ============================================================
const tree = createTreeView(treeContainer, {
  onSelect: (info) => {
    selectedNode = info;
    pathBar.hidden = false;
    pathText.textContent = info.dotPath;
  },
  onCopy: (text, label) => copyText(text, label),
  onNotice: (msg) => toast(msg),
});

// ============================================================
// Options
// ============================================================
function indentString() {
  const v = indentSelect.value;
  if (v === 'tab') return '\t';
  return ' '.repeat(parseInt(v, 10) || 2);
}

// ============================================================
// Gutter (line numbers)
// ============================================================
function updateGutter(errorLine) {
  const lines = editor.value.split('\n').length || 1;
  let html = '';
  for (let i = 1; i <= lines; i++) {
    html += errorLine === i ? `<span class="gl-error">${i}</span>\n` : `${i}\n`;
  }
  gutter.innerHTML = html;
  gutter.scrollTop = editor.scrollTop;
}

editor.addEventListener('scroll', () => {
  gutter.scrollTop = editor.scrollTop;
});

// ============================================================
// Status + stats
// ============================================================
function setStatus(kind, label, detailHTML = '') {
  statusState.className = 'status-state status-' + kind;
  statusState.textContent = label;
  statusDetail.innerHTML = detailHTML;
}

function renderStats(ast, text) {
  const s = computeStats(ast);
  statsRow.hidden = false;
  $('stat-size').innerHTML = `<b>${formatBytes(byteLength(text))}</b> size`;
  $('stat-keys').innerHTML = `<b>${s.keys.toLocaleString()}</b> keys`;
  $('stat-arrays').innerHTML = `<b>${s.arrays.toLocaleString()}</b> arrays`;
  $('stat-objects').innerHTML = `<b>${s.objects.toLocaleString()}</b> objects`;
  $('stat-depth').innerHTML = `<b>${s.maxDepth}</b> max depth`;
}

// ============================================================
// Core: process input
// ============================================================
function processInput() {
  const text = editor.value;
  const trimmed = text.trim();

  if (trimmed === '') {
    lastResult = null;
    selectedNode = null;
    setStatus('empty', 'Awaiting input', '');
    btnJumpError.hidden = true;
    statsRow.hidden = true;
    pathBar.hidden = true;
    tree.clear();
    formattedPre.textContent = '';
    minifiedPre.textContent = '';
    emptyState.hidden = false;
    updateGutter(0);
    searchInput.value = '';
    searchCount.textContent = '';
    return;
  }

  const result = parseJSON(text, { tolerant: lenientToggle.checked });
  lastResult = result;

  if (!result.ok) {
    const { line, column, message } = result.error;
    setStatus('error', 'Invalid JSON', `<span class="status-error-text">${escapeHTML(message)} — line ${line}, column ${column}</span>`);
    btnJumpError.hidden = false;
    btnJumpError.dataset.line = line;
    btnJumpError.dataset.column = column;
    btnJumpError.dataset.index = result.error.index;
    statsRow.hidden = true;
    updateGutter(line);
    // Keep last good output on screen but mark tree empty if nothing rendered.
    return;
  }

  // valid
  btnJumpError.hidden = true;
  updateGutter(0);
  emptyState.hidden = true;

  const dupCount = result.warnings.filter((w) => w.type === 'duplicate-key').length;
  if (dupCount > 0) {
    setStatus('warn', 'Valid JSON', `${dupCount} duplicate key${dupCount === 1 ? '' : 's'} found`);
  } else {
    setStatus('ok', 'Valid JSON', '');
  }

  renderStats(result.ast, text);
  renderActiveView();
}

function renderActiveView() {
  if (!lastResult || !lastResult.ok) return;
  const ast = lastResult.ast;
  const indent = indentString();
  const sortKeys = sortKeysToggle.checked;

  if (currentView === 'tree') {
    tree.render(ast, { expandDepth: 2 });
    // Re-apply active search if present.
    if (searchInput.value.trim()) runSearch();
  } else if (currentView === 'formatted') {
    formattedPre.textContent = format(ast, { indent, sortKeys });
  } else if (currentView === 'minified') {
    minifiedPre.textContent = minify(ast, { sortKeys });
  }
}

function escapeHTML(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============================================================
// Debounced input
// ============================================================
editor.addEventListener('input', () => {
  updateGutter(0);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(processInput, 220);
});

// ============================================================
// Tabs
// ============================================================
function switchView(view) {
  currentView = view;
  tabs.forEach((t) => {
    const active = t.dataset.view === view;
    t.classList.toggle('is-active', active);
    t.setAttribute('aria-selected', String(active));
  });
  Object.entries(views).forEach(([name, el]) => el.classList.toggle('is-active', name === view));

  const isTree = view === 'tree';
  treeToolbar.hidden = !isTree;
  textToolbar.hidden = isTree;

  // Empty state only matters when there's no valid output.
  emptyState.hidden = !!(lastResult && lastResult.ok);

  renderActiveView();
}

tabs.forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

// ============================================================
// Input actions
// ============================================================
function loadText(text) {
  editor.value = text;
  updateGutter(0);
  processInput();
}

$('btn-sample').addEventListener('click', () => loadText(SAMPLE_JSON));
$('btn-empty-sample').addEventListener('click', () => loadText(SAMPLE_JSON));

$('btn-clear').addEventListener('click', () => {
  editor.value = '';
  editor.focus();
  processInput();
});

$('btn-paste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) loadText(text);
    else toast('Clipboard is empty');
  } catch {
    toast('Clipboard access blocked — paste manually (Ctrl/Cmd+V)');
    editor.focus();
  }
});

// File upload
fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  if (file) readFile(file);
  fileInput.value = '';
});

function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    loadText(String(reader.result));
    toast(`Loaded ${file.name}`);
  };
  reader.onerror = () => toast('Could not read file');
  reader.readAsText(file);
}

// Drag & drop
['dragenter', 'dragover'].forEach((evt) =>
  editorWrap.addEventListener(evt, (e) => {
    e.preventDefault();
    editorWrap.classList.add('is-dragover');
  })
);
['dragleave', 'dragend'].forEach((evt) =>
  editorWrap.addEventListener(evt, (e) => {
    if (e.target === editorWrap || !editorWrap.contains(e.relatedTarget)) {
      editorWrap.classList.remove('is-dragover');
    }
  })
);
editorWrap.addEventListener('drop', (e) => {
  e.preventDefault();
  editorWrap.classList.remove('is-dragover');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) readFile(file);
  else {
    const text = e.dataTransfer.getData('text');
    if (text) loadText(text);
  }
});

// Jump to error
btnJumpError.addEventListener('click', () => {
  const index = parseInt(btnJumpError.dataset.index, 10) || 0;
  editor.focus();
  editor.setSelectionRange(index, index);
  // Scroll the caret into view by approximating line position.
  const line = parseInt(btnJumpError.dataset.line, 10) || 1;
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 21;
  editor.scrollTop = Math.max(0, (line - 3) * lineHeight);
  gutter.scrollTop = editor.scrollTop;
});

// ============================================================
// Output options re-render
// ============================================================
[indentSelect, sortKeysToggle].forEach((el) =>
  el.addEventListener('change', () => {
    editor.style.tabSize = indentSelect.value === 'tab' ? '4' : indentSelect.value;
    renderActiveView();
  })
);
lenientToggle.addEventListener('change', processInput);

// ============================================================
// Tree toolbar
// ============================================================
$('btn-expand').addEventListener('click', () => tree.expandAll());
$('btn-collapse').addEventListener('click', () => tree.collapseAll());

// Search
let searchDebounce = null;
function runSearch() {
  const q = searchInput.value.trim();
  if (!q) {
    tree.clearSearch();
    searchCount.textContent = '';
    return;
  }
  const r = tree.search(q);
  searchCount.textContent = r.count === 0 ? 'No matches' : `${r.index}/${r.count}`;
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(runSearch, 180);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const r = e.shiftKey ? tree.prevMatch() : tree.nextMatch();
    if (r.count) searchCount.textContent = `${r.index}/${r.count}`;
  } else if (e.key === 'Escape') {
    searchInput.value = '';
    tree.clearSearch();
    searchCount.textContent = '';
    searchInput.blur();
  }
});

$('btn-search-next').addEventListener('click', () => {
  const r = tree.nextMatch();
  if (r.count) searchCount.textContent = `${r.index}/${r.count}`;
});
$('btn-search-prev').addEventListener('click', () => {
  const r = tree.prevMatch();
  if (r.count) searchCount.textContent = `${r.index}/${r.count}`;
});

// ============================================================
// Path bar copy actions
// ============================================================
$('btn-copy-path').addEventListener('click', () => {
  if (selectedNode) copyText(selectedNode.dotPath, 'Path copied');
});
$('btn-copy-bracket').addEventListener('click', () => {
  if (selectedNode) copyText(selectedNode.bracketPath, 'Bracket path copied');
});
$('btn-copy-node').addEventListener('click', () => {
  if (selectedNode) copyText(selectedNode.valueText, 'Value copied');
});

// ============================================================
// Text view copy / download
// ============================================================
$('btn-copy-text').addEventListener('click', () => {
  const text = currentView === 'minified' ? minifiedPre.textContent : formattedPre.textContent;
  if (text) copyText(text, currentView === 'minified' ? 'Minified JSON copied' : 'Formatted JSON copied');
});

$('btn-download').addEventListener('click', () => {
  if (!lastResult || !lastResult.ok) {
    toast('Nothing valid to download');
    return;
  }
  const text = currentView === 'minified'
    ? minify(lastResult.ast, { sortKeys: sortKeysToggle.checked })
    : format(lastResult.ast, { indent: indentString(), sortKeys: sortKeysToggle.checked });
  let name = (filenameInput.value || 'data.json').trim();
  if (!/\.json$/i.test(name)) name += '.json';
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Downloaded ${name}`);
});

// ============================================================
// Theme toggle
// ============================================================
const THEME_KEY = 'json-explorer-theme';
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
}
(function initTheme() {
  let theme = 'light';
  try { theme = localStorage.getItem(THEME_KEY) || 'light'; } catch {}
  document.documentElement.setAttribute('data-theme', theme);
})();
$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
});

// ============================================================
// Global keyboard shortcuts
// ============================================================
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  // Ctrl/Cmd+Enter -> format
  if (mod && e.key === 'Enter') {
    e.preventDefault();
    switchView('formatted');
  }
  // Ctrl/Cmd+F -> focus tree search (when not in editor)
  if (mod && e.key.toLowerCase() === 'f' && document.activeElement !== editor) {
    if (currentView === 'tree') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  }
});

// ============================================================
// Service worker (offline support) — optional, relative scope.
// ============================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ---- init ----
editor.style.tabSize = indentSelect.value === 'tab' ? '4' : indentSelect.value;
updateGutter(0);
processInput();
