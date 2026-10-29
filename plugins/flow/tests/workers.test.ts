import { expect, test } from 'claude-code/testing'

import { isOwnWorkerSpawn } from '../hooks/runner'

// The allowWorkers approval says yes only to flow's own worker spawns.

test('only flow-raised spawns of flow workers the runner expects are its own', () => {
  // No spawn is expected outside a run, so nothing is approved.
  expect(isOwnWorkerSpawn('flow', { subagent_type: 'flow:flow-light', description: 'CSV summary: Write insights' })).toBe(false)
  // Raised by another plugin, or by the model: never flow's.
  expect(isOwnWorkerSpawn('engine', { subagent_type: 'flow:flow-light', description: 'x' })).toBe(false)
  expect(isOwnWorkerSpawn('other', { subagent_type: 'flow:flow-light', description: 'x' })).toBe(false)
  // Other agent types, even from flow.
  expect(isOwnWorkerSpawn('flow', { subagent_type: 'general-purpose', description: 'x' })).toBe(false)
  expect(isOwnWorkerSpawn('flow', { subagent_type: 'flow:flow-evil', description: 'x' })).toBe(false)
  expect(isOwnWorkerSpawn('flow', null)).toBe(false)
})

test('a tool.check for an Agent call from outside flow falls through (setting on)', { options: { allowWorkers: 'on' } }, async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const verdict = await $.tool.check({ tool: 'Agent', input: { subagent_type: 'flow:flow-light', description: 'x', prompt: 'p' } })
  expect(verdict.decision).toBe('ask')
})

test('with the setting off flow adds no approval', async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const verdict = await $.tool.check({ tool: 'Agent', input: { subagent_type: 'flow:flow-light', description: 'x', prompt: 'p' } })
  expect(verdict.decision).toBe('ask')
})
