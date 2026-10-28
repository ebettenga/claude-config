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

```bash
claude-as
```

lists the profiles. Then:

| Command | Does |
|---|---|
| `claude-as acme` | Start Claude as the `acme` profile (extra arguments go to `claude`) |
| `claude-as acme open [folder]` | Open a new terminal window running Claude as `acme` (Ghostty, iTerm or Terminal) |
| `claude-as acme status` | Show who each tool is signed in as |
| `claude-as acme shell` | A shell with that profile's accounts, for running `gh`, `railway`, `gcloud` yourself |
| `claude-as acme exec <cmd>` | Run one command as that profile |
| `claude-as acme setup` | First-time setup: installs plugins into the profile, copies its Google account, offers to store a Railway token |
| `claude-as new acme` | Create `profiles/acme.env` from the template |

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

## Layout

| Path | What |
|---|---|
| `.claude-plugin/marketplace.json` | The `ethan-claude` marketplace: my own plugins |
| `plugins/filedeck/` | Filedeck, a file pane with what Claude touched, a badge-styled tree with inline diffs, and a git panel to stage, commit and push |
| `settings/settings.json` | Portable settings; `{{REPO}}` stands for this folder's path |
| `skills/` | User-level skills, `claude-as` among them |
| `profiles/` | `_template.env`; your own profiles sit beside it, git-ignored |
| `bin/claude-as` | The profile launcher |

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
