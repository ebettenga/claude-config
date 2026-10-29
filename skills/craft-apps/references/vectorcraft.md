# VectorCraft agent cheat sheet (v0.18.0)

## 1. CLI and MCP registration
- Binary: `vectorcraft-cli`. On macOS "the `.app` holds only the desktop app"; get release asset
  `vectorcraft-cli-<version>-macos-<arch>.zip` (current: `vectorcraft-cli-0.18.0-macos-universal.zip`):
  `gh release download -R storytold/vectorcraft -p 'vectorcraft-cli-*-macos-universal.zip'`, unzip onto PATH or use an absolute path.
  (Not in docs: may need `xattr -d com.apple.quarantine`.)
- Auto (tries 127.0.0.1:7979 once at start, else headless): `claude mcp add vectorcraft -- vectorcraft-cli mcp`
- Headless: `claude mcp add vectorcraft-headless -- vectorcraft-cli mcp --headless`
- Live app ("Remote"): `claude mcp add vectorcraft-app -- vectorcraft-cli mcp --connect 127.0.0.1:7979`
- `.mcp.json`: `{"mcpServers":{"vectorcraft":{"command":"vectorcraft-cli","args":["mcp"]}}}` (use absolute path if not on client PATH)
- Confine: `mcp --automation-read-root DIR --automation-write-root DIR` (repeatable; implies `--headless`; error with `--connect`).

## 2. Start the app with the control channel
- `vectorcraft --control <port>` (also `--control=<port>`), loopback only, NO authentication: enable only while in use.
- macOS (documented): quit VectorCraft first, then `open -a VectorCraft --args --control 7979`
  (direct: `/Applications/VectorCraft.app/Contents/MacOS/VectorCraft --control 7979`). Add the `--automation-*-root` flags here to confine.
- Wait for the window before starting the MCP client: a no-flag server that started first stays headless until restarted.
  `--connect` with no app exits: `vectorcraft-cli: cannot connect to 127.0.0.1:7979: ...`.
- Port clash: FigCraft docs also use 7979; give FigCraft another port.

## 3. Workflow and tools
1. Discover: `command_list {filter?|query?, menu?, enabled_only?, brief?}` (alias `list_commands`); `apply_effect {}` with no effect lists effects.
2. Describe: `doc_inspect` / `inspect_document {depth?, ids?, kind?, limit?, offset?}` (artboards, layer tree, selection, history).
3. Execute: `command_run {id, params?}` (alias `run_command {command, params?}`), `command_batch {steps:[{id, params?}], stop_on_error?, atomic?, label?}`
   (max 256 steps; `"$N.id"` refs), `draw_shape`, `draw_path {points|d}`, `set_paint`, `add_text`, `transform`, `pathfinder {operation}`,
   `create_graph`, `text_wrap`, `select_tool`, `pointer_gesture`, `press_key`, `undo`/`redo`.
4. Verify: `render_preview {max_side?, artboard?}` (inline PNG, no edit) or `screenshot {path?, scale?, artboard?}`;
   live app only: `ui_inspect`/`inspect_ui`, `ui_screenshot`/`screenshot {window:true}`, `type_text`, `answer_dialog`, `open_panel`, `invoke_menu`.
- Files: `open_file {path}` (svg, pdf/ai, eps, dxf, psd, images...), `save_file {path?}`, `export {path?, format?, scale?, artboard?, outlineText?}`.
- CLI: `vectorcraft-cli commands`;
  `vectorcraft-cli run --in in.svg --cmd select.all --cmd paint.setFill --params '{"color":"#ff0000"}' --export out.svg --export out.png --scale 2`;
  `vectorcraft-cli run --in sheet.vectorcraft --commands steps.json --export out.pdf` (`--commands -` = stdin); also `convert`, `info`.
  Reproducible bytes: `SOURCE_DATE_EPOCH=<secs>`.

## 4. Gotchas
- Units: points, y down, origin = first artboard's top-left; new doc 612 x 792 (US Letter). Paint: `"#rrggbb"`, `"none"`, `[r,g,b]` 0..1, CMYK, gray.
- Strict params: unknown keys are refused with a "did you mean" error (top level and effect params); unknown tool args -> `-32602`.
- For a filled shape without outline pass `fill` and `stroke:"none"`; omitted paint inherits the new-art appearance.
- Undo: no-op calls record no undo step, so `undo` after one undoes the previous step. Check history in `inspect_document`.
- Saving: `save_file` writes the doc's own format; saving to SVG/PDF/.ai returns `warnings` about what is lost.
- Busy engine: a call arriving while another has run >2 s gets `-32003` and was NOT run; retry later or cancel.
  Cancel with `notifications/cancelled` (no reply). With `--connect`, the app cannot be told to stop.
- `--connect`: paths in `open_file`/`save_file`/`export`/`screenshot` are made absolute by the server; paths inside `run_command` params go raw to the app (resolved against the app's cwd).
- Control line limit 4 MiB; a bad line closes the connection.
