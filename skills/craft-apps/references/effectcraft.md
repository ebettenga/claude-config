## EffectCraft (After Effects-style compositor) — agent cheat sheet

**1. CLI + MCP on macOS.** The `.app` holds only the desktop app. Get the CLI from the separate release asset
`effectcraft-cli-<version>-macos-<arch>.zip` (latest: `effectcraft-cli-0.18.0-macos-universal.zip`, `gh release download -R storytold/effectcraft -p 'effectcraft-cli-*-macos-universal.zip'`), unzip, put `effectcraft-cli` on PATH.
- Headless: `claude mcp add effectcraft -- effectcraft-cli mcp` (add `--demo`, `--project file.ecproj`, `--autosave`, `--gpu` as needed)
- Bridge:   `claude mcp add effectcraft-app -- effectcraft-cli mcp --bridge 9877`
- .mcp.json: `{"mcpServers":{"effectcraft":{"command":"/abs/effectcraft-cli","args":["mcp","--autosave"]},"effectcraft-app":{"command":"/abs/effectcraft-cli","args":["mcp","--bridge","9877"]}}}`
- Optional confinement: `--automation-read-root DIR` / `--automation-write-root DIR` (repeatable; file params must be absolute paths inside roots; scripts and `ui_*` tools refused while confined).

**2. Desktop app with control channel (bridge).** Flag is `--control <port>` (or env `EFFECTCRAFT_CONTROL_PORT=9877`; flag wins). No token.
`/Applications/EffectCraft.app/Contents/MacOS/EffectCraft --control 9877 &`  (add `--demo` for the demo project; otherwise empty project).
TCP 127.0.0.1 only, JSON-lines, no auth — only enable while in use. App starts without stealing focus; avoid `ui.focus`.

**3. Workflow.** Orient → discover → describe → execute → verify.
`get_state` → `get_project` → `get_comp {}` → `list_commands {"filter":"mask"}` → `describe_command {"command":"mask.new"}` → `execute_command`/`batch` → `render_frame {"time":1,"max_side":640}` (bridge: `screenshot {"panel":"Timeline"}`) → `save_project {"path":...}`.
Key tools:
- `list_commands` / `command_list` — command ids, params docs (`schemas` for JSON Schema), enabled now
- `describe_command` — one command in full incl. schema and `why` disabled
- `execute_command` / `command_run` — run any engine command (undoable)
- `batch {steps:[{command,params}]}` — one undo step, atomic rollback, `"$1.layer"` result refs; `command_batch {steps:[{id,params}], stop_on_error?}` — per-step undo, per-step results
- `get_layer {layer, flat:true}` / `get_property` / `set_property` / `add_keyframe` — property tree (paths), read/write, keys
- `list_effects` / `add_effect {layer,effect,values}` — effects in one undo step; `list_fonts`
- `run_script {code}` — AE-style JS (`app.run(id, params)` calls any command)
- `render_frame` / `render_preview` — PNG of a frame (`transparent:true` keeps alpha)
- `undo` / `redo` / `history {goto?}`; `doc_inspect`; resources `effectcraft://document`, `effectcraft://commands`
- Bridge only: `screenshot`, `ui_inspect`, `ui_elements {prefix?}`, `ui_click`, `ui_drag`, `ui_key`, `ui_type`, `ui_set`, `control {method, params}`
Refs: layers by id, `"#n"` (1-based from top) or name; comps by id/name (default active); paths like `transform/position`, `effects/#1/blurriness`, `@uid`. Name layers at creation (`name`).
CLI one-liners (headless; opens demo unless `--project`/`*.ecproj`/`--empty`; `--json` for JSON):
- `effectcraft-cli commands --filter keys` ; `effectcraft-cli exec --list --schemas --json`
- `effectcraft-cli exec comp.new --params '{"name":"Main","width":1280,"height":720}' --empty --save-as main.ecproj`
- `effectcraft-cli exec layer.newSolid '{"color":"#3366ff"}' main.ecproj --save`
- `effectcraft-cli props Main '#1' --project main.ecproj` ; `effectcraft-cli get Main '#1' transform/position --time 0.5 main.ecproj --json`
- `effectcraft-cli set Main '#1' transform/position '[100,360]' --time 0 main.ecproj --save`
- `effectcraft-cli run main.ecproj comp.open '{"comp":"Main"}' time.set '{"time":1}' --json`
- `effectcraft-cli render-frame main.ecproj --time 1 --max-side 640 --out f.png --json`
- `effectcraft-cli render main.ecproj --comp Main --out main.mov --format prores --progress`
- `effectcraft-cli exec layer.newNull --bridge 9877` (against live app); `effectcraft-cli script build.jsx --save-as main.ecproj`

**4. Gotchas.**
- Headless work is in memory only unless started with `mcp --autosave` (checkpoint before each edit reply) — otherwise `save_project {path}` after each milestone. Bridge: the desktop app owns its auto-saves. `open_project`/`file.newProject` on a dirty project discards it; save first. `get_state.dirty` tracks unsaved.
- Bridge unknown outcome: after a broken connection only read-only queries are retried; engine commands/UI edits whose send/reply failed may already be applied — inspect before retrying. Timeouts never auto-resent. Control requests time out at 60 s.
- Time units: seconds. `set_property`/`add_keyframe` (and `prop.set`, `prop.addKey`, `keys.set`, `keys.select`) default to **layer** time; `get_property`/`render_frame` use **comp** time. Pass `timeBase:"comp"` on offset/stretched layers. Write times snap to nearest comp frame. `layer.timing {layer,start}` is comp seconds.
- Strict params: unknown tool args → JSON-RPC `-32602`; unknown command params → error listing accepted keys. A missing layer reference is an error, never a no-op.
- `isError:true` whenever a batch/render has `failed > 0` even if other steps succeeded — read `results`/`items`.
- Undo: each `command_batch` edit is its own step; `batch` and `add_effect` are one step. `run_script` that throws keeps edits — wrap in `app.beginUndoGroup()`/`app.endUndoGroup()`. No-op edits record no undo step. Undo levels default 32.
- Renders: `renderQueue.add {...}` then `renderQueue.render {"wait":true}`; only one render at a time (second is refused); edits during a render don't affect it. Cancel via `notifications/cancelled` (headless blocking only) or `renderQueue.stop` for `wait:false`.
- Background jobs (`track.analyze`, `warp.analyze`, `roto.propagate`, `footage.check`…) need `"wait": true` headless.
- Locked layers are skipped/fail; unlock with `layer.setSwitch`/`layer.unlockAll`. Effect points/picks are in effect space (layer pixels), not comp space.
- `engine.execute` never opens dialogs; `ui.menu.invoke` may (and may show Save/Don't Save prompts: `dialog.unsaved.*`). `app.quit {"force":true}` skips the prompt.
