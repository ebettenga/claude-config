---
name: claude-as
description: Open, check or act as one of the user's claude-as profiles (separate Claude Code setups with their own GitHub, git, Google, gcloud, Railway and AWS accounts, such as a personal profile and one per company or client). Use when the user asks to switch to, open, start or work as a profile, client or account ("open the acme profile", "start a personal session", "switch to work"), asks which account a tool is using, wants one command run as another profile ("push this as acme", "list Railway projects as personal"), or wants a new profile.
argument-hint: "[profile] [open|status|exec <command>|new]"
---

# claude-as profiles

`claude-as` is on PATH (`~/.local/bin/claude-as`, from the `claude-config` repo). Each profile is `profiles/<name>.env` in that repo and has its own Claude config folder under `~/.claude-profiles/<name>/`.

## Arguments

`$ARGUMENTS` is what the user typed after `/claude-as`. Read it as:

| Typed | Do |
|---|---|
| nothing | List profiles (below) and ask which to open |
| `<profile>` | Open that profile (below) |
| `<profile> status` | Show who each tool is signed in as |
| `<profile> exec <command>` | Run that command as the profile |
| `new <name>` | Create a profile |

Unless told otherwise, it's run in the current session's working directory.

## List profiles

```bash
claude-as
```

## Open a profile

Opens a new terminal window in the current folder, running Claude as that profile. That window is a separate session with its own accounts, history and memory; this session keeps its own accounts.

```bash
claude-as <profile> open "$PWD"
```

Pass another folder instead of `$PWD` if the user names one. Then tell the user the window is open and that its first start asks them to sign in to Claude and trust the folder, which they do themselves.

Opening a window is harmless and needs no confirmation.

## Check who a profile is

```bash
claude-as <profile> status
```

Report the table it prints. Use it before acting as a profile when it's unclear which account a tool will use.

## Run one command as a profile

```bash
claude-as <profile> exec <command> [args...]
```

The command runs with that profile's GitHub token, git identity and SSH key, Google token file, gcloud config, Railway token and AWS profile. Reading is fine without asking. Anything that changes something in that profile's accounts (git push, deploys, Railway or gcloud changes, creating repos or issues) is acting as that person: say which profile and account it will run as and get a yes first, as for any outward-facing action.

Commands run directly, not through a shell; for pipes or `&&`, use:

```bash
claude-as <profile> exec /bin/zsh -c '<command line>'
```

## Create a profile

```bash
claude-as new <name>
```

Then fill in `~/Documents/claude-config/profiles/<name>.env` with the user: the gh user (`gh auth status` lists the signed-in ones), SSH key (`ssh -T -i <key> git@github.com` shows its GitHub user), git name and email, Google account alias, gcloud folder, Railway mode, AWS profile. Account names only. After that the user runs `claude-as <name> setup` in their own terminal, since it may ask for a Railway token.

## Never

- Read, print or copy tokens or other secrets: not `gh auth token`, not `security find-generic-password -w`, not the token files under `~/.claude-profiles/` or `~/.config/google-drive-mcp/`.
- Sign in, or type a password or token, for the user. Sign-ins (`gh auth login`, `gcloud auth login`, `railway login`, Claude's own) are theirs to run.
- Commit a profile's data folder or anything secret to `claude-config`.
