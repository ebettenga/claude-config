---
name: claude-as
description: Manage and use the user's claude-as profiles: separate Claude Code setups, each with its own accounts (GitHub, git, Google, gcloud, Railway, AWS) and its own plugins, MCP servers, skills and settings, such as a personal profile and one per company or client. Use when the user asks to list, add, edit, rename or remove a profile; to open, start, switch to or work as one ("open the acme profile", "start a personal session"); to see or change what a profile has installed ("add the Sentry MCP to acme", "what plugins does personal have", "turn off filetree for work"); to copy setup between profiles; to package a profile's setup for a client; to check which account a tool uses; or to run one command as another profile ("push this as acme").
argument-hint: "[list | add <name> | edit <name> | <profile> [list|add|edit|remove|open|status|copy|export] ...]"
---

# claude-as profiles

`claude-as` is on PATH (`~/.local/bin/claude-as`, from the `claude-config` repo at `~/Documents/claude-config`). Everything goes through it; don't edit the files it manages by hand.

- A profile's **accounts** are `profiles/<name>.env` in that repo: account names only, git-ignored.
- A profile's **setup** (plugins, marketplaces, MCP servers, skills, settings) lives in its Claude folder, `~/.claude-profiles/<name>/claude`. `claude-as` changes it through the `claude` CLI.

`claude-as --help` prints every command. `claude-as fields` lists the account fields.

## Reading `/claude-as` arguments

`$ARGUMENTS` is what the user typed after `/claude-as`, a `claude-as` command line. If it's empty, run `claude-as list` and ask what they want. A first word that's a profile name, followed by nothing, means open it (below). Anything else, run as given:

```bash
claude-as $ARGUMENTS
```

When the user asks in words instead, pick the command from the tables below.

## Profiles

| Want | Command |
|---|---|
| See all profiles | `claude-as list` |
| Create one | `claude-as add <name> [--from <profile>] [KEY=value ...]` |
| See or change its accounts | `claude-as edit <name>` / `claude-as edit <name> KEY=value ...` |
| Rename | `claude-as rename <old> <new>` |
| Remove | `claude-as remove <name>` (moves it to `~/.claude-profiles/.removed/`) |

Account fields: `PROFILE_DESC`, `GH_USER`, `SSH_KEY`, `GIT_NAME`, `GIT_EMAIL`, `GOOGLE_ACCOUNT`, `GCLOUD_CONFIG_DIR`, `RAILWAY` (`login` or `token`), `AWS_PROFILE`. To find values:

- `gh auth status` lists the signed-in GitHub users.
- `ssh -T -i <key> -o IdentitiesOnly=yes git@github.com` says which GitHub user a key belongs to.
- `gcloud config configurations list` shows gcloud accounts.

After creating a profile, the user runs `claude-as <name> setup` in their own terminal: it installs the plugins and settings and may ask for a Railway token.

## A profile's setup

| Want | Command |
|---|---|
| See everything | `claude-as <p> list` |
| See one part | `claude-as <p> list accounts\|plugins\|marketplaces\|mcp\|skills\|settings` |
| Add a plugin | `claude-as <p> add plugin <plugin@marketplace>` |
| Add a marketplace | `claude-as <p> add marketplace <owner/repo or path>` |
| Add an MCP server, every project | `claude-as <p> add mcp <name> '<json>'` or `claude-as <p> add mcp <name> [--transport http] <command or url> [args...]` |
| Add a skill | `claude-as <p> add skill <name in the repo's skills/ or a folder path>` |
| Turn a plugin on or off | `claude-as <p> enable\|disable plugin <plugin@marketplace>` |
| Change a setting | `claude-as <p> edit setting <key, dots for nesting> <JSON or text>` |
| Replace an MCP server | `claude-as <p> edit mcp <name> '<json>'` |
| Remove something | `claude-as <p> remove plugin\|marketplace\|mcp\|skill\|setting <what>` |
| Copy setup to another profile | `claude-as <p> copy <other> [plugins\|mcp\|skills\|settings\|all]` |

MCP JSON is Claude Code's own shape: `{"type":"stdio","command":"npx","args":["-y","pkg"],"env":{...}}` or `{"type":"http","url":"https://..."}`. A secret an MCP server needs (an API key, a token) never goes in the command line or the JSON: the user puts it in their environment, and the JSON names it as `"${VAR_NAME}"`.

Changes take effect in that profile's next session, or after `/reload-plugins` in an open one. Say so after a change.

Run `claude-as <p> list <part>` before and after a change, so you can show the user what changed.

## Handing a setup to a client

```bash
claude-as <p> export <folder> [--title "Client name"]
```

This writes a git repo of that profile's setup: its plugins (the user's own plugins copied in), marketplaces, MCP servers, skills and settings, plus `install.sh` and `claude-as`. It has no accounts and no profile files, and every MCP `env` or header value is replaced with a `${VAR}` placeholder. Its README says what's included and which variables to set.

After exporting:

1. Check the folder with the user. `settings/mcp.json` and the README's placeholder list are the parts to read.
2. Committing it locally is fine; it starts as a fresh git repo.
3. Pushing it anywhere, or sending it to the client, is sharing it: ask first.

## Using a profile

| Want | Command |
|---|---|
| Open a new terminal window running Claude as the profile | `claude-as <p> open "$PWD"` (or another folder) |
| Who each tool is signed in as | `claude-as <p> status` |
| Run one command as the profile | `claude-as <p> exec <command> [args...]`; for pipes or `&&`: `claude-as <p> exec /bin/zsh -c '<line>'` |

- **Opening a window** is harmless. Tell the user the window is open, and that its first start asks them to sign in to Claude and trust the folder.
- **Reading as a profile** (status, listing projects, viewing) needs no confirmation.
- **Changing something in a profile's accounts** is acting as that person: a git push, a deploy, Railway or gcloud changes, creating repos or issues. First say which profile and account it will run as, and get a yes.
- **Changing a profile's setup** (plugins, MCP, skills, settings, accounts fields) only changes this computer, so do it when asked.

## Never

- Read, print or copy tokens or other secrets. That means not `gh auth token`, not `security find-generic-password -w`, and not the token files under `~/.claude-profiles/` or `~/.config/google-drive-mcp/`.
- Sign in, or type a password or token, for the user. Sign-ins (`gh auth login`, `gcloud auth login`, `railway login`, Claude's own) are theirs to run.
- Commit `profiles/<name>.env`, a profile's data folder, or anything secret to `claude-config`.
