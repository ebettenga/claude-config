# claude-config

My Claude Code setup: settings, skills, plugin marketplaces, and my own plugins. Clone it on any computer and run one script.

## Set up a new computer

```bash
git clone git@github.com:<owner>/claude-config.git ~/Documents/claude-config
~/Documents/claude-config/install.sh
```

Then start a new Claude Code session, or run `/reload-plugins`.

`install.sh` is safe to run again. It:

1. Clones the sources some marketplaces read from (Anthropic's `claude-code-playground` mods).
2. Merges `settings/settings.json` into `~/.claude/settings.json`. The repo wins on plugins, marketplaces and plugin options; every other setting on that computer stays. The old file is backed up in `~/.claude/backups/`.
3. Links each folder in `skills/` into `~/.claude/skills/`, so a `git pull` updates them.
4. Adds every marketplace and installs every plugin the settings list, disabling the ones marked off.

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
| `skills/` | User-level skills |

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
