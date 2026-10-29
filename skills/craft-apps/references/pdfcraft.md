# PdfCraft (PDF reader/editor) — agent cheat sheet (v0.15.0)
Sources: storytold/pdfcraft docs/mcp.md, crates/automation/README.md, README.

## 1. CLI + MCP
- Binary `pdfcraft-cli`; macOS asset `pdfcraft-cli-<ver>-macos-universal.zip`:
  `gh release download -R storytold/pdfcraft -p 'pdfcraft-cli-*-macos-universal.zip'`
- Headless MCP is the **only** MCP mode (stdio, no port): `claude mcp add pdfcraft -- /abs/pdfcraft-cli mcp --root /work/project [--compact]`
  or split confinement: `mcp --automation-read-root /work/project --automation-write-root /work/project/out`.
- There is no MCP bridge to the running app; drive the live app with `pdfcraft-cli ui` (below).

## 2. Desktop app with control channel
- `/Applications/PdfCraft.app/Contents/MacOS/PdfCraft --control ~/.pdfcraft-control.json` — takes a **file path, not a port**; the app writes a random token there.
- `pdfcraft-cli ui --control ~/.pdfcraft-control.json <action>` with `inspect`, `click`, `key`, `command`, `drag`, `screenshot`, `resize`, `focus`, `quit`.
- Keep the control file in a folder only you can write (not `/tmp`); symlinks or group/world-readable files are refused.

## 3. Workflow
- Discover: `command_list {doc?, filter?, enabled_only?}`; `pdfcraft-cli tools` (every tool + JSON Schema); with `--compact`, `tool_search {query?, category?}` + `tool_call`.
- Describe: `doc_inspect {doc?}`; resources `pdfcraft://document`, `pdfcraft://commands`, `pdfcraft://doc/{doc}/info`.
- Execute: `command_run {id, params}` (e.g. `file.open {"path":"input.pdf"}` → `{"doc":1}`, then `page.rotate {"doc":1,"degrees":90}`), `command_batch {steps, stop_on_error?}`, or task tools `doc_open`, `page_rotate`, `text_find`, `text_extract`, `comment_add`, `form_*`, `doc_combine`, `doc_split`, `doc_save`.
- Verify: `render_preview {doc?, page?, max_side?}` (1-based page, default 1024). Live app: `pdfcraft-cli ui … screenshot --out w.png`.
- Edits are in memory (undoable) until `doc_save`; same-file save is an atomic incremental update.
- CLI:
  - `pdfcraft-cli info form.pdf` / `pdfcraft-cli text paper.pdf --page 3`
  - `pdfcraft-cli edit in.pdf --rotate 1,2:90 --delete 5 --title "Q3" --out out.pdf`
  - `pdfcraft-cli combine a.pdf b.pdf --out c.pdf`; `pdfcraft-cli extract r.pdf --pages 1,3,5-8 --out h.pdf`; `pdfcraft-cli split r.pdf --every 10 --out-dir parts/`
  - `pdfcraft-cli run text_find doc=1 query=invoice`; `pdfcraft-cli run --script steps.json --root ./work --report`
  - `pdfcraft-cli batch …` (folder conversion, OCR, compression)

## 4. Gotchas
- `--root` once, existing nonempty dir; prefix dirs starting with `--` with `./`. Paths outside roots are refused.
- Unknown top-level args → `-32602`; unknown keys inside `command_run` params are ignored with `warnings`.
- Pages/positions 1-based; rects in PDF points, origin top-left of displayed page. Omit `doc` only when exactly one is open.
- `doc_close` refuses unsaved changes unless `discard_changes: true`. A batch with a failed step is `isError` and earlier edits remain.
- `link_open` to an absolute GoToR target needs `allow_absolute: true`.
- `ui quit` with unsaved edits returns `needs_confirmation: true`.
- `ENOENT` from the client: use the absolute binary path.
