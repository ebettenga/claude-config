# FigCraft agent cheat sheet (v0.12.1)

## 1. CLI and MCP registration
- Binary: `figcraft-cli`. The macOS `.app` (binary `/Applications/FigCraft.app/Contents/MacOS/FigCraft`) has no CLI;
  get release asset `figcraft-cli-<ver>-macos-universal.zip` (current: `figcraft-cli-0.12.1-macos-universal.zip`):
  `gh release download -R storytold/figcraft -p 'figcraft-cli-*-macos-universal.zip'`, unzip, use the absolute path.
  (Not in docs: a downloaded binary may need `xattr -d com.apple.quarantine` before macOS runs it.)
- Headless: `claude mcp add figcraft -- /path/to/figcraft-cli mcp`
- Attached to running app: `claude mcp add figcraft-app -- /path/to/figcraft-cli mcp --attach 7979` (`host:port` ok)
- `.mcp.json`: `{"mcpServers":{"figcraft":{"command":"/path/to/figcraft-cli","args":["mcp"]},"figcraft-app":{"command":"/path/to/figcraft-cli","args":["mcp","--attach","7979"]}}}`
- Confine files (headless only): `mcp --automation-read-root DIR --automation-write-root DIR` (repeatable).
  With `--attach` these flags are a usage error: pass them to the app instead.
- Deterministic text renders (CI): `figcraft-cli mcp --no-system-fonts` or `FIGCRAFT_NO_SYSTEM_FONTS=1`.

## 2. Start the app with the control channel
- Docs: `figcraft --control <port> [file]` (examples use 7979; README uses 47800). Loopback only, no auth.
- macOS: `/Applications/FigCraft.app/Contents/MacOS/FigCraft --control 7979 [--automation-read-root DIR --automation-write-root DIR]`
  (or `open -a FigCraft --args --control 7979`, app must not already be running; documented pattern for VectorCraft).
- Port clash: VectorCraft also defaults to 7979, and `vectorcraft-cli mcp` with no flag auto-connects to 7979.
  Use a distinct port for FigCraft (e.g. 47800) if both run.

## 3. Workflow and tools
Discover -> describe -> execute -> verify:
1. `list_commands {filter?}` (or resource `figcraft://command/{id}`) for ids and params docs. Every menu action is a command.
2. `inspect_document {depth, allPages}` / `get_node {id, depth}`; find layers: `run_command node.find {root?, type?, name?, text?, limit?}`.
3. Edit: `create_node`, `set_properties {ids, props}`, `run_command {command, params}`, `batch {commands, label?, onError?}`
   (one undo step; `"as":"card"` + `{"$ref":"card"}` or `{"$step":n}` with `"field":"ids/0"` to chain ids).
4. Verify: `get_node` for numbers, `screenshot {ids?, scale?, maxSize?}` for pixels (`window:true` = app window, attached).
- Others: `select`, `export {ids, format, scale|size, path?}` (png/jpg/svg/webp/pdf/xml/fig), `open_file`, `save_file {path?}`,
  `undo`/`redo`, `pointer`, `key`, `type_text {text, id?}`, `inspect_ui`, `wait_for_changes` (comment events).
- Start from a template: `run_command template.list`, then `file.newFromTemplate {template}` (mobile-app, landing-page, dashboard, ...).
- Prompts: `mobile_screen`, `design_system`, `landing_page`, `prototype_flow`, `fix_comments`, `watch_comments`.
- CLI one-liners: `figcraft-cli render landing.figcraft -o landing.png --scale 2`;
  `figcraft-cli export landing.figcraft -o out/ --format svg`; `figcraft-cli run build-card.json --out card.figcraft`;
  `figcraft-cli commands --filter autoLayout`.

## 4. Gotchas
- Units: page units (1 = 1 px at 100%), y down. `x`/`y` are relative to the parent frame; groups have no own space.
  Auto-layout children: set `layout`/`gap`/`padding`/`sizingH|V`, not x/y. Colours `#RRGGBB[AA]`.
- Saving: nothing auto-saves for scripts (`pref.autoSave` is the app's timer); call `save_file` / `file.save`. Saves as `.figcraft`.
- Undo: each mutation is one undo step; `batch` makes one; a failing command leaves the doc unchanged.
  `batch` default `onError:"abort"` rolls back all; `"continue"` returns per-step results (`isError` false even if steps fail).
- Retries (attached): calls are never auto-replayed after a transport failure; the edit may have applied. Inspect before retrying.
- `screenshot {window:true}` fails at once if the window is minimised; plain `screenshot` renders the document.
- Programmatic calls never open dialogs. Max request line 32 MiB; large exports should use `path` or lower scale.
- Editing a styled paint unlinks its style; editing a variable-bound field detaches the variable.
