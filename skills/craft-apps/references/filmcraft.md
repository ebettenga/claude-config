## FilmCraft (Premiere-style NLE) — agent cheat sheet

**1. CLI + MCP on macOS.** The `.app` holds only the desktop app. Get the CLI from the separate release asset
`filmcraft-cli-<version>-macos-<arch>.zip` (latest: `filmcraft-cli-0.14.0-macos-universal.zip`, `gh release download -R storytold/filmcraft -p 'filmcraft-cli-*-macos-universal.zip'`), unzip, put `filmcraft-cli` on PATH.
- Headless: `claude mcp add filmcraft-headless -- filmcraft-cli mcp --demo` (or `--project p.fcproj`; neither = empty; also `--data-dir DIR`; any other option exits 2)
- Bridge:   `claude mcp add filmcraft -- filmcraft-cli mcp --bridge 127.0.0.1:9876`
- .mcp.json: `{"mcpServers":{"filmcraft":{"command":"/abs/filmcraft-cli","args":["mcp","--bridge","127.0.0.1:9876"]},"filmcraft-headless":{"command":"/abs/filmcraft-cli","args":["mcp","--demo"]}}}`
- No folder-confinement flags: the server reads/writes wherever the user can.

**2. Desktop app with control channel (bridge).** Flag is `--control <port>` (or env `FILMCRAFT_CONTROL_PORT`). **Requires** `FILMCRAFT_CONTROL_TOKEN` (64 hex chars); without it the listener stays closed. The bridge/CLI reads the same env var automatically, so start the app AND `claude` from the same shell:
```sh
export FILMCRAFT_CONTROL_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
/Applications/FilmCraft.app/Contents/MacOS/FilmCraft --control 9876 &
claude
```
Never put the token in CLI args, logs, checked-in MCP config or shared files; fresh token per session. Raw control requests need top-level `"token"` on every line. Loopback only. Optional `--control-input-only` for unattended runs (blocks native input). App opens without stealing focus; only `ui.focus {}` activates it.

**3. Workflow.** `doc_inspect` (or `project_inspect` + `sequence_inspect`) → get ids → `command_list {"filter":...}` → `command_run {id, params}` → `render_frame` or `ui_screenshot` → look → `edit.undo` if wrong.
Key tools:
- `command_list` — every command: id, label, menu, shortcut, params, enabled now (`filter`, `enabled_only`)
- `command_run {id, params}` — run any command (undoable); `command_batch {steps:[{id,params}], stop_on_error}` → `{completed, failed, results}`
- `doc_inspect` / `project_inspect` / `sequence_inspect` — bins/items ids; tracks, clips (times in ticks), effects, markers, playhead, selection
- `media_import {paths:[abs...], bin?, image_sequence?}` — import by absolute path
- `render_frame` / `render_preview` — PNG of program frame at `seconds` (read-only; bridge screenshots the Program monitor)
- Bridge only: `ui_inspect`, `ui_elements {prefix?}`, `ui_click`, `ui_drag`, `ui_key`, `ui_type`, `ui_screenshot {panel?}`, `ui_control` (any control method, e.g. `ui.set`, `ui.timeline.locate`)
- Resources `filmcraft://document`, `filmcraft://commands`
CLI one-liners (JSON output; exit 0 ok / 1 command failed / 2 usage):
- `filmcraft-cli commands razor` ; `filmcraft-cli describe timeline.razor` ; `filmcraft-cli --demo inspect sequence`
- `filmcraft-cli --project p.fcproj --save exec timeline.razor seconds=3.5`
- `filmcraft-cli --project p.fcproj exec effects.apply '{"effect":"Gaussian Blur"}'`
- `filmcraft-cli --project p.fcproj --save import a.mov b.wav`
- `filmcraft-cli --project p.fcproj export out.mp4` (waits); `... export out --preset "YouTube 1080p Full HD" --start 0 --end 10`; `filmcraft-cli export --list-presets prores`
- `echo '{"id":"file.newBin","params":{"name":"Selects"}}' | filmcraft-cli --project p.fcproj --save run -` (`run` stops at first failure unless `--keep-going`)
- `filmcraft-cli --bridge 127.0.0.1:9876 exec window.workspace.color` (live app)
`key=value` args parse as JSON when possible; dotted keys nest. `--save` writes back to `--project`; `--save-as path` elsewhere.

**4. Gotchas.**
- Saving: headless/CLI changes are lost unless `--save`/`--save-as` or `file.save {path?}` / `file.saveAs {path}`. Desktop auto-saves every 5 min to an `Auto-Save` folder plus a recovery journal; control `app.quit` quits WITHOUT the save prompt (changes stay in the recovery journal), while the command `app.quit` asks first.
- Time: ticks, 254 016 000 000 per second. Commands also accept `seconds`, `frame` or `timecode` — prefer those. Clips snap to the frame grid.
- Selection: selection-based commands are disabled ("no clips selected") unless params name targets (`clips`/`clip`, `items`/`item`); `command_list` still reports selection-based enablement.
- Tracks: `track`/`audioTrack` = id or `"V1"`/`"A2"`; a nonexistent track is an error. `timeline.move` drags linked audio along unless `"linked": false`.
- Strict args: unknown tool argument → `-32602` naming accepted ones; failing command → `isError` with engine message; panics → `internal error: …`, session survives.
- `effects.setParam` returning `"keyframes": 0` is success (static edit), not failure; choice names come back as numeric indices.
- Long exports: `file.exportMedia {..., "wait": true}` blocks (progress via `_meta.progressToken`, cancel via `notifications/cancelled` deletes partial output). Without `wait`, poll `jobs.list`, stop with `jobs.cancel`.
- Offline media renders a placeholder: `export`/`render` exit 1 after writing and list `offlineMedia`; check `media.status`/`media.findMissing` first, or `--allow-offline`.
- Bridge connections idle-time out after 2 min (bridge reconnects automatically); UI replies have a 60 s limit; `ui.screenshot` fails after 10 s if no frame presented (hidden window/asleep display). Element ids come from the previous frame (retried briefly after layout changes).
- Undo via `edit.undo` (command) or `ui_key Cmd+Z`.
