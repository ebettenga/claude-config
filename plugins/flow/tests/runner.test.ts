import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Run } from '../types'

const HOME = '/home/u'
const FLOWS = `${HOME}/Documents/flows`
const RUNS = `${HOME}/.flow/runs`

type Proc = { command: string; argv: readonly string[]; cwd?: string; env?: Record<string, string>; finish: (code: number, stdout?: string, stderr?: string) => void }
type McpCall = { server: string; tool: string; args: Record<string, unknown> }
type McpResult = { content: { type: string; text?: string }[]; isError: boolean; structuredContent?: unknown }
type HttpCall = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }
type HttpResult = { status: number; ok: boolean; headers: Record<string, string>; text: string }
type Setup = {
  files?: Record<string, string>
  env?: Record<string, string>
  /** Python import names the mocked interpreter has. */
  packages?: string[]
  mcp?: (e: McpCall) => McpResult | Promise<McpResult>
  http?: (e: HttpCall) => HttpResult | Promise<HttpResult>
  /** Answers git through $.process.run: its exit code and stderr, and files a clone leaves. */
  git?: (argv: readonly string[]) => { exitCode?: number; stderr?: string; files?: Record<string, string> }
  /** Answers $.model.complete; default: an answer echoing the prompt's first line. */
  model?: (e: { model: string; prompt: string; maxTokens?: number }) => unknown
}

/** Everything beneath the plugin: files in memory, children the test ends, agents and prompts recorded. */
function world(on: On, setup: Setup = {}) {
  const clock = mock.clock(on, { now: new Date(2026, 9, 28, 12, 0, 0).getTime() })
  const env: Record<string, string> = { HOME, LANG: 'en_US.UTF-8', ...setup.env }
  mock.env(on, env)
  const files = new Map(Object.entries(setup.files ?? {}))
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path.replace(/\/+$/, '')}/`))

  on('fs.exists', (_, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const base = `${e.path.replace(/\/+$/, '')}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const k of files.keys()) {
      if (!k.startsWith(base)) continue
      const rest = k.slice(base.length)
      const name = rest.split('/')[0] ?? ''
      names.set(name, rest.includes('/') ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  // The env check: bash -c '[ -n "${!1+x}" ]' _ NAME; reading a value: bash -c 'printf %s "${!1}"' _ NAME;
  // a python requirement: <python> -c 'import <name>'.
  const runs: (readonly string[])[] = []
  on('process.run', (_, e) => {
    runs.push(e.argv)
    if (e.argv[0] === 'git') {
      const r = setup.git?.(e.argv) ?? {}
      for (const [k, v] of Object.entries(r.files ?? {})) files.set(k, v)
      return { value: { exitCode: r.exitCode ?? 0, stdout: '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const [, flag = '', script = '', , name = ''] = e.argv
    let exitCode = name in env ? 0 : 1
    let stdout = ''
    if (flag === '-c' && script.startsWith('printf')) [exitCode, stdout] = [0, env[name] ?? '']
    else if (flag === '-c' && script.startsWith('import ')) exitCode = (setup.packages ?? []).includes(script.slice('import '.length)) ? 0 : 1
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const mcpCalls: McpCall[] = []
  on('mcp.call', async (_, e) => {
    mcpCalls.push({ server: e.server, tool: e.tool, args: e.args })
    return { value: (await setup.mcp?.(e)) ?? { content: [], isError: false } }
  })
  const modelCalls: { model: string; prompt: string; maxTokens?: number }[] = []
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  on('model.complete', async (_, e) => {
    const call = { model: e.model, prompt: e.prompt, maxTokens: e.maxTokens }
    modelCalls.push(call)
    return { value: (setup.model?.(call) ?? { isAnswered: true, text: `answer to: ${e.prompt.split('\n')[0]}`, usage }) as never }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  const httpCalls: HttpCall[] = []
  on('http.fetch', async (_, e) => {
    httpCalls.push({ url: e.url, init: e.init })
    return { value: (await setup.http?.(e)) ?? { status: 200, ok: true, headers: {}, text: '' } }
  })

  const procs: Proc[] = []
  on('process.spawn', async function* (_, e) {
    let done: (r: { code: number; out: string; err: string }) => void = () => undefined
    const ended = new Promise<{ code: number; out: string; err: string }>(resolve => (done = resolve))
    procs.push({ command: e.argv[2] ?? '', argv: e.argv, cwd: e.cwd, env: e.env, finish: (code, out = '', err = '') => done({ code, out, err }) })
    const r = await ended
    if (r.out) yield { stream: 'stdout' as const, text: r.out }
    if (r.err) yield { stream: 'stderr' as const, text: r.err }
    return { value: { code: r.code, signal: null } }
  })

  const spawned: { subagentType?: string; description?: string; prompt: string }[] = []
  on('agent.spawn', (_, e) => {
    spawned.push({ subagentType: e.subagentType, description: e.description, prompt: e.prompt })
    return { model: 'claude-opus-5-5', agentId: `agent-${spawned.length}` }
  })
  const prompts: string[] = []
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', (_, e) => ({ text: e.reason === 'answer' ? e.answer : '' }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__flow__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  const runFile = (wf: string, id: string) => JSON.parse(files.get(`${RUNS}/${wf}/${id}/run.json`) ?? 'null') as Run
  const stepsOf = (wf: string, id: string) => Object.fromEntries(runFile(wf, id).steps.map(s => [s.id, s.status]))
  return { clock, files, procs, spawned, prompts, runFile, stepsOf, runs, mcpCalls, httpCalls, modelCalls }
}

async function begin($: Engine) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
}

async function start($: Engine, id: string, inputs: Record<string, string> = {}): Promise<string> {
  const { result } = (await $.tool.call({ tool: 'mcp__flow__run_workflow', id, inputs } as never)) as { result: string }
  const runId = /^Started run (\S+)\./.exec(result)?.[1]
  if (!runId) throw new Error(`not started: ${result}`)
  return runId
}

const PARALLEL = `
title: Parallel
steps:
  - id: a
    run: echo a
    after: []
  - id: b
    run: echo b
    after: []
  - id: c
    run: echo "got {{steps.a.output}}" > "{{run.dir}}/c.txt"
    after: [a, b]
`

test('parallel steps start together and a dependent waits for both', async ($, on) => {
  const w = world(on, { files: { [`${FLOWS}/par/flow.yaml`]: PARALLEL } })
  await begin($)
  const id = await start($, 'par')
  await w.clock.settle()

  expect(w.procs.map(p => p.command)).toEqual(['echo a', 'echo b'])
  expect(w.procs[0]?.cwd).toBe(`${FLOWS}/par`)
  expect(w.procs[0]?.env).toMatchObject({ FLOW_RUN_ID: id, FLOW_RUN_DIR: `${RUNS}/par/${id}`, FLOW_WORKFLOW_DIR: `${FLOWS}/par` })
  expect(w.stepsOf('par', id)).toEqual({ a: 'running', b: 'running', c: 'pending' })

  w.procs[0]?.finish(0, 'A\n')
  await w.clock.settle()
  expect(w.procs.length).toBe(2)
  expect(w.stepsOf('par', id)).toEqual({ a: 'done', b: 'running', c: 'pending' })

  w.procs[1]?.finish(0, 'B', 'warning\n')
  await w.clock.settle()
  expect(w.procs[2]?.command).toBe(`echo "got A" > "${RUNS}/par/${id}/c.txt"`)
  w.procs[2]?.finish(0)
  await w.clock.settle()

  const run = w.runFile('par', id)
  expect(run.status).toBe('done')
  expect(run.steps.find(s => s.id === 'a')).toMatchObject({ output: 'A', exitCode: 0, tail: 'A\n' })
  // stdout is the output; stderr only goes to the log.
  expect(run.steps.find(s => s.id === 'b')).toMatchObject({ output: 'B', tail: 'Bwarning\n' })
  expect(w.files.get(`${RUNS}/par/${id}/b.log`)).toBe('Bwarning\n')

  const status = (await $.tool.call({ tool: 'mcp__flow__run_status', run: id } as never)) as { result: string }
  expect(status.result).toContain(`Run ${id} of "Parallel" (par): done`)
  expect(status.result).toContain('- a: done\n  output: A')
})

test('a failed step skips its dependents, but continue_on_fail lets them run', async ($, on) => {
  const w = world(on, {
    files: {
      [`${FLOWS}/fails/flow.yaml`]: `
title: Fails
steps:
  - id: a
    run: exit 1
    after: []
  - id: b
    run: echo b
    after: [a]
  - id: c
    run: exit 2
    after: []
    continue_on_fail: true
  - id: d
    run: echo d
    after: [c]
`,
    },
  })
  await begin($)
  const id = await start($, 'fails')
  await w.clock.settle()
  w.procs[0]?.finish(1)
  w.procs[1]?.finish(2, '', 'boom\n')
  await w.clock.settle()

  expect(w.procs.map(p => p.command)).toEqual(['exit 1', 'exit 2', 'echo d'])
  expect(w.stepsOf('fails', id)).toEqual({ a: 'failed', b: 'skipped', c: 'failed', d: 'running' })
  w.procs[2]?.finish(0, 'd')
  await w.clock.settle()

  const run = w.runFile('fails', id)
  expect(run.status).toBe('failed')
  expect(run.steps.find(s => s.id === 'a')).toMatchObject({ status: 'failed', exitCode: 1 })
  expect(run.steps.find(s => s.id === 'c')).toMatchObject({ status: 'failed', exitCode: 2, tail: 'boom\n' })
  expect(run.steps.find(s => s.id === 'd')).toMatchObject({ status: 'done', output: 'd' })
})

test('a run step past its timeout fails', async ($, on) => {
  const w = world(on, { files: { [`${FLOWS}/slow/flow.yaml`]: 'title: Slow\nsteps:\n  - id: wait\n    run: sleep 100\n    timeout: 5\n' } })
  await begin($)
  const id = await start($, 'slow')
  await w.clock.advance(5_000)
  expect(w.runFile('slow', id).steps[0]).toMatchObject({ status: 'failed', error: 'timed out after 5s' })
  expect(w.runFile('slow', id).status).toBe('failed')
  w.procs[0]?.finish(0)
})

test('an agent step runs a restricted headless claude and its result is the output', async ($, on) => {
  const w = world(on, {
    files: {
      '/Users/me/app/package.json': '{}',
      [`${FLOWS}/ag/flow.yaml`]: `
title: Agent flow
inputs:
  - id: topic
    type: text
    default: golf
  - id: repo
    type: folder
    default: /Users/me/app
steps:
  - id: write
    title: Write it
    agent: light
    read: ["{{inputs.repo}}"]
    budget: 0.5
    prompt: Write about {{inputs.topic}} into {{run.dir}}/out.md
`,
    },
  })
  await begin($)
  const id = await start($, 'ag')
  await w.clock.settle()

  const dir = `${RUNS}/ag/${id}`
  const p = w.procs[0]
  expect(w.spawned.length).toBe(0)
  expect(p?.cwd).toBe(dir)
  const argv = p?.argv ?? []
  expect(argv.slice(0, 2)).toEqual(['claude', '-p'])
  expect(argv[2]).toContain('You are running one step of the flow workflow "Agent flow" (ag).\nStep: Write it (write)')
  expect(argv[2]).toContain(`Write about golf into ${dir}/out.md`)
  expect(argv[2]).toContain(`You can write only in: ${dir}.`)
  for (const flag of ['--restricted', '--strict-mcp-config', '--no-session-persistence']) expect(argv).toContain(flag)
  const after = (flag: string) => argv[argv.indexOf(flag) + 1]
  expect(after('--permission-mode')).toBe('dontAsk')
  expect(after('--tools')).toBe('Read,Grep,Glob,Write')
  // Reads anywhere in its folders; writes only under the run folder.
  expect(after('--allowedTools')).toBe(`Read,Grep,Glob,Edit(/${dir}/**)`)
  expect(argv.slice(argv.indexOf('--add-dir') + 1, argv.indexOf('--add-dir') + 3)).toEqual(['/Users/me/app', dir])
  expect(after('--model')).toBe('opus')
  expect(after('--effort')).toBe('low')
  expect(after('--max-budget-usd')).toBe('0.5')

  const events = [
    { type: 'system', subtype: 'init', model: 'claude-opus-5-5', tools: ['Read', 'Write'] },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: `${dir}/out.md` } }] } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.04, result: '  Wrote out.md.  ' },
  ]
  p?.finish(0, `${events.map(e => JSON.stringify(e)).join('\n')}\n`)
  await w.clock.settle()
  const run = w.runFile('ag', id)
  expect(run.steps[0]).toMatchObject({ status: 'done', output: 'Wrote out.md.' })
  expect(run.status).toBe('done')
  const log = w.files.get(`${dir}/write.log`) ?? ''
  expect(log).toContain(`→ Write ${dir}/out.md`)
  expect(log).toContain('--- done: 2 turns · $0.04 ---')
  expect(log).not.toContain('"type"')
})

test('an agent step that is not signed in says how to sign in', async ($, on) => {
  const w = world(on, { files: { [`${FLOWS}/ag/flow.yaml`]: 'title: A\nsteps:\n  - id: w\n    agent: light\n    prompt: hi\n' } })
  await begin($)
  const id = await start($, 'ag')
  await w.clock.settle()
  w.procs[0]?.finish(1, `${JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' })}\n`)
  await w.clock.settle()
  expect(w.runFile('ag', id).steps[0]?.error).toContain('claude auth login')
})

// decideStep is the hub's to call from its own hooks: the kit refuses a test's
// hook the plugin's state, so finishing an approval is covered by the hub's tests;
// complete_step goes through decideStep for claude steps below.
test('an approve step waits, and complete_step will not answer it', async ($, on) => {
  const w = world(on, {
    files: {
      [`${FLOWS}/gate/flow.yaml`]: `
title: Gate
steps:
  - id: ok
    approve: Write {{run.dir}}/report.md?
  - id: write
    run: echo written
`,
    },
  })
  await begin($)
  const id = await start($, 'gate')
  await w.clock.settle()
  expect(w.runFile('gate', id).status).toBe('waiting')
  expect(w.stepsOf('gate', id)).toEqual({ ok: 'waiting', write: 'pending' })
  expect(w.runFile('gate', id).steps[0]?.tail).toBe(`Write ${RUNS}/gate/${id}/report.md?\n`)
  expect(w.procs.length).toBe(0)

  const wrong = (await $.tool.call({ tool: 'mcp__flow__complete_step', run: id, step: 'ok', ok: true, output: 'x' } as never)) as { result: string }
  expect(wrong.result).toBe('error: step "ok" is an approve step, not one handed to you')
  await w.clock.settle()
  expect(w.stepsOf('gate', id)).toEqual({ ok: 'waiting', write: 'pending' })
})

test('a claude step waits, and complete_step finishes it', async ($, on) => {
  const w = world(on, {
    files: {
      [`${FLOWS}/ask/flow.yaml`]: `
title: Ask
steps:
  - id: summary
    title: Summary
    claude: Sum up {{run.dir}}/notes.md
`,
    },
  })
  await begin($)
  const id = await start($, 'ask')
  await w.clock.settle()

  // Submitted from the tool call's own hook the prompt would wait on that turn:
  // it goes once the main loop's turn completes.
  expect(w.prompts).toEqual([])
  expect(w.runFile('ask', id).status).toBe('waiting')
  await $.turn.complete({ reason: 'answer', answer: 'Started it.', durationMs: 1, isAborted: false, turnId: 'main-1' } as never)
  await w.clock.settle()

  const dir = `${RUNS}/ask/${id}`
  expect(w.prompts).toEqual([
    `[flow] Workflow "Ask", step "Summary" (run ${id}, step summary).\n\nSum up ${dir}/notes.md\n\nRun folder: ${dir}\nWhen done, call the tool mcp__flow__complete_step with run "${id}", step "summary", ok true or false, and a one-paragraph output.`,
  ])
  expect(w.runFile('ask', id).status).toBe('waiting')

  const done = (await $.tool.call({ tool: 'mcp__flow__complete_step', run: id, step: 'summary', ok: true, output: 'Wrote the summary.' } as never)) as { result: string }
  expect(done.result).toContain('Recorded')
  await w.clock.settle()
  expect(w.runFile('ask', id).steps[0]).toMatchObject({ status: 'done', output: 'Wrote the summary.' })
  expect(w.runFile('ask', id).status).toBe('done')

  // A step that no longer waits is an error.
  const again = (await $.tool.call({ tool: 'mcp__flow__complete_step', run: id, step: 'summary', ok: true, output: 'x' } as never)) as { result: string }
  expect(again.result).toBe('error: step "summary" is done, not waiting')
})

const NEEDS = `
title: Needs
env: [FLOW_TEST_TOKEN]
inputs:
  - id: csv
    label: CSV file
    type: file
    accept: [.csv]
steps:
  - id: count
    run: wc -l "{{inputs.csv}}"
`

test('startRun refuses missing required inputs and unset env', async ($, on) => {
  const w = world(on, { files: { [`${FLOWS}/needs/flow.yaml`]: NEEDS } })
  await begin($)
  const refused = (await $.tool.call({ tool: 'mcp__flow__run_workflow', id: 'needs', inputs: {} } as never)) as { result: string }
  expect(refused.result).toBe('Not started:\n- CSV file is required\n- FLOW_TEST_TOKEN is not set in the environment')

  const missing = (await $.tool.call({ tool: 'mcp__flow__run_workflow', id: 'needs', inputs: { csv: '/data/nope.csv' } } as never)) as { result: string }
  expect(missing.result).toContain('- CSV file: /data/nope.csv does not exist')

  const unknown = (await $.tool.call({ tool: 'mcp__flow__run_workflow', id: 'ghost', inputs: {} } as never)) as { result: string }
  expect(unknown.result).toContain('no workflow "ghost"')
  await w.clock.settle()
  expect(w.procs.length).toBe(0)
})

test('startRun starts once the inputs and env are there', async ($, on) => {
  const w = world(on, { files: { [`${FLOWS}/needs/flow.yaml`]: NEEDS, '/data/a.csv': 'x\n' }, env: { FLOW_TEST_TOKEN: 'set' } })
  await begin($)
  const id = await start($, 'needs', { csv: '/data/a.csv' })
  await w.clock.settle()
  expect(w.procs[0]?.command).toBe('wc -l "/data/a.csv"')
  expect(w.procs[0]?.env).toMatchObject({ FLOW_INPUT_CSV: '/data/a.csv' })
  expect(w.runFile('needs', id).inputs).toEqual({ csv: '/data/a.csv' })
  w.procs[0]?.finish(0)
})

test('an interrupted run loads as interrupted; a waiting approval still waits', async ($, on) => {
  const wf = (steps: object[]) => JSON.stringify({ id: 'par', title: 'Par', description: '', owner: '', tags: [], env: [], inputs: [], steps, outputs: [] })
  const step = (id: string, kind: string, after: string[] = []) => ({ id, title: id, kind, body: 'x', cwd: '', after, timeoutSec: 600, continueOnFail: false })
  const stepRun = (id: string, status: string) => ({ id, status, output: '', tail: '' })
  const oldRun = (id: string, status: string, steps: object[]) =>
    JSON.stringify({ id, workflowId: 'par', title: 'Par', workflowDir: `${FLOWS}/par`, dir: `${RUNS}/par/${id}`, inputs: {}, status, startedAt: 1, steps })

  const lost = '20261027-101010-abcd'
  const gated = '20261027-111111-efgh'
  const w = world(on, {
    files: {
      [`${FLOWS}/par/flow.yaml`]: PARALLEL,
      [`${RUNS}/par/${lost}/run.json`]: oldRun(lost, 'running', [stepRun('a', 'done'), stepRun('b', 'running'), stepRun('c', 'running'), stepRun('d', 'waiting'), stepRun('e', 'pending')]),
      [`${RUNS}/par/${lost}/workflow.json`]: wf([step('a', 'run'), step('b', 'run'), step('c', 'agent'), step('d', 'claude'), step('e', 'run', ['b'])]),
      [`${RUNS}/par/${gated}/run.json`]: oldRun(gated, 'waiting', [stepRun('ok', 'waiting'), stepRun('next', 'pending')]),
      [`${RUNS}/par/${gated}/workflow.json`]: wf([step('ok', 'approve'), step('next', 'run', ['ok'])]),
    },
  })
  await begin($)

  expect(w.runFile('par', lost).status).toBe('interrupted')
  expect(w.stepsOf('par', lost)).toEqual({ a: 'done', b: 'interrupted', c: 'interrupted', d: 'interrupted', e: 'pending' })
  expect(w.runFile('par', gated).status).toBe('waiting')
  expect(w.stepsOf('par', gated)).toEqual({ ok: 'waiting', next: 'pending' })

  const status = (await $.tool.call({ tool: 'mcp__flow__run_status', run: lost } as never)) as { result: string }
  expect(status.result).toContain(': interrupted')
  expect(status.result).toContain('- b: interrupted')

  const waiting = (await $.tool.call({ tool: 'mcp__flow__run_status', run: gated } as never)) as { result: string }
  expect(waiting.result).toContain(': waiting\n')
  expect(waiting.result).toContain('- ok: waiting')
})

test('list_workflows and validate_workflow', async ($, on) => {
  world(on, {
    files: {
      [`${FLOWS}/par/flow.yaml`]: PARALLEL,
      [`${FLOWS}/broken/flow.yaml`]: 'title: Broken\nsteps:\n  - id: a\n    run: ls\n    after: [zzz]\n',
      '/repo/.flows/par/flow.yaml': PARALLEL,
    },
  })
  await begin($)
  const listed = (await $.tool.call({ tool: 'mcp__flow__list_workflows' } as never)) as { result: string }
  const list = JSON.parse(listed.result) as { id: string; errors: string[]; steps: { id: string }[] }[]
  expect(list.map(f => f.id)).toEqual(['broken', 'par', 'par'])
  expect(list[0]?.errors).toEqual(['steps[0].after: no step "zzz"'])
  expect(list[1]?.steps.map(s => s.id)).toEqual(['a', 'b', 'c'])
  // The project's copy has the same id: it gets the error.
  expect(list[2]?.errors).toEqual([`id: "par" is already used by ${FLOWS}/par/flow.yaml`])

  const ok = (await $.tool.call({ tool: 'mcp__flow__validate_workflow', path: `${FLOWS}/par` } as never)) as { result: string }
  expect(ok.result).toBe('valid\n1. a, b\n2. c')
  const bad = (await $.tool.call({ tool: 'mcp__flow__validate_workflow', path: `${FLOWS}/broken/flow.yaml` } as never)) as { result: string }
  expect(bad.result).toBe('steps[0].after: no step "zzz"')
})

// ---------------------------------------------------------------------------
// if:, retry:, outputs:, for_each:, wait:, uses:, filters and decide_step

const call = async ($: Engine, tool: string, input: Record<string, unknown>) => ((await $.tool.call({ tool: `mcp__flow__${tool}`, ...input } as never)) as { result: string }).result

test('if: a false condition skips the step without blocking what waits on it', async ($, on) => {
  const w = world(on, {
    files: {
      [`${FLOWS}/cond/flow.yaml`]: `
title: Cond
inputs:
  - id: go
    default: "no"
steps:
  - id: a
    run: echo a
  - id: b
    if: inputs.go == 'yes'
    run: echo b
  - id: c
    run: echo c
  - id: d
    after: [a]
    if: steps.a.output == "A" && steps.a.exit == 0 && !(inputs.go != 'no')
    run: echo d
`,
    },
  })
  await begin($)
  const id = await start($, 'cond')
  await w.clock.settle()
  w.procs[0]?.finish(0, 'A\n')
  await w.clock.settle()
  expect(w.procs.map(p => p.command)).toEqual(['echo a', 'echo c', 'echo d'])
  expect(w.runFile('cond', id).steps.find(s => s.id === 'b')).toMatchObject({ status: 'skipped', reason: 'condition' })
  w.procs[1]?.finish(0)
  w.procs[2]?.finish(0)
  await w.clock.settle()
  expect(w.stepsOf('cond', id)).toEqual({ a: 'done', b: 'skipped', c: 'done', d: 'done' })
  expect(w.runFile('cond', id).status).toBe('done')
  expect(await call($, 'run_status', { run: id })).toContain("- b: skipped (its if: was false)")
})

test('if: always() and failure() run after a failure; other skips still block', async ($, on) => {
  const w = world(on, {
    files: {
      [`${FLOWS}/always/flow.yaml`]: `
title: Always
steps:
  - id: a
    run: exit 1
  - id: b
    run: echo b
  - id: cleanup
    if: always()
    run: echo cleanup
  - id: on_fail
    after: [a]
    if: failure()
    run: echo on_fail
  - id: on_ok
    after: [a]
    if: "!failure()"
    run: echo on_ok
  - id: after_skip
    after: [b]
    run: echo after_skip
`,
    },
  })
  await begin($)
  const id = await start($, 'always')
  await w.clock.settle()
  w.procs[0]?.finish(1)
  await w.clock.settle()
  // b was skipped (a failed): cleanup runs anyway, after_skip does not; on_ok's !failure() is false.
  expect(w.procs.map(p => p.command)).toEqual(['exit 1', 'echo cleanup', 'echo on_fail'])
  const steps = w.runFile('always', id).steps
  expect(steps.find(s => s.id === 'b')).toMatchObject({ status: 'skipped' })
  expect(steps.find(s => s.id === 'b')?.reason).toBeUndefined()
  expect(steps.find(s => s.id === 'after_skip')).toMatchObject({ status: 'skipped' })
  expect(steps.find(s => s.id === 'on_ok')).toMatchObject({ status: 'skipped', reason: 'condition' })
  w.procs[1]?.finish(0)
  w.procs[2]?.finish(0)
  await w.clock.settle()
  expect(w.stepsOf('always', id)).toEqual({ a: 'failed', b: 'skipped', cleanup: 'done', on_fail: 'done', on_ok: 'skipped', after_skip: 'skipped' })
  expect(w.runFile('always', id).status).toBe('failed')
})

test('retry: a failed attempt runs again after the delay, and succeeds on the second', async ($, on) => {
  const w = world(on, { files: { [`${FLOWS}/flaky/flow.yaml`]: 'title: Flaky\nsteps:\n  - id: get\n    run: ./fetch.sh\n    retry: 2\n    retry_delay: 5\n  - id: next\n    run: echo next\n' } })
  await begin($)
  const id = await start($, 'flaky')
  await w.clock.settle()
  w.procs[0]?.finish(1, '', 'network down\n')
  await w.clock.settle()
  expect(w.runFile('flaky', id).steps[0]).toMatchObject({ status: 'running', attempt: 1, error: 'exited with code 1' })
  await w.clock.advance(4_000)
  expect(w.procs.length).toBe(1)
  await w.clock.advance(1_000)
  expect(w.procs.length).toBe(2)
  expect(w.runFile('flaky', id).steps[0]).toMatchObject({ status: 'running', attempt: 2 })
  w.procs[1]?.finish(0, 'ok\n')
  await w.clock.settle()
  const step = w.runFile('flaky', id).steps[0]
  expect(step).toMatchObject({ status: 'done', attempt: 2, output: 'ok', exitCode: 0 })
  expect(step?.error).toBeUndefined()
  const log = w.files.get(`${RUNS}/flaky/${id}/get.log`) ?? ''
  expect(log).toContain('--- attempt 1 of 3 failed (exited with code 1); trying again in 5s ---')
  expect(log).toContain('--- attempt 2 of 3 ---')
  expect(w.procs[2]?.command).toBe('echo next')
  w.procs[2]?.finish(0)
})

// Cancelling (cancelRun, the hub's) is not reachable from a test: see the note above the approve test.
test('retry: a timeout counts as an attempt, and the last failure fails the step', async ($, on) => {
  const w = world(on, {
    files: {
      [`${FLOWS}/slowretry/flow.yaml`]: 'title: Slow\nsteps:\n  - id: s\n    run: sleep 100\n    timeout: 2\n    retry: 1\n    retry_delay: 1\n',
    },
  })
  await begin($)
  const slow = await start($, 'slowretry')
  await w.clock.advance(2_000)
  expect(w.runFile('slowretry', slow).steps[0]).toMatchObject({ status: 'running', attempt: 1, error: 'timed out after 2s' })
  await w.clock.advance(1_000)
  expect(w.procs.length).toBe(2)
  await w.clock.advance(2_000)
  expect(w.runFile('slowretry', slow).steps[0]).toMatchObject({ status: 'failed', attempt: 2, error: 'timed out after 2s' })
  expect(w.runFile('slowretry', slow).status).toBe('failed')
  expect(await call($, 'run_status', { run: slow })).toContain('- s: failed (attempt 2, timed out after 2s)')
  w.procs[0]?.finish(0)
  w.procs[1]?.finish(0)
})

test('outputs: a missing output fails the step; files and dir fill in', async ($, on) => {
  const w = world(on, {
    files: {
      [`${FLOWS}/arts/flow.yaml`]: `
title: Arts
steps:
  - id: make
    run: make-report
    outputs: [report.md, data/rows.csv]
    after: []
  - id: forgets
    run: forget
    outputs: [nothing.md]
    after: []
  - id: use
    after: [make]
    run: cat {{steps.make.files | sh}}; ls {{steps.make.dir}}
`,
    },
  })
  await begin($)
  const id = await start($, 'arts')
  await w.clock.settle()
  const dir = `${RUNS}/arts/${id}`
  w.files.set(`${dir}/report.md`, '# r')
  w.files.set(`${dir}/data/rows.csv`, 'a,b')
  w.procs[0]?.finish(0)
  w.procs[1]?.finish(0)
  await w.clock.settle()
  expect(w.runFile('arts', id).steps.find(s => s.id === 'forgets')).toMatchObject({ status: 'failed', error: 'missing output nothing.md' })
  expect(w.runFile('arts', id).steps.find(s => s.id === 'make')).toMatchObject({ status: 'done' })
  expect(w.procs[2]?.command).toBe(`cat '${dir}/report.md\n${dir}/data/rows.csv'; ls ${dir}`)
  w.procs[2]?.finish(0)
  await w.clock.settle()
  expect(w.runFile('arts', id).status).toBe('failed')
})

test('for_each: three items, at most max_parallel at once, one failing with continue_on_fail', async ($, on) => {
  const w = world(on, {
    files: {
      [`${FLOWS}/each/flow.yaml`]: `
title: Each
inputs:
  - id: clients
    type: textarea
steps:
  - id: report
    for_each: "{{inputs.clients}}"
    as: client
    max_parallel: 2
    continue_on_fail: true
    run: ./report.sh {{client | sh}} {{item_index}} > "{{run.dir}}/{{item}}.txt"
  - id: none
    for_each: []
    run: echo never
    after: []
  - id: summary
    after: [report]
    run: echo summary
`,
    },
  })
  await begin($)
  const id = await start($, 'each', { clients: 'acme, beta\ngamma\n' })
  await w.clock.settle()
  const dir = `${RUNS}/each/${id}`
  expect(w.procs.map(p => p.command)).toEqual([`./report.sh 'acme' 0 > "${dir}/acme.txt"`, `./report.sh 'beta' 1 > "${dir}/beta.txt"`])
  expect(w.procs[1]?.env).toMatchObject({ FLOW_ITEM: 'beta', FLOW_ITEM_INDEX: '1' })
  expect(w.runFile('each', id).steps.find(s => s.id === 'none')).toMatchObject({ status: 'done', output: '[]' })
  let step = w.runFile('each', id).steps[0]
  expect(step?.status).toBe('running')
  expect(step?.items?.map(i => [i.value, i.status])).toEqual([
    ['acme', 'running'],
    ['beta', 'running'],
    ['gamma', 'pending'],
  ])

  w.procs[1]?.finish(3, 'half\n')
  await w.clock.settle()
  expect(w.procs[2]?.command).toBe(`./report.sh 'gamma' 2 > "${dir}/gamma.txt"`)
  w.procs[0]?.finish(0, 'A\n')
  w.procs[2]?.finish(0, 'G\n')
  await w.clock.settle()

  step = w.runFile('each', id).steps[0]
  expect(step).toMatchObject({ status: 'failed', error: '1 of 3 items failed', output: '["A","half","G"]' })
  expect(step?.items?.[1]).toMatchObject({ value: 'beta', status: 'failed', exitCode: 3, output: 'half', attempt: 1 })
  expect(w.files.get(`${dir}/report[1].log`)).toBe('half\n')
  // continue_on_fail: the step after still runs ({{steps.report.output}} is a done step's only, as for any step).
  expect(w.procs[3]?.command).toBe('echo summary')
  w.procs[3]?.finish(0)
  await w.clock.settle()
  expect(w.runFile('each', id).status).toBe('failed')
  const status = await call($, 'run_status', { run: id })
  expect(status).toContain('- report: failed (1 of 3 items failed)\n  [0] acme: done\n  [1] beta: failed (exited with code 3)\n  [2] gamma: done')
})

test('wait: polls for a file on timers until it appears', async ($, on) => {
  const w = world(on, {
    files: {
      [`${FLOWS}/waits/flow.yaml`]: `
title: Waits
steps:
  - id: ready
    wait:
      file: "{{run.dir}}/ready.flag"
    interval: 5
  - id: go
    run: echo go
  - id: late
    after: []
    wait: { file: never.flag, interval: 5 }
    timeout: 12
`,
    },
  })
  await begin($)
  const id = await start($, 'waits')
  await w.clock.settle()
  const dir = `${RUNS}/waits/${id}`
  expect(w.stepsOf('waits', id)).toEqual({ ready: 'running', go: 'pending', late: 'running' })
  await w.clock.advance(5_000)
  expect(w.stepsOf('waits', id).ready).toBe('running')
  w.files.set(`${dir}/ready.flag`, '')
  await w.clock.advance(4_000)
  expect(w.stepsOf('waits', id).ready).toBe('running')
  await w.clock.advance(1_000)
  expect(w.runFile('waits', id).steps[0]).toMatchObject({ status: 'done', output: `${dir}/ready.flag` })
  expect(w.procs[0]?.command).toBe('echo go')
  w.procs[0]?.finish(0)
  await w.clock.advance(2_000)
  expect(w.runFile('waits', id).steps[2]).toMatchObject({ status: 'failed', error: 'timed out after 12s' })
  expect(w.runFile('waits', id).status).toBe('failed')
})

test('uses: runs a child workflow, and the parent step follows it', async ($, on) => {
  const w = world(on, {
    files: {
      [`${FLOWS}/parent/flow.yaml`]: `
title: Parent
inputs:
  - id: who
    default: Ann
steps:
  - id: sub
    uses: child
    with:
      name: "{{inputs.who}} B"
  - id: show
    run: ls {{steps.sub.dir | sh}}
`,
      [`${FLOWS}/child/flow.yaml`]: `
title: Child
inputs:
  - id: name
steps:
  - id: hello
    run: echo {{inputs.name | sh}}
`,
    },
  })
  await begin($)
  const id = await start($, 'parent')
  await w.clock.settle()
  const parent = w.runFile('parent', id)
  const childId = parent.steps[0]?.childRun ?? ''
  expect(parent.steps[0]).toMatchObject({ status: 'running' })
  expect(childId).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/)
  const child = w.runFile('child', childId)
  expect(child).toMatchObject({ parent: { run: id, step: 'sub' }, inputs: { name: 'Ann B' }, status: 'running' })
  expect(w.procs[0]?.command).toBe("echo 'Ann B'")

  w.procs[0]?.finish(0, 'Ann B\n')
  await w.clock.settle()
  const childDir = `${RUNS}/child/${childId}`
  expect(w.runFile('child', childId).status).toBe('done')
  expect(w.runFile('parent', id).steps[0]).toMatchObject({ status: 'done', output: `${childId}\n${childDir}` })
  expect(w.procs[1]?.command).toBe(`ls '${childDir}'`)
  w.procs[1]?.finish(0)
  await w.clock.settle()
  expect(w.runFile('parent', id).status).toBe('done')
})

test('uses: a failed child fails the step; unknown with: inputs are refused', async ($, on) => {
  const w = world(on, {
    files: {
      [`${FLOWS}/p2/flow.yaml`]: 'title: P2\nsteps:\n  - id: sub\n    uses: c2\n  - id: next\n    run: echo next\n',
      [`${FLOWS}/c2/flow.yaml`]: 'title: C2\nsteps:\n  - id: work\n    run: work\n',
      [`${FLOWS}/p3/flow.yaml`]: 'title: P3\nsteps:\n  - id: sub\n    uses: c2\n    with: { nope: x }\n',
    },
  })
  await begin($)
  const id = await start($, 'p2')
  await w.clock.settle()
  const childId = w.runFile('p2', id).steps[0]?.childRun ?? ''
  w.procs[0]?.finish(1)
  await w.clock.settle()
  expect(w.runFile('p2', id).steps[0]).toMatchObject({ status: 'failed', error: `run ${childId} of c2 failed` })
  expect(w.stepsOf('p2', id)).toEqual({ sub: 'failed', next: 'skipped' })

  const again = await start($, 'p2')
  await w.clock.settle()
  const child2 = w.runFile('p2', again).steps[0]?.childRun ?? ''
  const { result } = (await $.tool.call({ tool: 'mcp__flow__run_status', run: child2 } as never)) as { result: string }
  expect(result).toContain(`Started by run ${again}, step sub`)
  w.procs[1]?.finish(0)
  await w.clock.settle()
  expect(w.runFile('p2', again).status).toBe('running')
  w.procs[2]?.finish(0)
  await w.clock.settle()

  const bad = await start($, 'p3')
  await w.clock.settle()
  expect(w.runFile('p3', bad).steps[0]).toMatchObject({ status: 'failed', error: 'c2 did not start: with.nope: c2 has no input "nope"' })
})

test('uses: refuses nesting deeper than 3 and a workflow already in the chain', async ($, on) => {
  const chain = (id: string, next: string) => [`${FLOWS}/${id}/flow.yaml`, `title: ${id}\nsteps:\n  - id: sub\n    uses: ${next}\n`]
  const w = world(on, {
    files: Object.fromEntries([
      chain('l0', 'l1'),
      chain('l1', 'l2'),
      chain('l2', 'l3'),
      chain('l3', 'l4'),
      [`${FLOWS}/l4/flow.yaml`, 'title: l4\nsteps:\n  - id: a\n    run: echo deep\n'],
      chain('x', 'y'),
      chain('y', 'x'),
    ]),
  })
  await begin($)
  const id = await start($, 'l0')
  await w.clock.settle()
  expect(w.procs.length).toBe(0)
  const runs = [...w.files.keys()].filter(k => k.endsWith('/run.json')).map(k => JSON.parse(w.files.get(k) ?? '{}') as Run)
  const l3 = runs.find(r => r.workflowId === 'l3')
  expect(l3?.steps[0]).toMatchObject({ status: 'failed', error: 'refused: l0 → l1 → l2 → l3 → l4 nests deeper than 3' })
  expect(runs.some(r => r.workflowId === 'l4')).toBe(false)
  // The failure goes back up the chain.
  expect(w.runFile('l0', id).status).toBe('failed')
  expect(runs.find(r => r.workflowId === 'l1')?.status).toBe('failed')

  const x = await start($, 'x')
  await w.clock.settle()
  const all = [...w.files.keys()].filter(k => k.endsWith('/run.json')).map(k => JSON.parse(w.files.get(k) ?? '{}') as Run)
  expect(all.find(r => r.workflowId === 'y')?.steps[0]).toMatchObject({ status: 'failed', error: 'refused: x → y → x goes in a circle' })
  expect(w.runFile('x', x).status).toBe('failed')
})

test('| sh quotes a value for bash; | json makes a JSON string', async ($, on) => {
  const w = world(on, {
    files: { [`${FLOWS}/quote/flow.yaml`]: 'title: Quote\ninputs:\n  - id: msg\nsteps:\n  - id: say\n    run: printf %s {{inputs.msg | sh}} > out; echo {{ inputs.msg | json | sh }}\n' },
  })
  await begin($)
  await start($, 'quote', { msg: `it's $(rm -rf) "x"` })
  await w.clock.settle()
  expect(w.procs[0]?.command).toBe(`printf %s 'it'\\''s $(rm -rf) "x"' > out; echo '"it'\\''s $(rm -rf) \\"x\\""'`)
  w.procs[0]?.finish(0)
})

test('decide_step: approve goes on; reject fails the step and skips what follows', async ($, on) => {
  const gate = 'title: Gate\nsteps:\n  - id: ok\n    approve: Go on?\n  - id: write\n    run: echo written\n  - id: ask\n    after: []\n    claude: hi\n'
  const w = world(on, { files: { [`${FLOWS}/gate/flow.yaml`]: gate } })
  await begin($)
  const yes = await start($, 'gate')
  await w.clock.settle()
  expect(await call($, 'decide_step', { run: yes, step: 'ask', ok: true })).toBe('error: step "ask" is a claude step, not an approval (use complete_step)')
  expect(await call($, 'decide_step', { run: yes, step: 'ok', ok: true })).toBe(`Recorded: step "ok" approved. Run ${yes} is now running.`)
  await w.clock.settle()
  expect(w.runFile('gate', yes).steps[0]).toMatchObject({ status: 'done', output: 'approved' })
  expect(w.procs[0]?.command).toBe('echo written')
  w.procs[0]?.finish(0)
  await w.clock.settle()
  expect(w.stepsOf('gate', yes)).toEqual({ ok: 'done', write: 'done', ask: 'waiting' })
  expect(await call($, 'decide_step', { run: yes, step: 'ok', ok: true })).toBe('error: step "ok" is done, not waiting')

  const no = await start($, 'gate')
  await w.clock.settle()
  expect(await call($, 'decide_step', { run: no, step: 'ok', ok: false, output: 'Not today.' })).toContain('Recorded: step "ok" rejected.')
  await w.clock.settle()
  expect(w.runFile('gate', no).steps[0]).toMatchObject({ status: 'failed', output: 'Not today.', error: 'rejected' })
  expect(w.stepsOf('gate', no)).toEqual({ ok: 'failed', write: 'skipped', ask: 'waiting' })
  expect(w.procs.length).toBe(1)
})

// ---------------------------------------------------------------------------
// python:, mcp:, http:, {{env.NAME}}, JSON paths, AI vs fixed, cancel_run and step_log

test('python: a script file gets its args verbatim, one argv entry each, no shell', async ($, on) => {
  const w = world(on, {
    files: {
      [`${FLOWS}/py/scripts/summarize.py`]: 'print(1)\n',
      [`${FLOWS}/py/flow.yaml`]: `
title: Py
inputs:
  - id: msg
steps:
  - id: list
    python:
      file: scripts/summarize.py
      args: ["{{inputs.msg}}", "--out", "{{run.dir}}/stats.md"]
  - id: line
    after: []
    python:
      file: ./scripts/summarize.py
      interpreter: .venv/bin/python
      args: --title "{{inputs.msg}}" 'two words' plain
`,
    },
  })
  await begin($)
  const msg = `it's "a b" $(rm -rf x)`
  const id = await start($, 'py', { msg })
  await w.clock.settle()
  const dir = `${RUNS}/py/${id}`
  expect(w.procs.map(p => p.argv)).toEqual([
    ['python3', `${FLOWS}/py/scripts/summarize.py`, msg, '--out', `${dir}/stats.md`],
    [`${FLOWS}/py/.venv/bin/python`, `${FLOWS}/py/scripts/summarize.py`, '--title', msg, 'two words', 'plain'],
  ])
  expect(w.procs[0]?.cwd).toBe(`${FLOWS}/py`)
  expect(w.procs[0]?.env).toMatchObject({
    FLOW_RUN_DIR: dir,
    FLOW_INPUT_MSG: msg,
    PYTHONPATH: `${dir}/.flow`,
    FLOW_CONTEXT: `${dir}/.flow/list.context.json`,
    FLOW_OUTPUT: `${dir}/.flow/list.output.json`,
  })
  expect(w.files.get(`${dir}/.flow/flow.py`)).toContain('def set_output(self, value):')
  w.procs[0]?.finish(0, 'rows: 3\n', 'note\n')
  w.procs[1]?.finish(0, 'ok\n')
  await w.clock.settle()
  expect(w.runFile('py', id).steps[0]).toMatchObject({ status: 'done', output: 'rows: 3', exitCode: 0 })
  expect(w.files.get(`${dir}/list.log`)).toContain('rows: 3\nnote\n')
  expect(w.runFile('py', id).status).toBe('done')
})

test('python: inline code reads earlier steps through flow, and flow.set_output is the output', async ($, on) => {
  const code = 'from flow import flow\ncount = flow.steps["fetch"].json["count"]\nflow.set_output({"total": count * 2, "who": flow.inputs["who"]})\nprint("printed")\n'
  const w = world(on, {
    files: {
      [`${FLOWS}/inline/flow.yaml`]: `
title: Inline
inputs:
  - id: who
    default: Ann
steps:
  - id: fetch
    run: ./fetch.sh
  - id: double
    python: |
${code.split('\n').map(l => (l ? `      ${l}` : '')).join('\n')}
  - id: show
    run: echo {{steps.double.json.total}} {{steps.fetch.json.items[1].name | sh}} {{steps.fetch.json.items}}
`,
    },
  })
  await begin($)
  const id = await start($, 'inline')
  await w.clock.settle()
  const dir = `${RUNS}/inline/${id}`
  w.procs[0]?.finish(0, '{"count": 3, "items": [{"name": "a"}, {"name": "b c"}]}\n')
  await w.clock.settle()

  const proc = w.procs[1]
  expect(proc?.argv).toEqual(['python3', `${dir}/.flow/double.py`])
  expect(w.files.get(`${dir}/.flow/double.py`)).toBe(code)
  const context = JSON.parse(w.files.get(proc?.env?.FLOW_CONTEXT ?? '') ?? 'null') as Record<string, unknown>
  expect(context).toMatchObject({
    inputs: { who: 'Ann' },
    run_dir: dir,
    item: null,
    item_index: null,
    steps: {
      fetch: { status: 'done', json: { count: 3 }, exit: 0, dir, files: [] },
      double: { status: 'running', json: null },
    },
  })
  // What flow.set_output does: JSON in FLOW_OUTPUT.
  w.files.set(proc?.env?.FLOW_OUTPUT ?? '', '{"total": 6, "who": "Ann"}')
  proc?.finish(0, 'printed\n')
  await w.clock.settle()
  expect(w.runFile('inline', id).steps[1]).toMatchObject({ status: 'done', output: '{"total": 6, "who": "Ann"}' })
  expect(w.procs[2]?.command).toBe(`echo 6 'b c' [{"name":"a"},{"name":"b c"}]`)
  w.procs[2]?.finish(0)
  await w.clock.settle()
  expect(w.runFile('inline', id).status).toBe('done')
})

test('python: a missing requirement fails the step before it runs', async ($, on) => {
  const w = world(on, {
    packages: ['json'],
    files: {
      [`${FLOWS}/reqs/s.py`]: '',
      [`${FLOWS}/reqs/flow.yaml`]: 'title: Reqs\nsteps:\n  - id: s\n    python:\n      file: s.py\n      requirements: [json, pandas]\n  - id: next\n    run: echo next\n',
    },
  })
  await begin($)
  const id = await start($, 'reqs')
  await w.clock.settle()
  expect(w.runs.filter(a => a[1] === '-c' && a[0] === 'python3').map(a => a[2])).toEqual(['import json', 'import pandas'])
  expect(w.procs.length).toBe(0)
  expect(w.runFile('reqs', id).steps[0]).toMatchObject({ status: 'failed', error: 'missing Python package pandas (install it into python3)' })
  expect(w.stepsOf('reqs', id)).toEqual({ s: 'failed', next: 'skipped' })
})

test('mcp: calls the tool with deep-templated args; its text is the output and json works in if:', async ($, on) => {
  const w = world(on, {
    mcp: e => (e.tool === 'list-orders' ? { content: [{ type: 'text', text: '{"count": 2, "orders": [{"total": 40}]}' }], isError: false } : { content: [{ type: 'text', text: 'rate\nlimited' }], isError: true }),
    files: {
      [`${FLOWS}/shop/flow.yaml`]: `
title: Shop
inputs:
  - id: week
    default: "2026-10-26"
steps:
  - id: orders
    mcp:
      server: shopify
      tool: list-orders
      args: { since: "{{inputs.week}}", limit: 50, filter: { tags: ["{{inputs.week}}", x] } }
  - id: many
    if: steps.orders.json.count > 1 && steps.orders.json.orders[0].total == 40
    run: echo many
  - id: none
    after: [orders]
    if: steps.orders.json.count == 0
    run: echo none
  - id: broken
    after: []
    mcp: { server: shopify, tool: refund }
`,
    },
  })
  await begin($)
  const id = await start($, 'shop')
  await w.clock.settle()
  expect(w.mcpCalls).toEqual([
    { server: 'shopify', tool: 'list-orders', args: { since: '2026-10-26', limit: 50, filter: { tags: ['2026-10-26', 'x'] } } },
    { server: 'shopify', tool: 'refund', args: {} },
  ])
  const run = w.runFile('shop', id)
  expect(run.steps[0]).toMatchObject({ status: 'done', output: '{"count": 2, "orders": [{"total": 40}]}' })
  expect(run.steps[3]).toMatchObject({ status: 'failed', error: 'rate limited', output: 'rate\nlimited' })
  expect(w.procs.map(p => p.command)).toEqual(['echo many'])
  expect(run.steps[2]).toMatchObject({ status: 'skipped', reason: 'condition' })
  w.procs[0]?.finish(0)
  await w.clock.settle()
  expect(w.runFile('shop', id).status).toBe('failed')
})

// A hook that throws is skipped by the kit, so $.mcp.call rejects with the kit's own message.
test('mcp: a rejected call fails the step; past its timeout it fails and a late answer is ignored', async ($, on) => {
  let answer: (r: McpResult) => void = () => undefined
  const w = world(on, {
    mcp: e => {
      if (e.tool === 'boom') throw new Error('server shopify is not connected')
      return new Promise<McpResult>(resolve => (answer = resolve))
    },
    files: { [`${FLOWS}/slowmcp/flow.yaml`]: 'title: Slow\nsteps:\n  - id: slow\n    mcp: { server: s, tool: wait }\n    timeout: 5\n  - id: boom\n    after: []\n    mcp: { server: s, tool: boom }\n' },
  })
  await begin($)
  const id = await start($, 'slowmcp')
  await w.clock.settle()
  expect(w.runFile('slowmcp', id).steps[1]).toMatchObject({ status: 'failed' })
  expect(w.runFile('slowmcp', id).steps[1]?.error).toContain('no implementation for mcp.call')
  await w.clock.advance(5_000)
  expect(w.runFile('slowmcp', id).steps[0]).toMatchObject({ status: 'failed', error: 'timed out after 5s' })
  answer({ content: [{ type: 'text', text: 'late' }], isError: false })
  await w.clock.settle()
  expect(w.runFile('slowmcp', id).steps[0]).toMatchObject({ status: 'failed', error: 'timed out after 5s', output: '' })
})

const HTTP = `
title: Http
env: [SHOP_TOKEN]
inputs:
  - id: week
    default: "2026-10-26"
steps:
  - id: get
    http:
      url: "https://api.example.com/orders?since={{inputs.week}}&key={{env.SHOP_TOKEN}}"
      headers: { Authorization: "Bearer {{env.SHOP_TOKEN}}" }
  - id: post
    after: []
    http:
      method: post
      url: https://api.example.com/notes
      body: { week: "{{inputs.week}}", n: 2 }
      expect: [201]
`

test('http: a request with {{env.X}} sends the value and logs ***; a status outside expect fails', async ($, on) => {
  const secret = 'sekret-123'
  const w = world(on, {
    env: { SHOP_TOKEN: secret },
    http: e =>
      e.url.includes('/orders')
        ? { status: 200, ok: true, headers: {}, text: `{"count": 1, "echo": "${secret}"}` }
        : { status: 404, ok: false, headers: {}, text: `not found: ${'x'.repeat(400)}` },
    files: { [`${FLOWS}/http/flow.yaml`]: HTTP },
  })
  await begin($)
  const id = await start($, 'http')
  await w.clock.settle()
  const dir = `${RUNS}/http/${id}`
  expect(w.httpCalls.find(c => c.url.includes('/orders'))).toEqual({
    url: `https://api.example.com/orders?since=2026-10-26&key=${secret}`,
    init: { method: 'GET', headers: { Authorization: `Bearer ${secret}` } },
  })
  expect(w.httpCalls.find(c => c.url.includes('/notes'))).toEqual({
    url: 'https://api.example.com/notes',
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"week":"2026-10-26","n":2}' },
  })
  // Read once with printf, never by the shell of a step.
  expect(w.runs.filter(a => a[2] === 'printf %s "${!1}"').map(a => a[4])).toEqual(['SHOP_TOKEN'])

  const run = w.runFile('http', id)
  expect(run.steps[0]).toMatchObject({ status: 'done', output: '{"count": 1, "echo": "***"}' })
  expect(run.steps[1]?.status).toBe('failed')
  expect(run.steps[1]?.error).toBe(`HTTP 404 (expected 201): not found: ${'x'.repeat(289)}`)
  const log = w.files.get(`${dir}/get.log`) ?? ''
  expect(log).toBe('GET https://api.example.com/orders?since=2026-10-26&key=***\nHTTP 200\n{"count": 1, "echo": "***"}\n')
  for (const [path, text] of w.files) if (path.startsWith(dir)) expect(text.includes(secret)).toBe(false)
  expect(await call($, 'step_log', { run: id, step: 'get' })).not.toContain(secret)
})

test('mcp and python: {{env.X}} works in args and is redacted from the output', async ($, on) => {
  const w = world(on, {
    env: { API_KEY: 'k-777' },
    mcp: e => ({ content: [{ type: 'text', text: `used ${String(e.args.key)}` }], isError: false }),
    files: {
      [`${FLOWS}/envs/s.py`]: '',
      [`${FLOWS}/envs/flow.yaml`]: 'title: Envs\nenv: [API_KEY]\nsteps:\n  - id: m\n    mcp: { server: s, tool: t, args: { key: "{{env.API_KEY}}" } }\n  - id: p\n    python: { file: s.py, args: ["--key={{env.API_KEY}}"] }\n',
    },
  })
  await begin($)
  const id = await start($, 'envs')
  await w.clock.settle()
  expect(w.mcpCalls[0]?.args).toEqual({ key: 'k-777' })
  expect(w.runFile('envs', id).steps[0]).toMatchObject({ status: 'done', output: 'used ***' })
  expect(w.procs[0]?.argv).toEqual(['python3', `${FLOWS}/envs/s.py`, '--key=k-777'])
  w.procs[0]?.finish(0, 'k-777 done\n')
  await w.clock.settle()
  expect(w.runFile('envs', id).steps[1]).toMatchObject({ status: 'done', output: '*** done' })
  expect(w.files.get(`${RUNS}/envs/${id}/p.log`)).toBe(`$ python3 ${FLOWS}/envs/s.py --key=***\n*** done\n`)
})

test('list_workflows marks agent and claude steps as AI and counts both kinds', async ($, on) => {
  world(on, {
    files: {
      [`${FLOWS}/mixed/flow.yaml`]: `
title: Mixed
steps:
  - id: a
    run: echo a
  - id: b
    python: print(1)
  - id: c
    agent: light
    prompt: Sum it up.
  - id: d
    approve: Ok?
  - id: e
    claude: Write the note.
`,
    },
  })
  await begin($)
  const list = JSON.parse(await call($, 'list_workflows', {})) as { id: string; aiSteps: number; fixedSteps: number; steps: { id: string; kind: string; isAI: boolean }[] }[]
  const mixed = list.find(f => f.id === 'mixed')
  expect(mixed?.steps.map(s => [s.id, s.kind, s.isAI])).toEqual([
    ['a', 'run', false],
    ['b', 'python', false],
    ['c', 'agent', true],
    ['d', 'approve', false],
    ['e', 'claude', true],
  ])
  expect([mixed?.aiSteps, mixed?.fixedSteps]).toEqual([2, 3])
})

test('cancel_run: a step waiting to retry never tries again', async ($, on) => {
  const w = world(on, { files: { [`${FLOWS}/flaky/flow.yaml`]: 'title: Flaky\nsteps:\n  - id: get\n    run: ./fetch.sh\n    retry: 3\n    retry_delay: 5\n  - id: next\n    run: echo next\n' } })
  await begin($)
  const id = await start($, 'flaky')
  await w.clock.settle()
  w.procs[0]?.finish(1)
  await w.clock.settle()
  expect(w.runFile('flaky', id).steps[0]).toMatchObject({ status: 'running', attempt: 1 })
  expect(await call($, 'cancel_run', { run: id })).toContain(`Cancelled run ${id}.`)
  await w.clock.advance(30_000)
  expect(w.procs.length).toBe(1)
  expect(w.stepsOf('flaky', id)).toEqual({ get: 'cancelled', next: 'skipped' })
  expect(w.runFile('flaky', id).status).toBe('cancelled')
  expect(await call($, 'cancel_run', { run: id })).toBe(`error: run ${id} is already cancelled`)
  expect(await call($, 'cancel_run', { run: 'nope' })).toBe('error: no run nope')
})

test('cancel_run: cancelling a parent cancels the child run its uses step started', async ($, on) => {
  const w = world(on, {
    files: {
      [`${FLOWS}/parent/flow.yaml`]: 'title: Parent\nsteps:\n  - id: sub\n    uses: child\n  - id: after\n    run: echo after\n',
      [`${FLOWS}/child/flow.yaml`]: 'title: Child\nsteps:\n  - id: work\n    run: sleep 100\n  - id: more\n    run: echo more\n',
    },
  })
  await begin($)
  const id = await start($, 'parent')
  await w.clock.settle()
  const childId = w.runFile('parent', id).steps[0]?.childRun ?? ''
  expect(w.stepsOf('child', childId)).toEqual({ work: 'running', more: 'pending' })
  await call($, 'cancel_run', { run: id })
  await w.clock.settle()
  expect(w.runFile('parent', id).status).toBe('cancelled')
  expect(w.stepsOf('parent', id)).toEqual({ sub: 'cancelled', after: 'skipped' })
  expect(w.runFile('child', childId).status).toBe('cancelled')
  expect(w.stepsOf('child', childId)).toEqual({ work: 'cancelled', more: 'skipped' })
  w.procs[0]?.finish(0, 'late\n')
  await w.clock.settle()
  expect(w.runFile('child', childId).steps[0]).toMatchObject({ status: 'cancelled', output: '' })
  expect(w.procs.length).toBe(1)
})

test('step_log: the full log and the output of a step or an item', async ($, on) => {
  const w = world(on, {
    files: { [`${FLOWS}/logs/flow.yaml`]: 'title: Logs\nsteps:\n  - id: one\n    run: ./one.sh\n  - id: each\n    for_each: [a, b]\n    run: echo {{item}}\n' },
  })
  await begin($)
  const id = await start($, 'logs')
  await w.clock.settle()
  w.procs[0]?.finish(0, 'result\n', 'progress 50%\n')
  await w.clock.settle()
  w.procs[1]?.finish(0, 'A\n')
  w.procs[2]?.finish(4, '', 'bad b\n')
  await w.clock.settle()
  const dir = `${RUNS}/logs/${id}`
  expect(await call($, 'step_log', { run: id, step: 'one' })).toBe(
    `Step one of run ${id} (run, fixed): done (exit 0)\nLog file: ${dir}/one.log\n--- output ---\nresult\n--- log ---\nresult\nprogress 50%\n`,
  )
  expect(await call($, 'step_log', { run: id, step: 'each', item: 1 })).toBe(
    `Step each item [1] (b) of run ${id} (run, fixed): failed (exit 4, exited with code 4)\nLog file: ${dir}/each[1].log\n--- output ---\n(none)\n--- log ---\nbad b\n`,
  )
  expect(await call($, 'step_log', { run: id, step: 'each', item: 5 })).toBe('error: step "each" has no item 5 (items 0 to 1)')
  expect(await call($, 'step_log', { run: id, step: 'ghost' })).toBe(`error: run ${id} has no step "ghost" (steps: one, each)`)
})

test('model: one prompt with files attached; the answer is the output and is written', async ($, on) => {
  const w = world(on, {
    files: {
      [`${FLOWS}/ask/flow.yaml`]: `title: Ask
steps:
  - id: make
    run: echo stats
  - id: insights
    model:
      prompt: "Write insights for {{steps.make.output}}."
      files: ["{{run.dir}}/stats.md"]
      write: "{{run.dir}}/insights.md"
      use: haiku
      max_tokens: 800
  - id: session
    after: []
    model: { prompt: Hello }
`,
    },
  })
  await begin($)
  const id = await start($, 'ask')
  await w.clock.settle()
  const dir = `${RUNS}/ask/${id}`
  w.files.set(`${dir}/stats.md`, '| a | 1 |')
  w.procs[0]?.finish(0, 'stats\n')
  await w.clock.settle()
  const run = w.runFile('ask', id)
  expect(run.steps[1]).toMatchObject({ status: 'done', output: 'answer to: Write insights for stats.' })
  expect(run.steps[2]).toMatchObject({ status: 'done' })
  const call = w.modelCalls.find(c => c.model === 'haiku')
  expect(call?.maxTokens).toBe(800)
  expect(call?.prompt).toContain(`<file path="${dir}/stats.md">\n| a | 1 |\n</file>`)
  expect(w.modelCalls.find(c => c.prompt === 'Hello')?.model).toBe('claude-opus-5-5')
  expect(w.files.get(`${dir}/insights.md`)).toBe('answer to: Write insights for stats.\n')
})

test('model: a missing file or an API error fails the step', async ($, on) => {
  const w = world(on, {
    model: e => (e.prompt.startsWith('boom') ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' } : undefined),
    files: {
      [`${FLOWS}/askfail/flow.yaml`]: `title: Ask fail
steps:
  - id: nofile
    model: { prompt: read it, files: ["{{run.dir}}/missing.md"] }
  - id: api
    after: []
    model: { prompt: boom }
`,
    },
  })
  await begin($)
  const id = await start($, 'askfail')
  await w.clock.settle()
  const run = w.runFile('askfail', id)
  expect(run.steps[0]?.error).toContain('model.files: no file at')
  expect(run.steps[1]).toMatchObject({ status: 'failed', error: 'the API answered with an error (529)' })
})

// ---------------------------------------------------------------------------
// sources: other folders of workflows, cloned and pulled from git

const TEAM = `${HOME}/.flow/sources/team`
const SOURCES = `groups:
  - title: Mine
    workflows: [par, mrs]
sources:
  - name: team
    title: Team
    git: git@gitlab.com:org/flows.git
`

test('sources: a missing source is cloned once, its workflows load with its name and its groups', async ($, on) => {
  const w = world(on, {
    files: { [`${FLOWS}/flows.yaml`]: SOURCES, [`${FLOWS}/par/flow.yaml`]: PARALLEL },
    git: argv =>
      argv[1] === 'clone'
        ? {
            files: {
              [`${TEAM}/.git/HEAD`]: 'ref: refs/heads/main',
              [`${TEAM}/mrs/flow.yaml`]: PARALLEL.replace('Parallel', 'MRs'),
              [`${TEAM}/dash/flow.yaml`]: PARALLEL.replace('Parallel', 'Dash'),
              [`${TEAM}/flows.yaml`]: 'groups:\n  - title: Reports\n    workflows: [dash]\n',
            },
          }
        : {},
  })
  await begin($)
  const clones = w.runs.filter(a => a[0] === 'git')
  expect(clones).toEqual([['git', 'clone', '--quiet', 'git@gitlab.com:org/flows.git', TEAM]])
  const list = JSON.parse(await call($, 'list_workflows', {})) as { id: string; source?: string }[]
  expect(list.map(f => [f.id, f.source ?? ''])).toEqual([['par', ''], ['dash', 'team'], ['mrs', 'team']])
  // Listing again reads the clone; it does not clone again.
  expect(w.runs.filter(a => a[0] === 'git').length).toBe(1)

  // A source workflow runs from its own folder.
  const id = await start($, 'mrs')
  expect(w.runFile('mrs', id).workflowDir).toBe(`${TEAM}/mrs`)
})

test('sources: pull_sources fast-forwards a clone and names a failure', async ($, on) => {
  let fail = false
  const w = world(on, {
    files: { [`${FLOWS}/flows.yaml`]: SOURCES, [`${TEAM}/.git/HEAD`]: 'x', [`${TEAM}/mrs/flow.yaml`]: PARALLEL },
    git: () => (fail ? { exitCode: 1, stderr: 'hint: x\nfatal: Not possible to fast-forward, aborting.' } : {}),
  })
  await begin($)
  expect(await call($, 'pull_sources', {})).toBe(`Team: pulled (${TEAM})`)
  expect(w.runs.filter(a => a[0] === 'git').at(-1)).toEqual(['git', 'pull', '--ff-only', '--quiet'])
  fail = true
  expect(await call($, 'pull_sources', {})).toBe(`Team: failed: fatal: Not possible to fast-forward, aborting. (${TEAM})`)

})

test('mcp: a server no Claude Code config sets up refuses the run and points at the source README', async ($, on) => {
  const wf = 'title: Dash\nsteps:\n  - id: c\n    mcp: { server: team, tool: get_client }\n  - id: g\n    mcp: { server: claude.ai Gmail, tool: send }\n'
  const w = world(on, {
    files: {
      [`${FLOWS}/flows.yaml`]: SOURCES,
      [`${TEAM}/.git/HEAD`]: 'x',
      [`${TEAM}/dash/flow.yaml`]: wf,
      [`${HOME}/.claude.json`]: JSON.stringify({ mcpServers: { other: {} }, projects: {} }),
    },
  })
  await begin($)
  const refused = (await $.tool.call({ tool: 'mcp__flow__run_workflow', id: 'dash' } as never)) as { result: string }
  expect(refused.result).toContain(`MCP server "team" is not set up in Claude Code on this Mac (see the setup notes in ${TEAM}/README.md)`)
  expect(refused.result).not.toContain('Gmail')
  // Set up in this project's local scope: it starts.
  w.files.set(`${HOME}/.claude.json`, JSON.stringify({ mcpServers: {}, projects: { '/repo': { mcpServers: { 'team': {} } } } }))
  await start($, 'dash')
})

// ---------------------------------------------------------------------------
// views: view.yaml beside workflows, searched and opened through MCP

const PEOPLE = `
title: People
search: { placeholder: Name }
filters:
  - { id: active, label: Active, args: { active: true } }
list:
  mcp: { server: crm, tool: search_people, args: { search: "{{query}}" } }
  items: people
  key: id
  title: "{{item.name}}"
  subtitle: "{{item.state}}"
detail:
  title: "{{profile.name}} (#{{key}})"
  calls:
    profile: { server: crm, tool: get_person, args: { id: "{{key}}" } }
    open: { server: crm, tool: open_items, args: { id: "{{key}}" } }
  sections:
    - title: Profile
      from: profile
      stats: [{ label: Rate, value: "{{profile.rate | percent}}" }]
    - title: Open
      from: open
      rows: { items: open.rows, text: "{{row.status}}", empty: Nothing open. }
`

test('views: list_views finds view.yaml; open_view searches, then opens an item as text', async ($, on) => {
  const w = world(on, {
    files: { [`${FLOWS}/people/view.yaml`]: PEOPLE, [`${FLOWS}/broken/view.yaml`]: 'title: B\nlist: {}\n' },
    mcp: e => {
      const text =
        e.tool === 'search_people'
          ? JSON.stringify({ people: [{ id: 7, name: 'Sam', state: 'active' }, { id: 8, name: 'Ada', state: 'away' }] })
          : e.tool === 'get_person'
            ? JSON.stringify({ name: 'Sam', rate: 0.5 })
            : 'Unknown tool: open_items'
      return { content: [{ type: 'text', text }], isError: e.tool === 'open_items' }
    },
  })
  await begin($)
  const views = JSON.parse(await call($, 'list_views', {})) as { id: string; errors: string[]; filters: { id: string }[] }[]
  expect(views.map(v => v.id)).toEqual(['broken', 'people'])
  expect(views[0]?.errors.join('\n')).toContain('list.items: is empty')
  expect(views[1]?.filters.map(f => f.id)).toEqual(['active'])

  const found = await call($, 'open_view', { id: 'people', query: 'sa' })
  expect(found).toContain('2 found')
  expect(found).toContain('- 7: Sam (active)')
  expect(w.mcpCalls.at(-1)).toEqual({ server: 'crm', tool: 'search_people', args: { search: 'sa', active: true } })

  const detail = await call($, 'open_view', { id: 'people', key: '7' })
  expect(detail).toContain('Sam (#7)')
  expect(detail).toContain('- Rate: 50%')
  // A tool the server does not have says so, in its own section.
  expect(detail).toContain('crm has no tool open_items yet')
  expect(w.mcpCalls.filter(c => c.tool === 'get_person')[0]?.args).toEqual({ id: 7 })

  expect(await call($, 'open_view', { id: 'nope' })).toContain('no view "nope"')
  expect(await call($, 'open_view', { id: 'people', filter: 'zz' })).toContain('has no filter "zz"')
})

test('views: a call auto mode refuses says which allow rule lets it through', async ($, on) => {
  world(on, {
    files: { [`${FLOWS}/people/view.yaml`]: PEOPLE },
    mcp: () => ({ content: [{ type: 'text', text: '$.mcp.call(crm, search_people) refused: the auto mode classifier gave no verdict' }], isError: true }),
  })
  await begin($)
  const out = await call($, 'open_view', { id: 'people', query: 'x' })
  expect(out).toContain('Add "mcp__crm__search_people" to permissions.allow')
})

test('views: a result Claude Code kept in a file is an error that says to ask for less', async ($, on) => {
  world(on, {
    files: { [`${FLOWS}/people/view.yaml`]: PEOPLE },
    mcp: () => ({ content: [{ type: 'text', text: 'Error: result (107,443 characters) exceeds maximum allowed tokens. Output has been saved to /x.txt' }], isError: false }),
  })
  await begin($)
  expect(await call($, 'open_view', { id: 'people', query: 'x' })).toContain('ask for less')
})

test('views: JSON cut short on the way is an error, not an empty page', async ($, on) => {
  world(on, {
    files: { [`${FLOWS}/people/view.yaml`]: PEOPLE },
    mcp: () => ({ content: [{ type: 'text', text: '{"people": [{"id": 7, "name": "Sa' }], isError: false }),
  })
  await begin($)
  expect(await call($, 'open_view', { id: 'people', query: 'x' })).toContain('was cut short')
})
