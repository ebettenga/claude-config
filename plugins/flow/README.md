# flow

An orchestrated delivery flow for Claude Code. The session model plans the work, owns design, hands each piece to a tiered worker agent, and adversarially reviews what comes back. A progress bar shows the plan, which tasks are running, and how many are accepted.

Install it in Claude Code:

```text
/plugin install flow --marketplace ebettenga/claude-config
```

The plugin ships:

- the `flow` skill (the orchestrator), which Claude can also start by itself for substantial multi-step implementation work, after saying so in one line;
- five worker agents, `flow-fable` to `flow-light` (listed by the Agent tool as `flow:flow-<tier>`);
- flow's progress bar (`mcp__flow__progress` for the orchestrator, `mcp__flow__step` for workers).

## Tiers

| Tier | Agent | Model / effort | Use for |
|------|-------|----------------|---------|
| Fable | `flow-fable` | Fable / high | Hardest problems: very complex logic, hard bugs; targeted design features on request |
| Heavy | `flow-heavy` | Opus / xhigh | Unfamiliar or messy code, unclear root cause, non-obvious architecture |
| Careful | `flow-careful` | Opus / high | Clear approach, delicate execution: multi-file refactors, invariant-preserving fixes |
| Medium | `flow-medium` | Opus / medium | Standard features, bug fixes with a known cause, a few files |
| Light | `flow-light` | Opus / low | Mechanical edits, renames, boilerplate, config, running builds/tests |

## Commands

- `/flow:flow <task>`: run the orchestrator on a task.
- `/flow-agents`: show or hide the Agents tab of the flow chart (the bar's `×N` button does the same).
- `/flow-chart`: the hub: Workflows, Runs, Agents (every subagent of the session, running, finished and planned) and Skills.

## Workflows

`/flow-chart` lists and runs workflows defined in `flow.yaml` files. See the flows repo README for the format.

## Credits

Forked from savvy-flow and savvy-progress in johnnyvizz/claude-kit (MIT). See `LICENSE`.
