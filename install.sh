#!/usr/bin/env bash
# Set up Claude Code on this computer from this repo: settings, skills,
# marketplaces and plugins. Safe to run again; it backs up what it replaces.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
# CLAUDE_CONFIG_DIR picks the folder to set up (claude-as sets it per profile).
CLAUDE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$CLAUDE/backups" "$CLAUDE/skills" "$HOME/.claude/mod-sources"

command -v claude >/dev/null || { echo "Install Claude Code first: https://code.claude.com"; exit 1; }

# 1. Sources some marketplaces are read from.
# Shared by every config folder: the settings name it under ~/.claude.
PLAYGROUND="$HOME/.claude/mod-sources/claude-code-playground"
if [ ! -d "$PLAYGROUND" ]; then
  git clone --depth 1 https://github.com/anthropics/claude-code-playground "$PLAYGROUND"
fi

# 2. Settings: merge the repo's into ~/.claude/settings.json. The repo wins on
#    plugins, marketplaces and plugin options; other keys on this machine stay.
[ -f "$CLAUDE/settings.json" ] && cp "$CLAUDE/settings.json" "$CLAUDE/backups/settings.json.$STAMP"
python3 - "$REPO" "$CLAUDE/settings.json" <<'PY'
import json, os, sys
repo, target = sys.argv[1], sys.argv[2]
text = open(os.path.join(repo, 'settings/settings.json')).read().replace('{{REPO}}', repo)
mine = json.loads(text)
for m in mine.get('extraKnownMarketplaces', {}).values():
    src = m.get('source', {})
    if 'path' in src:
        src['path'] = os.path.expanduser(src['path'])
current = json.load(open(target)) if os.path.exists(target) else {}
for key, value in mine.items():
    if isinstance(value, dict) and isinstance(current.get(key), dict):
        current[key] = {**current[key], **value}
    else:
        current[key] = value
json.dump(current, open(target, 'w'), indent=2)
open(target, 'a').write('\n')
PY
echo "✓ settings merged into $CLAUDE/settings.json"

# 3. Skills: link each one, so a git pull updates them.
for dir in "$REPO"/skills/*/; do
  name="$(basename "$dir")"
  dest="$CLAUDE/skills/$name"
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then mv "$dest" "$CLAUDE/backups/skill-$name.$STAMP"; fi
  ln -sfn "${dir%/}" "$dest"
done
echo "✓ skills linked"

# 4. Marketplaces and plugins, as the settings list them.
python3 - "$CLAUDE/settings.json" <<'PY' | while IFS=$'\t' read -r kind a b; do
import json, sys
s = json.load(open(sys.argv[1]))
for name, m in s.get('extraKnownMarketplaces', {}).items():
    src = m['source']
    print('market', src.get('repo') or src.get('path') or src.get('url'), name, sep='\t')
for plugin, on in s.get('enabledPlugins', {}).items():
    if not plugin.endswith('@builtin'):
        print('plugin', plugin, 'on' if on else 'off', sep='\t')
PY
  if [ "$kind" = market ]; then
    claude plugin marketplace add "$a" >/dev/null 2>&1 && echo "✓ marketplace $b" || echo "· marketplace $b already added"
  else
    claude plugin install "$a" >/dev/null 2>&1 && echo "✓ plugin $a" || echo "· plugin $a already installed (or failed)"
    [ "$b" = off ] && claude plugin disable "$a" >/dev/null 2>&1 || true
  fi
done

echo "Done. Start a new Claude Code session (or run /reload-plugins) to load everything."
