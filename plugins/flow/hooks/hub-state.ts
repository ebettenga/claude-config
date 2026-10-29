// The /flow-chart hub pane's state, and what the runner calls on it (at
// session start, when a run starts, on the 250 ms tick). Nothing here imports
// the runner, so the runner can import this.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Found, HubEnv, HubPicker, HubTab, Run } from '../types'

type $ = EngineInterface

// The scan reads an atom only where a const of the same file makes it, so
// hub.tsx makes these too (same keys and shape tags).
export const PANE = 'flow-chart'
export const TITLE = 'Flow chart'
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const hubTab = atom({ plugin: 'flow', key: 'hubTab' } as const, 'workflows' as HubTab, { shape: 'hub-tab-1' })
const hubWorkflow = atom({ plugin: 'flow', key: 'hubWorkflow' } as const, '', { shape: 'hub-workflow-1' })
const hubRun = atom({ plugin: 'flow', key: 'hubRun' } as const, '', { shape: 'hub-run-1' })
const hubPicker = atom({ plugin: 'flow', key: 'hubPicker' } as const, null as HubPicker | null, { shape: 'hub-picker-1' })
const hubLogStep = atom({ plugin: 'flow', key: 'hubLogStep' } as const, '', { shape: 'hub-log-1' })
const hubFrame = atom({ plugin: 'flow', key: 'hubFrame' } as const, 0, { shape: 'hub-frame-1' })
const hubEnv = atom({ plugin: 'flow', key: 'hubEnv' } as const, {} as HubEnv, { shape: 'hub-env-1' })

export async function openHub($: $): Promise<void> {
  await $.ui.open({ id: PANE, title: TITLE })
}

async function isEnvSet($: $, name: string): Promise<boolean> {
  try {
    const { exitCode } = await $.process.run(['bash', '-c', '[ -n "${!1+x}" ]', '_', name])
    return exitCode === 0
  } catch {
    return false
  }
}

/** Whether each env name the workflows need is set: once per refresh, not per draw. */
export async function checkEnv($: $, found: Found[]): Promise<void> {
  const names = [...new Set(found.flatMap(f => f.workflow?.env ?? []))].filter(n => ENV_NAME_RE.test(n))
  const out: HubEnv = {}
  for (const name of names) out[name] = await isEnvSet($, name)
  await update($, hubEnv, () => out)
}

/** The hub on its Agents tab: opened, or brought forward. */
export async function showAgents($: $): Promise<void> {
  await update($, hubTab, () => 'agents')
  await openHub($)
}

/** The bar's agents button and /flow-agents: closes the hub when it is up on Agents, else shows Agents. */
export async function toggleAgents($: $): Promise<boolean> {
  const isUp = await $.ui.panes().then(panes => panes.some(p => p.id === PANE)).catch(() => false)
  if (isUp && (await read($, hubTab)) === 'agents') {
    await $.ui.close({ id: PANE })
    return false
  }
  await showAgents($)
  return true
}

/** Workers started: the hub opens on Agents, but an open hub keeps the tab it is on. */
export async function autoShowAgents($: $): Promise<void> {
  const isUp = await $.ui.panes().then(panes => panes.some(p => p.id === PANE)).catch(() => false)
  if (!isUp) await showAgents($)
}

export async function showRun($: $, runId: string): Promise<void> {
  await update($, hubLogStep, () => '')
  await update($, hubRun, () => runId)
  await update($, hubTab, () => 'runs')
}

export async function showWorkflow($: $, workflowId: string): Promise<void> {
  await update($, hubPicker, () => null)
  await update($, hubWorkflow, () => workflowId)
  await update($, hubTab, () => 'workflows')
}

/** From the runner's session.start, once the workflows and runs are read. */
export async function hubSessionStart($: $, found: Found[]): Promise<void> {
  await $.command.register({
    name: 'flow-chart',
    description: 'Open the flow chart: your workflows, their runs, and the skills and agents Claude can use',
    argumentHint: '[workflow id]',
  })
  await checkEnv($, found).catch(() => undefined)
}

/** A run started (from the hub or Claude's run_workflow): the pane, when not open, opens on it. */
export async function hubRunStarted($: $, runId: string): Promise<void> {
  const isUp = await $.ui.panes().then(panes => panes.some(p => p.id === PANE)).catch(() => false)
  if (isUp) return
  await showRun($, runId)
  await openHub($)
}

/** Every 250 ms: the shimmer moves only while a run is running. */
export async function hubTick($: $, runs: Run[]): Promise<void> {
  if (runs.some(r => r.status === 'running')) await update($, hubFrame, n => (n + 1) % 1200)
}
