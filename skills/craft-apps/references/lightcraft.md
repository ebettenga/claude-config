# LightCraft (Lightroom-style non-destructive photo editor) — agent cheat sheet (v0.15.0)
Sources: storytold/lightcraft docs/mcp.md, docs/control-protocol.md, README "Built for agents".

## 1. CLI + MCP
- Binary `lightcraft-cli`; macOS asset `lightcraft-cli-<ver>-macos-universal.zip`:
  `gh release download -R storytold/lightcraft -p 'lightcraft-cli-*-macos-universal.zip'` (verify against the release's `SHA256SUMS.txt`; use CLI + app from the same release).
- Headless: `claude mcp add lightcraft -- /abs/lightcraft-cli mcp [--library DIR] [--demo] [--compact] [FILES/FOLDERS…]`
- Bridge: `claude mcp add lightcraft-app -- /abs/lightcraft-cli mcp --connect 127.0.0.1:7980`
  Connect mode starts even if the app isn't running; connects on first call, reconnects after app restarts.
- Absolute paths in `.mcp.json`, no `~`.

## 2. Desktop app with control channel
- `/Applications/LightCraft.app/Contents/MacOS/LightCraft --control 7980 [--library /abs/lib] [photos…]` (or `LIGHTCRAFT_CONTROL_PORT=7980`).
- JSON lines on 127.0.0.1:7980, loopback only, **no auth** — enable only while needed.
- Isolated test profile: `LIGHTCRAFT_CONFIG_DIR=<fresh dir>` plus a scratch `--library DIR`.

## 3. Workflow
- Discover: `command_list {filter?, enabled_only?}`, `list_controls {section?}` (slider ids like `light.exposure` with ranges), `doc_inspect`, `query_photos {filter?, sort?, offset?, limit?}`.
- Describe: `get_develop {id?}`; resources `lightcraft://library`, `lightcraft://photos`, `lightcraft://photo/active`, `lightcraft://develop/active`, `lightcraft://controls` (snapshots; re-read to poll).
- Execute: `import {paths, album?, mode?: copy|move}`, `select_photos {ids, active?}`, `set_develop {values:{"light.exposure":0.7}}` (undoable), `apply_preset {preset, amount?}`, `crop {rect?, angle?, reset?}`, `command_run {id, params?}`, `command_batch {steps, stop_on_error?}`, generated `cmd_<id>` tools (`photo.rate` → `cmd_photo_rate`), `export {path|dir, ids?, format?, longEdge?…}`.
- Verify: `render_preview {id?, max_side?}`, `render_photo {id?, size?}`; bridge: `ui_screenshot`, `ui_inspect`.
- Bridge-only UI: `set_ui {state}`, `list_widgets`, `click {widget | x,y}`, `press_key`, `type_text`, `clipboard`, `pointer_gesture`.
- CLI:
  - `lightcraft-cli run --import ~/Pictures/a.dng develop.set control=light.exposure value=0.7 app.export path=/tmp/a.jpg shortEdge=1080`
  - `lightcraft-cli run --library ~/lc-lib library.select 'ids=[3]' develop.get` (quote brackets in zsh)
  - `lightcraft-cli render in.dng -o out.jpg --set light.exposure=0.5 --size 2048`
  - `lightcraft-cli commands --json` / `lightcraft-cli controls --json`
  - `lightcraft-cli snapshot --demo -o grid.png --size 1600x1000` (headless UI screenshot)

## 4. Gotchas
- Library lock: one process per library (`catalog.lock`). Headless `--library` fails while the app has it open — use `--connect`.
- Unknown outcome after a dropped connection: nothing is resent; inspect state before retrying.
- Headless and connect sessions are separate; photo ids are per library/session — re-read after reconnecting.
- Control channel: idle connections close after 5 min; request abandoned if the app draws no frame for 5 s (keep window visible, not minimized); non-JSON line closes the connection; max 16 connections.
- Detail-view screenshots: poll `ui.inspect` until `loupe.pending` is false.
- `ui.key` doesn't trigger macOS menu accelerators — use `ui.menu.invoke` / `engine.execute` with the command id (e.g. `edit.undo`).
- `wb.temp` is Kelvin on raws with colour matrices, relative (6500 = as shot) elsewhere.
- `export`/`render_photo`/`screenshot` with a path can overwrite files; `set_develop`/`crop`/`export` with an `id` replace the selection.
- `export` with `addToPhotos: true` triggers a macOS Photos permission prompt (may sync to iCloud).
