---
name: flow-author
description: Write, change or harden a flow workflow (a flow.yaml in the flows folder). Use when the user wants to create or edit a workflow, make one deterministic or cheaper ("harden it", "take the AI out of it"), or asks for something repeatable, scheduled, or a report they will run again.
---

# Writing flow workflows

A workflow is designed once by you and then runs the same way every time, with AI only in the steps that need judgment. Keep that split in mind with every step you write.

## Where they live

- The flows folder is the plugin's `workflowsDir` option, `~/Documents/flows` by default; a project can also have its own in `.flows/`.
- One folder per workflow, named after its id: `flow.yaml`, plus `scripts/` for helper scripts and a short `README.md`.
- A **view** (`view.yaml`) is a search, list and detail page over MCP calls, drawn on the hub's Views tab. Make one when the person wants to look things up rather than run a report; the README's Views section is its format.
- The format reference is the flows folder's `README.md`. Read it before writing or changing a workflow, and copy the closest example.
- `flows.yaml` can list `sources:`: a team's git repo of workflows, cloned under `~/.flow/sources` or at its `path`. A workflow for a team goes in that team's source, by MR, not in the personal flows folder; `pull_sources` fetches the latest.
- `flows.yaml` at the flows folder's root groups and orders the workflows on the hub's Workflows page (`groups: [{title, workflows: [ids]}]`; unlisted ones go under Other). When you add a workflow, offer to put it in a group there.
- The flows folder is a git repo. Commit only when the user asks.

## Fixed first

Choose the first kind in this list that can do the step:

1. `python`: computing, reshaping, parsing, formatting. Put anything over about 10 lines in `scripts/` and call it with `python: { file: scripts/x.py, args: [...] }`. Each arg is one argv entry, with no shell. A script reads earlier steps with `from flow import flow` (`flow.inputs`, `flow.steps["id"].json`, `flow.set_output(...)`).
2. `mcp`: a connected service (Shopify, Drive, Railway...). The servers and tools are the ones in this session's MCP tools: `mcp__<server>__<tool>` is `server: <server>, tool: <tool>`, with `args` taken from the tool's schema.
3. `http`: a plain web API.
4. `run`: shell commands. Quote typed values with `{{inputs.x | sh}}`, never `"{{inputs.x}}"`.
5. `wait`, `uses`: waiting for a file, URL or time; running another workflow.
6. `agent`: only for judgment that needs to look around files, such as auditing or summarising a repo. It is a headless Claude with only `tools` (default Read, Grep, Glob, Write; never Bash), the `read:` and `write:` folders (plus the run folder) and a `budget` in dollars: give it the least it needs. Pick the lowest tier that can do it. When the text it needs can be named up front, a `model` step is cheaper.
7. `claude`: only when the step needs the user's own session, tools or approval.

Put an `approve` step before anything that sends, publishes, pays, or changes something outside the run folder.

Secrets: list the variable names under `env:` and use `{{env.NAME}}` in python args, mcp args or http url, headers and body (`$NAME` in run steps). Never write a value into a file. Pass results between steps with `{{steps.<id>.json.<path>}}` and `if: steps.<id>.json.count > 0`, so later steps do not have to parse text.

## Steps

1. Agree with the user on the inputs, the steps, and what the run leaves in its folder (`outputs:`).
2. Write `flow.yaml`, the scripts and the `README.md`.
3. Call `mcp__flow__validate_workflow` with the folder, and fix problems until it says `valid`.
4. If the user agrees, do a dry run with `mcp__flow__run_workflow` on sample inputs, follow it with `mcp__flow__run_status`, and read failing steps with `mcp__flow__step_log`.
5. Tell the user it is in `/workflow`, and say how many of its steps are AI and how many are fixed.

## Hardening ("make it deterministic")

1. Pick a successful run of the workflow (`mcp__flow__run_status`; ask the user for the run id if needed).
2. Read each agent and claude step with `mcp__flow__step_log`: its prompt, what its agent did, and its answer.
3. Where the work was mechanical (fetching, reshaping, computing, formatting), write a script in `scripts/` (or an mcp or http step) that does exactly that. Replace the AI step with a `python: { file, args }` step that keeps the same id and the same `outputs:`, so later steps still work.
4. Validate, re-run on the same inputs, and compare the new outputs with the old run's: the files in both run folders and the step outputs.
5. Show the user the diff of `flow.yaml` and the new scripts before keeping them.
6. Leave steps that need judgment as agent steps, and tell the user which ones you kept and why.
