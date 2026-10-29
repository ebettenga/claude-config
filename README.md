# claude-config

My Claude Code setup: settings, skills, plugin marketplaces, and my own plugins. Clone it on any computer and run one script.

## Set up a new computer

```bash
git clone https://github.com/ebettenga/claude-config.git ~/Documents/claude-config
~/Documents/claude-config/install.sh
```

Then start a new Claude Code session, or run `/reload-plugins`.

`install.sh` is safe to run again. It:

1. Clones the sources some marketplaces read from (Anthropic's `claude-code-playground` mods).
2. Merges `settings/settings.json` into `~/.claude/settings.json`. The repo wins on plugins, marketplaces and plugin options; every other setting on that computer stays. The old file is backed up in `~/.claude/backups/`.
3. Links each folder in `skills/` into `~/.claude/skills/`, so a `git pull` updates them.
4. Adds every marketplace and installs every plugin the settings list, disabling the ones marked off.

## Profiles: `claude-as`

Each profile is a separate Claude Code setup with its own accounts, so work for one person or client never mixes with another. A profile has its own Claude config folder (settings, plugins, MCP sign-ins, memory, history) and points GitHub, git, Google, gcloud, Railway and AWS at that profile's accounts.

`claude-as --help` lists every command. The main ones:

**Profiles**

| Command | Does |
|---|---|
| `claude-as list` | List profiles and whether each is set up |
| `claude-as add acme [--from other] [KEY=value ...]` | Create a profile from the template or another profile |
| `claude-as edit acme [KEY=value ...]` | Show or change its accounts (`claude-as fields` lists them) |
| `claude-as rename acme acme-co` / `claude-as remove acme` | Rename, or remove (kept in `~/.claude-profiles/.removed/`) |

**Using one**

| Command | Does |
|---|---|
| `claude-as acme` | Start Claude as `acme` (extra arguments go to `claude`) |
| `claude-as acme open [folder]` | Open a new terminal window running Claude as `acme` (Ghostty, iTerm or Terminal) |
| `claude-as acme status` | Show who each tool is signed in as |
| `claude-as acme shell` / `exec <cmd>` | A shell, or one command, with that profile's accounts |
| `claude-as acme setup` | First-time setup: installs plugins into the profile, copies its Google account, offers to store a Railway token |

**Its setup**

| Command | Does |
|---|---|
| `claude-as acme list [plugins\|mcp\|skills\|settings\|...]` | Everything the profile has, or one part |
| `claude-as acme add plugin\|marketplace\|mcp\|skill ...` | Add one (`add mcp <name> '<json>'` for MCP servers) |
| `claude-as acme remove plugin\|marketplace\|mcp\|skill\|setting ...` | Remove one |
| `claude-as acme enable\|disable plugin <plugin>` | Turn a plugin on or off |
| `claude-as acme edit setting <key> <value>` / `edit mcp <name> '<json>'` | Change a setting or an MCP server |
| `claude-as acme copy other [plugins\|mcp\|skills\|settings\|all]` | Copy setup from one profile to another |
| `claude-as acme export ~/clients/acme-setup --title "Acme"` | Package the setup for someone else (below) |

### Handing a setup to a client

`claude-as <profile> export <folder>` writes a git repo with that profile's plugins (your own ones copied in), marketplaces, MCP servers, skills and settings, plus `install.sh` and `claude-as`. It has no accounts or profiles. MCP `env` and header values become `${VAR}` placeholders, and its README lists them. The client runs `./install.sh` with those variables set, and gets the same setup.

A profile is `profiles/<name>.env`: account names only, never secrets. Profiles are git-ignored, since they name real accounts: each computer keeps its own, made with `claude-as new <name>` from `profiles/_template.env`. A profile's data (Claude config, sign-ins, history) lives in `~/.claude-profiles/<name>/`, outside the repo.

Inside Claude, the `claude-as` skill does the same: type `/claude-as acme`, or ask "open the acme profile" or "list Railway projects as acme", and Claude opens the window or runs the command. It asks before changing anything as another profile, and never reads tokens or signs in for you.

| Tool | How a profile picks the account |
|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` → `~/.claude-profiles/<name>/claude`. Sign in to Claude once per profile. |
| GitHub (`gh`, API) | `GH_TOKEN` read from gh's own keyring for `GH_USER` (`gh auth login` once per user) |
| git commits and pushes | Author name and email; `GIT_SSH_COMMAND` with the profile's `SSH_KEY` |
| Google Drive/Docs/Sheets/Calendar MCP | A token file holding only the profile's `GOOGLE_ACCOUNT`, copied from `~/.config/google-drive-mcp/tokens.json` |
| gcloud | `CLOUDSDK_CONFIG`: the folder the profile names, or its own |
| Railway | `RAILWAY=login` uses this computer's `railway login`; `RAILWAY=token` reads an account token from Keychain (`claude-as.railway`, account = profile). With no token, Railway commands fail instead of acting as the login. |
| AWS | `AWS_PROFILE` |
| Shopify and other HTTP MCP servers | Their sign-ins belong to the Claude config folder, so each profile signs in once |

Install the command on a new computer:

```bash
ln -sfn ~/Documents/claude-config/bin/claude-as ~/.local/bin/claude-as
```

## Save changes from this computer

```bash
~/Documents/claude-config/export.sh
```

It copies the portable parts of `~/.claude/settings.json` (plugins, marketplaces, plugin options, notifications, output style, status line) and any skills not already linked from here, then shows `git status`. Review the diff and commit. Permissions, hooks and `env` are left out on purpose: they tend to be machine-specific or hold secrets.

## flow

`plugins/flow/` is how big tasks get done. `/flow:flow <task>` starts an orchestrator that plans, owns the design, hands the work to tiered workers (`flow-fable`, `flow-heavy`, `flow-careful`, `flow-medium`, `flow-light`) and reviews what they send back. You rarely need to type it: flow starts itself for substantial multi-file work. `/flow-agents` opens a progress bar for the running workers.

It also runs workflows: YAML files (`flow.yaml`) that mix scripts and Claude steps, seen and run from `/flow-chart`. They live in `~/Documents/flows`, the private repo [ebettenga/flows](https://github.com/ebettenga/flows), which `install.sh` clones there (the plugin's `workflowsDir` option can point elsewhere); a project's own `.flows/` folder is read too.

Agent steps in a workflow run a headless Claude (`claude -p --restricted`) with only the tools, folders and budget the step lists, so they work in auto mode without asking. That `claude` needs its own sign-in once per machine: `claude auth login`.

## Layout

| Path | What |
|---|---|
| `.claude-plugin/marketplace.json` | The `ethan-claude` marketplace: my own plugins |
| `plugins/filedeck/` | Filedeck, a file pane with what Claude touched, a badge-styled tree with inline diffs, and a git panel to stage, commit and push |
| `plugins/flow/` | flow, the orchestrator with tiered workers, YAML workflows and `/flow-chart` |
| `settings/settings.json` | Portable settings; `{{REPO}}` stands for this folder's path |
| `settings/mcp.json` | Optional: MCP servers for every project, `${VAR}` for secrets (an export writes one) |
| `skills/` | User-level skills, `claude-as` among them |
| `profiles/` | `_template.env`; your own profiles sit beside it, git-ignored |
| `bin/claude-as` | The profile launcher |
| `bin/claude-as-config` | Profile management behind `claude-as list/add/edit/...` |

## Working on my plugins

The `ethan-claude` marketplace is this folder, so installed plugins run straight from `plugins/`. Edit a file, run `/reload-plugins`, and the change is live. Check a plugin with:

```bash
claude plugin validate plugins/filedeck
```

```bash
claude plugin test plugins/filedeck
```

/filedeck opens the pane.

## Never commit

API keys, tokens or passwords. Anything secret goes in that computer's own `~/.claude/settings.json` (`env`) or the system keychain, never here.
