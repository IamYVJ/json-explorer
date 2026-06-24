# JSON Explorer

A fast, privacy-first tool to **validate, format, minify, and explore JSON** — with an interactive, collapsible tree view at its centre. Everything runs **100% in your browser**; the JSON you paste never leaves your device.

## Features

- **Interactive tree view** — collapsible branches with indent guides, type-coloured values, container counts, array indices, and lazy rendering that stays smooth on large files.
- **Search** the tree by key or value, with match highlighting, ancestor auto-expand, and next/previous navigation.
- **JSON paths** — click any node to see and copy its dot-notation (`team[0].name`) and bracket-notation (`["team"][0]["name"]`) path, or copy the node's value.
- **Validation** with friendly, precise error messages including **line and column**, a gutter highlight, and a "jump to error" action.
- **Format / beautify** with 2-space, 4-space, or tab indentation, plus an optional **sort-keys** toggle.
- **Minify** to compact single-line JSON.
- **Copy & download** formatted or minified output with an editable filename.
- **Stats** — size, key count, object/array counts, and maximum nesting depth.
- **Robust parsing** — preserves large integers exactly (no precision loss), flags duplicate keys, handles unicode, and offers an optional **lenient mode** that strips `//` and `/* */` comments and trailing commas.
- **Input** by paste, clipboard, file picker, or drag-and-drop of a `.json` file.
- **Light & dark themes**, responsive layout, keyboard shortcuts, and **offline support** (installable, works after first visit).

## Project structure

```
index.html              # markup + layout
css/styles.css          # design system (light + dark)
js/
  app.js                # UI wiring
  parser.js             # JSON parser/validator (AST, line/column errors)
  serialize.js          # format / minify (precision-faithful)
  stats.js              # size & structure statistics
  tree.js               # interactive tree renderer
  sample.js             # bundled sample document
manifest.webmanifest    # PWA manifest
sw.js                   # offline service worker
assets/                 # icons
sample.json             # sample file for testing upload / drag-and-drop
```

## Privacy

There is no backend and no analytics. Parsing, formatting, and rendering all happen locally in your browser.

## License

See [LICENSE](LICENSE).

---

Developed by Yashvardhan Jain.
