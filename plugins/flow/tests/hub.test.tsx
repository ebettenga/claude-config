import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Run } from '../types'

const HOME = '/home/u'
const FLOWS = `${HOME}/Documents/flows`
const RUNS = `${HOME}/.flow/runs`
const SURFACES = ['desktop', 'terminal'] as const

const PANE = {
  plugin: 'flow',
  component: 'Pane',
  requestId: 'flow-chart',
  props: {
    title: 'Flow chart',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const REPORTS = `
title: Weekly client reports
description: Pulls each client's orders and writes a report per client.
owner: Ethan
tags: [reports, shopify]
env: [SHOP_TOKEN]
inputs:
  - id: week
    label: Week starting
    type: date
    default: last-monday
  - id: logo
    label: Logo
    type: file
    accept: [.png, .svg]
    required: true
  - id: send
    label: Send emails
    type: boolean
steps:
  - id: fetch
    title: Fetch orders
    run: echo fetch
  - id: report
    title: Write report
    agent: light
    prompt: Write the report
outputs: [report.txt]
`

const CSV = `
title: CSV summary
description: Stats for any CSV.
tags: [csv, data]
inputs:
  - id: size
    label: Size
    type: select
    options: [s, m, l]
  - id: month
    label: Month
    type: select
    options: [jan, feb, mar, apr, may, jun, jul]
  - id: notes
    label: Notes
    type: textarea
  - id: rows
    label: Rows
    type: number
  - id: out
    label: Out folder
    type: folder
steps:
  - id: count
    title: Count rows
    run: wc -l
`

const EACH = `
title: Each
steps:
  - id: each
    title: Each client
    for_each: [acme, birdie]
    as: client
    run: echo {{client}}
`

const GATE = `
title: Gate
steps:
  - id: make
    title: Make report
    run: make-report
    outputs: [report.txt]
  - id: ok
    title: Review
    approve: Send the report?
`

type Proc = { command: string; finish: (code: number) => void }

/** Files in memory, children the test ends, prompt fills recorded. */
// `isTrackingPanes`: ui.panes answers with the panes opened and not closed since.
function world(on: On, files: Record<string, string>, env: Record<string, string> = {}, isTrackingPanes = false) {
  const clock = mock.clock(on, { now: new Date(2026, 9, 28, 12, 0, 0).getTime() })
  const vars: Record<string, string> = { HOME, ...env }
  mock.env(on, vars)
  const fs = new Map(Object.entries(files))
  const isDir = (path: string) => [...fs.keys()].some(k => k.startsWith(`${path.replace(/\/+$/, '')}/`))
  on('fs.exists', (_, e) => ({ value: fs.has(e.path) || isDir(e.path) }))
  on('fs.read', (_, e) => ({ value: fs.get(e.path) ?? '' }))
  on('fs.write', (_, e) => {
    fs.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const base = `${e.path.replace(/\/+$/, '')}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const k of fs.keys()) {
      if (!k.startsWith(base)) continue
      const rest = k.slice(base.length)
      names.set(rest.split('/')[0] ?? '', rest.includes('/') ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', (_, e) => {
    if (fs.has(e.path)) return { value: { kind: 'file', size: 0, mtimeMs: 1000, isLink: false } }
    if (isDir(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: 1000, isLink: false } }
    throw new Error(`no such file: ${e.path}`)
  })
  const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_, e) => {
    // Spotlight: mdfind -onlyin <home> '<expr>', answered from the files in memory.
    if (e.argv[0] === 'mdfind') {
      const expr = e.argv[3] ?? ''
      const suffixes = [...expr.matchAll(/"\*(\.[^"*]+)"c/g)].map(m => (m[1] ?? '').toLowerCase())
      const exact = /kMDItemFSName == "([^"*]+)"$/.exec(expr)?.[1]
      const hits = [...fs.keys()].filter(k => {
        const name = k.slice(k.lastIndexOf('/') + 1)
        return exact ? name === exact : suffixes.some(x => name.toLowerCase().endsWith(x))
      })
      return ran(hits.join('\n'))
    }
    // The env check: bash -c '[ -n "${!1+x}" ]' _ NAME.
    return ran('', (e.argv[4] ?? '') in vars ? 0 : 1)
  })
  const procs: Proc[] = []
  on('process.spawn', async function* (_, e) {
    let done: (code: number) => void = () => undefined
    const ended = new Promise<number>(resolve => (done = resolve))
    procs.push({ command: e.argv[2] ?? '', finish: code => done(code) })
    return { value: { code: await ended, signal: null } }
  })
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))
  const fills: string[] = []
  on('prompt.fill', (_, e) => {
    fills.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__flow__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }) as never)
  const panes: string[] = []
  on('ui.open', (_, e) => {
    if (!panes.includes(e.id)) panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    if (panes.includes(e.id)) panes.splice(panes.indexOf(e.id), 1)
    return { value: undefined } as never
  })
  if (isTrackingPanes) on('ui.panes', () => ({ value: panes.map(id => ({ id })) }) as never)
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const runIds = (wf: string) => [...fs.keys()].filter(k => k.startsWith(`${RUNS}/${wf}/`) && k.endsWith('/run.json')).map(k => k.split('/').slice(-2)[0] ?? '')
  const runFile = (wf: string, id: string) => JSON.parse(fs.get(`${RUNS}/${wf}/${id}/run.json`) ?? 'null') as Run
  return { clock, fs, procs, fills, panes, runIds, runFile }
}

async function begin($: Engine, surface: (typeof SURFACES)[number]) {
  await $.session.start({ cwd: '/repo', surface, isInteractive: true } as never)
  await $.command.run({ command: 'flow-chart', args: '' })
}

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) => (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')

for (const surface of SURFACES) {
  test(`every tab and board draws (${surface})`, { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, { [`${FLOWS}/reports/flow.yaml`]: REPORTS, [`${FLOWS}/csv/flow.yaml`]: CSV, [`${FLOWS}/broken/flow.yaml`]: 'title: [' })
    await begin($, surface)
    const ui = await $.ui.mount({ ...PANE, surface })
    let all = await texts(ui)
    expect(all).toContain('WORKFLOWS')
    expect(all).toContain('Weekly client reports')
    expect(all).toContain('1 fixed · 1 AI')
    expect(all).toContain('never run')
    expect(all).toContain('Needs SHOP_TOKEN in your environment')
    expect(all).toContain('DID NOT LOAD')
    expect(await ui.find({ type: 'Text', text: /RUNNING NOW/ })).toBeFalsy()

    // 2. the workflow board
    await ui.press({ key: 'run:reports' })
    all = await texts(ui)
    expect(all).toContain('‹ Workflows')
    expect(all).toContain('STEPS')
    expect(all).toContain('2 STEPS · 2 LEVELS')
    expect(all).toContain('Fetch orders')
    expect(all).toContain('SHOP_TOKEN is not set')
    expect(await ui.find({ type: 'Button', key: 'run-workflow' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'harden' })).toBeFalsy()
    expect((await ui.find({ type: 'Input', key: 'in:reports:week' }))?.props.value).toBe('2026-10-26')
    await ui.press({ key: 'ask-change' })
    expect(w.fills[0]).toBe(`Change the flow workflow "Weekly client reports" (~/Documents/flows/reports/flow.yaml): `)
    await ui.press({ key: 'back:workflows' })

    // 3. runs, 4. skills
    await ui.press({ key: 'tab:runs' })
    expect(await ui.find({ type: 'Text', text: /No runs yet/ })).toBeTruthy()
    await ui.press({ key: 'tab:agents' })
    expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeTruthy()
    await ui.press({ key: 'tab:skills' })
    await w.clock.settle()
    expect(await ui.find({ type: 'Text', text: /EVERYTHING CLAUDE CAN USE/ })).toBeTruthy()
    await ui.press({ key: 'tab:workflows' })
    expect(await ui.find({ type: 'Text', text: /^CSV summary$/ })).toBeTruthy()

    // Every kind of field: pills for a short select, a Select past six, a folder browser.
    await ui.press({ key: 'run:csv' })
    await ui.press({ key: 'opt:csv:size:m' })
    expect(await ui.find({ type: 'Select', key: 'in:csv:month' })).toBeTruthy()
    await ui.select({ key: 'in:csv:month', value: 'feb' })
    expect((await ui.find({ type: 'Select', key: 'in:csv:month' }))?.props.value).toBe('feb')
    expect(await ui.find({ type: 'Input', key: 'in:csv:notes' })).toBeTruthy()
    await ui.press({ key: 'browse:csv:out' })
    await ui.press({ key: 'usedir:csv:out' })
    expect((await ui.find({ type: 'Input', key: 'in:csv:out' }))?.props.value).toBe(`${FLOWS}/csv`)
    await ui.unmount()
  })

  test(`search filters by title, tag, description and id (${surface})`, async ($, on) => {
    world(on, { [`${FLOWS}/reports/flow.yaml`]: REPORTS, [`${FLOWS}/csv/flow.yaml`]: CSV })
    await begin($, surface)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.input({ key: 'hub-q', text: 'data', kind: 'change' })
    expect(await ui.find({ type: 'Text', text: /^CSV summary$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Weekly client reports$/ })).toBeFalsy()
    await ui.input({ key: 'hub-q', text: 'orders', kind: 'change' })
    expect(await ui.find({ type: 'Text', text: /^Weekly client reports$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^CSV summary$/ })).toBeFalsy()
    await ui.input({ key: 'hub-q', text: 'nothing-like-it', kind: 'change' })
    expect(await ui.find({ type: 'Text', text: /No workflow matches/ })).toBeTruthy()
    await ui.unmount()
  })

  test(`flows.yaml groups and orders the workflows; Arrange changes and saves it (${surface})`, async ($, on) => {
    const w = world(on, {
      [`${FLOWS}/reports/flow.yaml`]: REPORTS,
      [`${FLOWS}/csv/flow.yaml`]: CSV,
      [`${FLOWS}/each/flow.yaml`]: EACH,
      [`${FLOWS}/flows.yaml`]: 'groups:\n  - title: Data\n    workflows: [csv, reports]\n',
    })
    await begin($, surface)
    const ui = await $.ui.mount({ ...PANE, surface })
    const order = async () => {
      const all = await texts(ui)
      return ['Data', 'CSV summary', 'Weekly client reports', 'Other'].map(t => all.indexOf(t))
    }
    const [data, csv, reports, other] = await order()
    expect(data).toBeGreaterThanOrEqual(0)
    expect(data < csv && csv < reports && reports < other).toBe(true)

    // Fold a group shut.
    await ui.press({ key: 'fold:Data' })
    expect(await ui.find({ type: 'Text', text: /^CSV summary$/ })).toBeFalsy()
    await ui.press({ key: 'fold:Data' })

    // Arrange: move reports up, then make a group and put the third workflow in it.
    await ui.press({ key: 'arrange' })
    expect(await ui.find({ type: 'Button', key: 'run:csv' })).toBeFalsy()
    await ui.press({ key: 'wup:reports' })
    await w.clock.settle()
    expect(w.fs.get(`${FLOWS}/flows.yaml`)).toMatch(/workflows: \[reports, csv\]/)
    await ui.input({ key: 'new-group-name', text: 'Batch', kind: 'submit' })
    await w.clock.settle()
    expect(w.fs.get(`${FLOWS}/flows.yaml`)).toMatch(/title: Batch/)
    await ui.press({ key: 'gup:Batch' })
    await w.clock.settle()
    const text = w.fs.get(`${FLOWS}/flows.yaml`) ?? ''
    expect(text.indexOf('Batch')).toBeLessThan(text.indexOf('Data'))
    await ui.press({ key: 'arrange' })
    expect(await ui.find({ type: 'Button', key: 'run:csv' })).toBeTruthy()
    await ui.unmount()
  })

  test(`a file input: browse, enter a folder, pick a file (${surface})`, async ($, on) => {
    world(on, {
      [`${FLOWS}/reports/flow.yaml`]: REPORTS,
      [`${FLOWS}/reports/brand/logo.png`]: 'png',
      [`${FLOWS}/reports/brand/notes.pdf`]: 'pdf',
    })
    await begin($, surface)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'run:reports' })
    await ui.press({ key: 'browse:reports:logo' })
    await ui.press({ key: 'tobrowse:reports:logo' })
    // The workflow folder, folders first.
    expect(await ui.find({ type: 'Button', key: `pick:${FLOWS}/reports/brand` })).toBeTruthy()
    await ui.press({ key: `pick:${FLOWS}/reports/brand` })
    expect(await ui.find({ type: 'Text', text: /Documents\/flows\/reports\/brand$/ })).toBeTruthy()
    // A file accept rules out is shown, not pickable.
    expect(await ui.find({ type: 'Text', text: /^notes\.pdf$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: `pick:${FLOWS}/reports/brand/notes.pdf` })).toBeFalsy()
    await ui.press({ key: `pick:${FLOWS}/reports/brand/logo.png` })
    expect((await ui.find({ type: 'Input', key: 'in:reports:logo' }))?.props.value).toBe(`${FLOWS}/reports/brand/logo.png`)
    await ui.press({ key: `up:reports:logo` })
    expect(await ui.find({ type: 'Button', key: `pick:${FLOWS}/reports/brand` })).toBeTruthy()
    await ui.press({ key: 'browse:reports:logo' })
    expect(await ui.find({ type: 'Button', key: `pick:${FLOWS}/reports/brand` })).toBeFalsy()
    await ui.unmount()
  })

  test(`Run with a required input left empty shows the problem and starts nothing (${surface})`, async ($, on) => {
    const w = world(on, { [`${FLOWS}/reports/flow.yaml`]: REPORTS })
    await begin($, surface)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'run:reports' })
    expect(await ui.find({ type: 'Text', text: /Logo is required/ })).toBeFalsy()
    await ui.press({ key: 'run-workflow' })
    await w.clock.settle()
    expect(await ui.find({ type: 'Text', text: /Logo is required/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /SHOP_TOKEN is not set in the environment/ })).toBeTruthy()
    expect(w.runIds('reports')).toEqual([])
    expect(w.procs.length).toBe(0)
    await ui.unmount()
  })

  test(`Run with good inputs starts a run and opens it (${surface})`, async ($, on) => {
    const w = world(on, { [`${FLOWS}/reports/flow.yaml`]: REPORTS, '/art/logo.png': 'png' }, { SHOP_TOKEN: 'x' })
    await begin($, surface)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'run:reports' })
    expect(await ui.find({ type: 'Text', text: /SHOP_TOKEN is set/ })).toBeTruthy()
    await ui.input({ key: 'in:reports:logo', text: '/art/logo.png', kind: 'change' })
    await ui.press({ key: 'yes:reports:send' })
    await ui.press({ key: 'run-workflow' })
    await w.clock.settle()
    const [id] = w.runIds('reports')
    expect(id).toBeTruthy()
    expect(w.runFile('reports', id ?? '').inputs).toEqual({ week: '2026-10-26', logo: '/art/logo.png', send: 'true' })
    expect(w.procs[0]?.command).toBe('echo fetch')
    // The Runs tab, on that run.
    expect(await ui.find({ type: 'Text', text: new RegExp(`Run ${id}`) })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'cancel-run' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^LOG · FETCH ORDERS$/ })).toBeTruthy()
    await ui.press({ key: 'back:runs' })
    expect(await ui.find({ type: 'Button', key: `open:${id}` })).toBeTruthy()
    w.procs[0]?.finish(0)
    await w.clock.settle()
    await ui.unmount()
  })

  test(`a waiting approval shows Approve and Reject, and Approve finishes it; outputs link to the viewer (${surface})`, async ($, on) => {
    const w = world(on, { [`${FLOWS}/gate/flow.yaml`]: GATE })
    await begin($, surface)
    const { result } = (await $.tool.call({ tool: 'mcp__flow__run_workflow', id: 'gate', inputs: {} } as never)) as { result: string }
    const id = /^Started run (\S+)\./.exec(result)?.[1] ?? ''
    await w.clock.settle()
    w.fs.set(`${RUNS}/gate/${id}/report.txt`, 'done')
    w.procs[0]?.finish(0)
    await w.clock.settle()
    expect(w.runFile('gate', id).steps.map(s => s.status)).toEqual(['done', 'waiting'])

    // The run Claude started opened the pane on itself.
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /WAITING FOR YOU · REVIEW/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Send the report\?$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'reject:ok' })).toBeTruthy()
    const views = (await ui.findAll({ type: 'Markdown' })).map(m => String(m.props.text))
    expect(views).toContain(`[View](file://${RUNS}/gate/${id}/report.txt)`)
    expect(views).toContain(`[Open run folder](file://${RUNS}/gate/${id})`)
    await ui.press({ key: 'approve:ok' })
    await w.clock.settle()
    expect(w.runFile('gate', id).status).toBe('done')
    expect(await ui.find({ type: 'Button', key: 'approve:ok' })).toBeFalsy()
    expect(await ui.find({ type: 'Button', key: 'cancel-run' })).toBeFalsy()
    await ui.press({ key: 'tab:workflows' })
    expect(await ui.find({ type: 'Text', text: /✓ just now/ })).toBeTruthy()
    await ui.unmount()
  })

  test(`the Skills tab lists skills and agents, and Use fills the prompt (${surface})`, async ($, on) => {
    const w = world(on, {
      [`${FLOWS}/csv/flow.yaml`]: CSV,
      [`${HOME}/.claude/skills/tidy/SKILL.md`]: '---\nname: tidy\ndescription: Tidy a folder. Moves things around.\n---\nbody',
      [`${HOME}/.claude/agents/scout.md`]: '---\nname: scout\nmodel: opus\neffort: low\ndescription: Finds files fast.\n---\nbody',
      [`${HOME}/.claude/plugins/cache/kit/savvy/1.0.0/skills/plan/SKILL.md`]: '---\nname: plan\ndescription: Plan the work\n---\n',
      [`${HOME}/.claude/plugins/cache/kit/savvy/1.0.0/agents/worker.md`]: '---\nname: worker\nmodel: sonnet\n---\n',
    })
    await begin($, surface)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:skills' })
    await w.clock.settle()
    const all = await texts(ui)
    expect(all).toContain('/tidy')
    expect(all).toContain('Tidy a folder')
    expect(all).toContain('/savvy:plan')
    expect(all).toContain('scout')
    expect(all).toContain('Opus · low · Finds files fast')
    expect(all).toContain('savvy:worker')
    expect(all).toMatch(/EVERYTHING CLAUDE CAN USE[\s\S]*\b5\b/)
    await ui.press({ key: 'use:skill:/tidy' })
    await ui.press({ key: 'use:agent:scout' })
    await ui.press({ key: 'use:skill:/savvy:plan' })
    expect(w.fills).toEqual(['/tidy ', 'Use the scout agent to ', '/savvy:plan '])
    await ui.press({ key: 'use:wf:csv' })
    expect(await ui.find({ type: 'Text', text: /^CSV summary$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'run-workflow' })).toBeTruthy()
    await ui.unmount()
  })

  test(`the Skills tab lists MCP servers with their tools, and its sections fold (${surface})`, async ($, on) => {
    const w = world(on, { [`${FLOWS}/csv/flow.yaml`]: CSV })
    on('tool.list', () => ({
      value: [
        { name: 'Read', description: 'Reads a file', mcp: false },
        { name: 'mcp__shopify__list-orders', description: 'Orders', mcp: true },
        { name: 'mcp__shopify__get-order', description: 'One order', mcp: true },
        { name: 'mcp__google-drive__search', description: 'Search Drive', mcp: true },
      ],
    }))
    await begin($, surface)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:skills' })
    await w.clock.settle()
    let all = await texts(ui)
    expect(all).toContain('MCP SERVERS')
    expect(all).toContain('2 tools: get-order, list-orders')
    expect(all).toContain('google-drive')
    expect(all).not.toContain('Reads a file')
    await ui.press({ key: 'use:mcp:shopify' })
    expect(w.fills).toEqual(['Using the shopify MCP server, '])
    await ui.press({ key: 'fold:skills:MCP servers' })
    all = await texts(ui)
    expect(all).toContain('MCP SERVERS')
    expect(all).not.toContain('google-drive')
    await ui.press({ key: 'fold:skills:Workflows' })
    expect(await ui.find({ type: 'Button', key: 'use:wf:csv' })).toBeFalsy()
    await ui.press({ key: 'fold:skills:Workflows' })
    expect(await ui.find({ type: 'Button', key: 'use:wf:csv' })).toBeTruthy()
    await ui.unmount()
  })

  test(`a for_each step: the Running now card, its items, and a chosen item's log (${surface})`, async ($, on) => {
    const w = world(on, { [`${FLOWS}/each/flow.yaml`]: EACH })
    await begin($, surface)
    await $.tool.call({ tool: 'mcp__flow__run_workflow', id: 'each', inputs: {} } as never)
    await w.clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface })
    let all = await texts(ui)
    expect(all).toContain('EACH CLIENT · FOR EACH CLIENT')
    expect(all).toContain('0 OF 2')
    expect(all).toMatch(/running…/)
    expect(all).toContain('LOG · EACH CLIENT · ACME')
    await ui.press({ key: 'itm:each[1]' })
    expect(await ui.find({ type: 'Text', text: /^LOG · EACH CLIENT · BIRDIE$/ })).toBeTruthy()
    await ui.press({ key: 'step:each' })
    await ui.press({ key: 'tab:workflows' })
    all = await texts(ui)
    expect(all).toContain('RUNNING NOW')
    expect(all).toContain('Each client · 0 of 2 clients done')
    expect(all).toContain('● running')
    for (const p of w.procs) p.finish(0)
    await w.clock.settle()
    expect(await ui.find({ type: 'Text', text: /RUNNING NOW/ })).toBeFalsy()
    await ui.unmount()
  })
}

test('/flow-chart <id> opens that workflow', async ($, on) => {
  world(on, { [`${FLOWS}/csv/flow.yaml`]: CSV })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
  const opened = (await $.command.run({ command: 'flow-chart', args: 'csv' })) as { text: string }
  expect(opened.text).toBe('Flow chart opened.')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'run-workflow' })).toBeTruthy()
  await ui.unmount()
  const missing = (await $.command.run({ command: 'flow-chart', args: 'ghost' })) as { text: string }
  expect(missing.text).toContain('no workflow "ghost"')
})

for (const surface of SURFACES) {
  test(`a file input suggests matching files from Spotlight and earlier runs (${surface})`, async ($, on) => {
    world(on, {
      [`${FLOWS}/reports/flow.yaml`]: REPORTS,
      [`${HOME}/Downloads/logo-final.png`]: 'png',
      [`${HOME}/Documents/notes.pdf`]: 'pdf',
      [`${HOME}/code/app/node_modules/pkg/icon.png`]: 'png',
      [`${RUNS}/reports/20261027-090000-abcd/logo-made.png`]: 'png',
      [`${RUNS}/reports/20261027-090000-abcd/run.json`]: '{}',
    })
    await begin($, surface)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'run:reports' })
    await ui.press({ key: 'browse:reports:logo' })
    // Spotlight's .png hit, but not one inside node_modules, nor a .pdf.
    expect(await ui.find({ type: 'Button', key: `sp:mac:${HOME}/Downloads/logo-final.png` })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: `sp:mac:${HOME}/code/app/node_modules/pkg/icon.png` })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /^notes\.pdf$/ })).toBeFalsy()
    // A file an earlier run made, labelled with its workflow and run.
    expect(await ui.find({ type: 'Button', key: `sp:run:${RUNS}/reports/20261027-090000-abcd/logo-made.png` })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /reports · 20261027-090000-abcd/ })).toBeTruthy()
    // The search narrows the list; a press picks.
    await ui.input({ key: 'fq:reports:logo', text: 'final', kind: 'change' })
    expect(await ui.find({ type: 'Button', key: `sp:run:${RUNS}/reports/20261027-090000-abcd/logo-made.png` })).toBeFalsy()
    await ui.press({ key: `sp:mac:${HOME}/Downloads/logo-final.png` })
    expect((await ui.find({ type: 'Input', key: 'in:reports:logo' }))?.props.value).toBe(`${HOME}/Downloads/logo-final.png`)
    await ui.unmount()
  })

  test(`a folder input with contains: lists the projects that hold it (${surface})`, async ($, on) => {
    world(on, {
      [`${FLOWS}/health/flow.yaml`]: `id: health
title: Health
inputs:
  - { id: repo, type: folder, contains: [package.json] }
steps:
  - { id: t, run: npm test, cwd: "{{inputs.repo}}" }
`,
      [`${HOME}/code/app/package.json`]: '{}',
      [`${HOME}/code/app/node_modules/left-pad/package.json`]: '{}',
      [`${HOME}/code/site/package.json`]: '{}',
      [`${HOME}/code/notes/README.md`]: '#',
    })
    await begin($, surface)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'run:health' })
    await ui.press({ key: 'browse:health:repo' })
    expect(await ui.find({ type: 'Text', text: /FOLDERS WITH PACKAGE\.JSON/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: `sp:mac:${HOME}/code/app` })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: `sp:mac:${HOME}/code/site` })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: `sp:mac:${HOME}/code/app/node_modules/left-pad` })).toBeFalsy()
    expect(await ui.find({ type: 'Button', key: `sp:mac:${HOME}/code/notes` })).toBeFalsy()
    await ui.press({ key: `sp:mac:${HOME}/code/site` })
    expect((await ui.find({ type: 'Input', key: 'in:health:repo' }))?.props.value).toBe(`${HOME}/code/site`)
    await ui.unmount()
  })
}

const RESULTS = `
title: Results
steps:
  - id: make
    title: Make files
    run: make-files
  - id: ok
    title: Review
    approve: Publish the files?
  - id: final
    title: Final check
    approve: Ship it?
outputs:
  - summary.md
  - { file: sales.csv, title: Totals by category, chart: { type: bar, x: category, y: price, agg: sum } }
  - { file: weather.csv, title: Weather totals, chart: { type: bar, x: category, y: price } }
  - rows.csv
`

/** The files a Results run leaves: a long summary, two charted CSVs (one without the column), a plain CSV, two chart.json files. */
function resultFiles(dir: string): Record<string, string> {
  return {
    [`${dir}/summary.md`]: ['# Summary', ...Array.from({ length: 99 }, (_, i) => `- line ${i + 1}`)].join('\n'),
    [`${dir}/sales.csv`]: 'date,category,price\r\n2026-09-01,Apparel,64.00\r\n2026-09-02,"Bags, large",200\r\n2026-09-03,Apparel,"1,036.00"\r\n',
    [`${dir}/weather.csv`]: 'date,city,temp\n2026-09-01,Phoenix,101\n',
    [`${dir}/rows.csv`]: ['name,n,note', ...Array.from({ length: 12 }, (_, i) => `row ${i + 1},${i},"a, b"`)].join('\n'),
    [`${dir}/trend.chart.json`]: JSON.stringify({ type: 'line', title: 'Sales by day', labels: ['09-01', '09-02', '09-03'], series: [{ name: 'total', values: [64, 200, 1036] }] }),
    [`${dir}/broken.chart.json`]: JSON.stringify({ type: 'pie', labels: [], series: [] }),
  }
}

for (const surface of SURFACES) {
  test(`Results: approvals, a summary, charts, a bad chart's note and a table preview (${surface})`, { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, { [`${FLOWS}/results/flow.yaml`]: RESULTS })
    await begin($, surface)
    const { result } = (await $.tool.call({ tool: 'mcp__flow__run_workflow', id: 'results', inputs: {} } as never)) as { result: string }
    const id = /^Started run (\S+)\./.exec(result)?.[1] ?? ''
    const dir = `${RUNS}/results/${id}`
    await w.clock.settle()
    for (const [k, v] of Object.entries(resultFiles(dir))) w.fs.set(k, v)
    w.procs[0]?.finish(0)
    await w.clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface })
    let all = await texts(ui)
    expect(all).toContain('RESULTS')
    expect(all).toContain('FILES')
    expect(all).not.toContain('OUTPUTS')

    // 1. Approvals: the waiting one with its buttons, the next not reached yet.
    expect(all).toContain('WAITING FOR YOU · REVIEW')
    expect(await ui.find({ type: 'Text', text: /^Publish the files\?$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'approve:ok' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'reject:ok' })).toBeTruthy()
    expect(all).toContain('FINAL CHECK')
    expect(all).toMatch(/not reached/i)
    expect(await ui.find({ type: 'Text', text: /^Ship it\?$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'approve:final' })).toBeFalsy()

    // 2. Summaries: Markdown, capped at 80 lines, folding.
    const md = async () => (await ui.findAll({ type: 'Markdown' })).map(m => String(m.props.text))
    const summary = (await md()).find(t => t.startsWith('# Summary'))
    expect(summary?.split('\n').length).toBe(80)
    expect(all).toContain('… 20 more lines, View for all')
    expect(await md()).toContain(`[View](file://${dir}/summary.md)`)

    // 3. Charts: the declared bar chart, the chart.json line, and two notes.
    if (surface === 'desktop') {
      const svgs = (await ui.findAll({ type: 'Svg' })).map(e => ({ alt: String(e.props.alt), source: String(e.props.source) }))
      const bar = svgs.find(s => s.alt.startsWith('Bar chart, Totals by category'))
      expect(bar?.alt).toContain('Apparel 1,100')
      expect(bar?.alt).toContain('Bags, large 200')
      expect(bar?.source).toContain('<path d="M')
      expect(bar?.source).toContain('<title>Apparel: 1,100</title>')
      const line = svgs.find(s => s.alt.startsWith('Line chart, Sales by day'))
      expect(line?.source).toContain('<polyline')
    } else {
      expect(await ui.find({ type: 'Svg' })).toBeFalsy()
      expect(all).toMatch(/Apparel +█+ 1,100/)
      expect(all).toMatch(/Bags, large +█+ 200/)
      expect(all).toMatch(/09-03 +█+ 1,036/)
    }
    expect(all).toContain('Totals by category')
    expect(all).toContain('sum of price by category')
    expect(all).toContain('chart: no column category')
    expect(all).toContain('chart: type "pie": use bar or line')

    // 4. Tables: the header, the first 10 rows and the size.
    const table = (await md()).find(t => t.startsWith('| name | n | note |'))
    expect(table).toContain('| row 10 | 9 | a, b |')
    expect(table).not.toContain('row 11')
    expect(all).toContain('12 rows × 3 columns')

    // Folding a summary hides it; the table stays.
    await ui.press({ key: 'res:summary.md' })
    expect((await md()).some(t => t.startsWith('# Summary'))).toBe(false)
    expect((await md()).some(t => t.startsWith('| name |'))).toBe(true)
    await ui.press({ key: 'res:summary.md' })
    expect((await md()).some(t => t.startsWith('# Summary'))).toBe(true)

    // Decided with a note, then the next approval waits and Approve finishes the run.
    await $.tool.call({ tool: 'mcp__flow__decide_step', run: id, step: 'ok', ok: true, output: 'Looks right' } as never)
    await w.clock.settle()
    all = await texts(ui)
    expect(all).toMatch(/approved/i)
    expect(all).toContain('Note: Looks right')
    expect(all).toContain('WAITING FOR YOU · FINAL CHECK')
    await ui.press({ key: 'approve:final' })
    await w.clock.settle()
    expect(w.runFile('results', id).status).toBe('done')
    expect(await ui.find({ type: 'Button', key: 'approve:final' })).toBeFalsy()
    all = await texts(ui)
    expect(all).not.toContain('WAITING FOR YOU')
    expect(all).not.toMatch(/not reached/i)
    await ui.unmount()
  })

  test(`pressing a step on a run shows its log while another step runs (${surface})`, async ($, on) => {
    const w = world(on, { [`${FLOWS}/gate/flow.yaml`]: GATE })
    await begin($, surface)
    await $.tool.call({ tool: 'mcp__flow__run_workflow', id: 'gate', inputs: {} } as never)
    await w.clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^LOG · MAKE REPORT$/ })).toBeTruthy()
    await ui.press({ key: 'step:ok' })
    expect(await ui.find({ type: 'Text', text: /^LOG · REVIEW$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Not started yet$/ })).toBeTruthy()
    await ui.press({ key: 'step:make' })
    expect(await ui.find({ type: 'Text', text: /^LOG · MAKE REPORT · LIVE$|^LOG · MAKE REPORT$/ })).toBeTruthy()
    w.procs[0]?.finish(0)
    await w.clock.settle()
    await ui.unmount()
  })
}

test('the Agents tab lists the flow plan, and the band button opens and closes it', async ($, on) => {
  const w = world(on, { [`${FLOWS}/reports/flow.yaml`]: REPORTS }, {}, true)
  await begin($, 'terminal')
  await $.tool.call({ tool: 'mcp__flow__progress', title: 'Ship it', phase: 'delegate', tasks: [{ title: 'Write the parser', tier: 'careful' }] } as never)
  w.panes.splice(0)

  const band = await $.ui.mount({ plugin: 'flow', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100 } as never })
  await band.press({ key: 'flow-agents' })
  expect(w.panes).toEqual(['flow-chart'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Write the parser/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'tab:agents' })).toBeTruthy()
  await band.press({ key: 'flow-agents' })
  expect(w.panes).toEqual([])
})

for (const surface of SURFACES) {
  test(`the Views tab: search a view, open an item, and go back to the list (${surface})`, async ($, on) => {
    world(on, {
      [`${FLOWS}/people/view.yaml`]: `
title: People
description: Find someone.
search: { placeholder: Name }
filters:
  - { id: active, label: Active, args: { active: true } }
  - { id: all, label: Everyone }
list:
  mcp: { server: crm, tool: search_people, args: { search: "{{query}}" } }
  items: people
  key: id
  title: "{{item.name}}"
  subtitle: "#{{item.id}}"
  dot: item.on
detail:
  title: "{{profile.name}}"
  calls:
    profile: { server: crm, tool: get_person, args: { id: "{{key}}" } }
  sections:
    - title: Profile
      from: profile
      stats: [{ label: Rate, value: "{{profile.rate | percent}}" }]
      text: ["{{profile.about}}"]
`,
    })
    const calls: { tool: string; args: Record<string, unknown> }[] = []
    on('mcp.call', (_, e) => {
      calls.push({ tool: e.tool, args: e.args })
      const text = e.tool === 'search_people' ? JSON.stringify({ people: [{ id: 7, name: 'Sam', on: true }] }) : JSON.stringify({ name: 'Sam', rate: 0.42, about: 'Listens well.' })
      return { value: { content: [{ type: 'text', text }], isError: false } }
    })
    await begin($, surface)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:views' })
    await ui.press({ key: 'vopen:people' })
    expect(calls[0]).toEqual({ tool: 'search_people', args: { active: true } })
    expect(await ui.find({ type: 'Text', text: /^Sam$/ })).toBeTruthy()
    await ui.press({ key: 'vf:all' })
    expect(calls.at(-1)?.args).toEqual({})
    await ui.press({ key: 'vrow:7' })
    expect(calls.at(-1)).toEqual({ tool: 'get_person', args: { id: 7 } })
    expect(await ui.find({ type: 'Text', text: /^42%$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Listens well\./ })).toBeTruthy()
    await ui.press({ key: 'vback' })
    expect(await ui.find({ type: 'Button', key: 'vrow:7' })).toBeTruthy()
    await ui.unmount()
  })
}

for (const surface of SURFACES) {
  test(`a view's tabs, range, row action with confirm, and a form that saves (${surface})`, async ($, on) => {
    world(on, {
      [`${FLOWS}/clients/view.yaml`]: `
title: Clients
list:
  mcp: { server: kh, tool: get, args: { path: /clients } }
  items: data
  key: id
  title: "{{item.name}}"
detail:
  title: "{{client.name}}"
  calls:
    client: { server: kh, tool: get, args: { path: "/clients/{{key}}" } }
  actions:
    - id: rename
      label: Rename
      fields: [{ id: name, label: Name, required: true, default: "{{client.name}}" }]
      mcp: { server: kh, tool: write, args: { method: PUT, path: "/clients/{{key}}", body: { name: "{{form.name}}" } } }
      done: "Renamed to {{form.name}}"
  tabs:
    - id: reporting
      title: Reporting
      range: { modes: [week, month], default: month }
      calls:
        report: { server: kh, tool: get, args: { path: "/report/{{key}}", start: "{{range.start}}", end: "{{range.end}}" } }
      sections:
        - { title: Report, from: report, stats: [{ label: Calls, value: "{{report.calls}}" }] }
    - id: admins
      title: Admins
      calls:
        admins: { server: kh, tool: get, args: { path: "/admins/{{key}}" } }
      sections:
        - title: Admins
          from: admins
          table: { items: admins, columns: [{ label: Email, value: "{{row.email}}" }] }
          row_actions:
            - id: remove
              label: Remove
              style: danger
              confirm: "Remove {{row.email}}?"
              mcp: { server: kh, tool: write, args: { method: DELETE, path: "/admins/{{key}}/{{row.id}}" } }
`,
    })
    const calls: { tool: string; args: Record<string, unknown> }[] = []
    on('mcp.call', (_, e) => {
      calls.push({ tool: e.tool, args: e.args })
      const path = String(e.args.path)
      const out =
        e.tool === 'write' ? { ok: true }
        : path === '/clients' ? { data: [{ id: 5, name: 'Acme' }] }
        : path === '/clients/5' ? { name: 'Acme' }
        : path === '/report/5' ? { calls: 12 }
        : [{ id: 9, email: 'a@x.com' }]
      return { value: { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false } }
    })
    await begin($, surface)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:views' })
    await ui.press({ key: 'vopen:clients' })
    await ui.press({ key: 'vrow:5' })
    // The first tab's calls ran with its range: this month.
    const report = calls.find(c => c.args.path === '/report/5')
    expect(report?.args).toMatchObject({ start: '2026-10-01', end: '2026-10-31' })
    expect(await ui.find({ type: 'Text', text: /^12$/ })).toBeTruthy()
    await ui.press({ key: 'vrp' })
    expect(calls.filter(c => c.args.path === '/report/5').at(-1)?.args).toMatchObject({ start: '2026-09-01', end: '2026-09-30' })
    // Admins runs its own call; a row action asks first, then calls with the row.
    await ui.press({ key: 'vt:admins' })
    expect(calls.some(c => c.args.path === '/admins/5')).toBe(true)
    await ui.press({ key: 'va:t:admins:0:r0:remove' })
    expect(await ui.find({ type: 'Text', text: /^Remove a@x\.com\?$/ })).toBeTruthy()
    expect(calls.some(c => c.tool === 'write')).toBe(false)
    await ui.press({ key: 'vago:t:admins:0:r0:remove' })
    expect(calls.find(c => c.tool === 'write')?.args).toEqual({ method: 'DELETE', path: '/admins/5/9' })
    // A form opens with its default, and Save sends what was typed.
    await ui.press({ key: 'va:page:rename' })
    expect((await ui.find({ type: 'Input', key: 'fv:page:rename:name' }))?.props.value).toBe('Acme')
    await ui.input({ key: 'fv:page:rename:name', text: 'Acme Co', kind: 'change' })
    await ui.press({ key: 'vasv:page:rename' })
    expect(calls.filter(c => c.tool === 'write').at(-1)?.args).toEqual({ method: 'PUT', path: '/clients/5', body: { name: 'Acme Co' } })
    expect(await ui.find({ type: 'Text', text: /Renamed to Acme Co/ })).toBeTruthy()
    await ui.unmount()
  })
}

for (const surface of SURFACES) {
  test(`the Runs tab groups runs by workflow; the latest group is open, the rest fold (${surface})`, async ($, on) => {
    const now = new Date(2026, 9, 28, 12, 0, 0).getTime()
    const run = (wf: string, title: string, id: string, status: string, minsAgo: number) => [
      `${RUNS}/${wf}/${id}/run.json`,
      JSON.stringify({ id, workflowId: wf, title, workflowDir: `${FLOWS}/${wf}`, dir: `${RUNS}/${wf}/${id}`, inputs: {}, status, startedAt: now - minsAgo * 60_000, endedAt: now - minsAgo * 60_000 + 1000, steps: [] }),
    ]
    const w = world(on, Object.fromEntries([
      run('csv', 'CSV summary', '20261028-115000-aaaa', 'done', 10),
      run('csv', 'CSV summary', '20261028-110000-bbbb', 'failed', 60),
      run('reports', 'Weekly reports', '20261027-090000-cccc', 'done', 60 * 27),
    ]))
    await begin($, surface)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:runs' })
    // CSV ran last: its group is open, with both runs; Weekly reports is folded.
    expect(await ui.find({ type: 'Text', text: /▾ CSV summary/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /▸ Weekly reports/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'open:20261028-115000-aaaa' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'open:20261028-110000-bbbb' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'open:20261027-090000-cccc' })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /1 failed/ })).toBeTruthy()
    // A card's press puts its run id in the chat and opens the run.
    await ui.press({ key: 'open:20261028-110000-bbbb' })
    expect(w.fills.at(-1)).toBe('20261028-110000-bbbb ')
    await ui.press({ key: 'tab:runs' })
    // Fold one open and the other shut.
    await ui.press({ key: 'fold:runs:reports' })
    expect(await ui.find({ type: 'Button', key: 'open:20261027-090000-cccc' })).toBeTruthy()
    await ui.press({ key: 'fold:runs:csv' })
    expect(await ui.find({ type: 'Button', key: 'open:20261028-115000-aaaa' })).toBeFalsy()
    await ui.unmount()
  })
}
