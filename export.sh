#!/usr/bin/env bash
# Copy this computer's Claude Code setup back into the repo, then review the
# diff and commit. Machine-specific paths are written as ~ and {{REPO}}.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="$HOME/.claude"

python3 - "$REPO" "$CLAUDE/settings.json" <<'PY'
import json, os, sys
repo, source = sys.argv[1], sys.argv[2]
s = json.load(open(source))
# Only the portable parts; anything else (env, permissions, hooks) stays local.
keep = ['enabledPlugins', 'extraKnownMarketplaces', 'pluginConfigs',
        'inputNeededNotifEnabled', 'agentPushNotifEnabled', 'outputStyle', 'statusLine']
out = {k: s[k] for k in keep if k in s}
home = os.path.expanduser('~')
for m in out.get('extraKnownMarketplaces', {}).values():
    src = m.get('source', {})
    if 'path' in src:
        src['path'] = '{{REPO}}' if src['path'] == repo else src['path'].replace(home, '~', 1)
dest = os.path.join(repo, 'settings/settings.json')
json.dump(out, open(dest, 'w'), indent=2)
open(dest, 'a').write('\n')
PY
echo "✓ settings exported"

for dir in "$CLAUDE"/skills/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  [ -L "${dir%/}" ] && continue   # already linked from this repo
  rm -rf "$REPO/skills/$name" && cp -R "${dir%/}" "$REPO/skills/$name"
  echo "✓ skill $name"
done

git -C "$REPO" status --short
