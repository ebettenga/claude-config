import { describe, expect, test } from 'claude-code/testing'

import { addGroup, arrange, moveGroup, moveWorkflow, parseLayout, removeGroup, renameGroup, setGroup } from '../hooks/layout'
import { checksStatus, defaultValue, evalCondition, fill, inputProblems, isAIStep, parseCondition, parseWorkflow, shQuote, splitArgs, stepEnvNames, stepLevels, untilTime } from '../hooks/spec'
import type { ConditionScope } from '../hooks/spec'
import type { InputSpec, Workflow } from '../types'

const DIR = '/flows/sample'
const parse = (yaml: string) => parseWorkflow(yaml, DIR, `${DIR}/flow.yaml`)
const errorsOf = (yaml: string) => parse(yaml).errors

const input = (over: Partial<InputSpec>): InputSpec => ({
  id: 'x',
  label: 'X',
  type: 'text',
  options: [],
  accept: [],
  multiple: false,
  default: '',
  required: true,
  help: '',
  ...over,
})

describe('parseWorkflow', () => {
  test('a good file reads, with the folder name as the id', () => {
    const found = parse(`
title: Sample
description: Does things.
owner: Me
tags: [a, b]
env: [API_KEY]
inputs:
  - id: csv
    type: file
    accept: [.CSV]
  - id: note
    type: text
    required: false
steps:
  - id: one
    run: echo hi
  - id: two
    agent: light
    prompt: Read {{steps.one.output}} in {{run.dir}}
    continue_on_fail: true
  - id: three
    approve: Go on with {{inputs.csv}}?
    timeout: 30
`)
    expect(found.errors).toEqual([])
    expect(found.id).toBe('sample')
    const wf = found.workflow as Workflow
    expect(wf.title).toBe('Sample')
    expect(wf.env).toEqual(['API_KEY'])
    expect(wf.inputs.map(i => [i.id, i.required, i.accept])).toEqual([
      ['csv', true, ['.csv']],
      ['note', false, []],
    ])
    expect(wf.steps.map(s => [s.id, s.kind, s.after, s.continueOnFail])).toEqual([
      ['one', 'run', [], false],
      ['two', 'agent', ['one'], true],
      ['three', 'approve', ['two'], false],
    ])
    expect(wf.steps[1]?.tier).toBe('light')
    expect(wf.steps[1]?.body).toBe('Read {{steps.one.output}} in {{run.dir}}')
    expect(wf.steps[2]?.timeoutSec).toBe(30)
    expect(wf.steps[0]?.timeoutSec).toBe(600)
  })

  test('not YAML, or not a mapping', () => {
    expect(errorsOf('id: [unclosed')[0]).toMatch(/^not valid YAML/)
    expect(errorsOf('- a\n- b')).toEqual(['the file must be a mapping (id:, title:, steps: ...)'])
  })

  test('errors name the field', () => {
    expect(errorsOf('id: Bad Id\nsteps:\n  - run: ls')).toContain('id: "Bad Id" must be lowercase letters, digits, - or _')
    expect(errorsOf('title: T')).toContain('steps: needs at least one step')
    expect(errorsOf('inputs: nope\nsteps:\n  - run: ls')).toContain('inputs: must be a list')

    const inputs = errorsOf(`
inputs:
  - id: 1bad
  - id: kind
    type: colour
  - id: pick
    type: select
  - id: pick
steps:
  - run: ls
`)
    expect(inputs).toContain('inputs[0].id: "1bad" must be letters, digits or _')
    expect(inputs).toContain('inputs[1].type: "colour" must be one of text, textarea, number, boolean, date, select, file, folder')
    expect(inputs).toContain('inputs[2].options: a select needs at least one option')
    expect(inputs).toContain('inputs[3].id: "pick" is used twice')

    const steps = errorsOf(`
steps:
  - id: a
    run: ls
    approve: sure?
  - id: a
    run: ls
  - id: b
    agent: giant
  - id: c
    run: ""
  - id: d
    run: ls
    timeout: -5
  - id: e
    run: ls
    after: [nowhere]
`)
    expect(steps).toContain('steps[0]: needs exactly one of run, agent, approve, claude, wait, uses, python, mcp, http, model (has run, approve)')
    expect(steps).toContain('steps[1].id: "a" is used twice')
    expect(steps).toContain('steps[2].agent: "giant" must be one of light, medium, careful, heavy, fable')
    expect(steps).toContain('steps[2].prompt: an agent step needs a prompt')
    expect(steps).toContain('steps[3].run: is empty')
    expect(steps).toContain('steps[4].timeout: must be a number of seconds')
    expect(steps).toContain('steps[5].after: no step "nowhere"')
  })

  test('templates must name inputs and steps that exist', () => {
    const errors = errorsOf(`
inputs:
  - id: csv
steps:
  - id: a
    run: cat "{{inputs.missing}}" {{steps.ghost.output}} {{whatever}} {{run.dir}} {{inputs.csv}}
`)
    expect(errors).toEqual([
      'steps[0]: {{inputs.missing}} names no input',
      'steps[0]: {{steps.ghost.output}} names no step',
      'steps[0]: {{whatever}} is not a template (use inputs.<id>, steps.<id>.output or run.dir)',
    ])
  })

  test('after: links that go in a circle are refused', () => {
    expect(errorsOf(`
steps:
  - id: a
    run: ls
    after: [c]
  - id: b
    run: ls
  - id: c
    run: ls
`)).toEqual(['steps: the after: links go in a circle'])
    expect(errorsOf('steps:\n  - id: a\n    run: ls\n    after: [a]')).toEqual(['steps: the after: links go in a circle'])
  })
})

describe('defaultValue', () => {
  // Wednesday 28 October 2026, local time.
  const now = new Date(2026, 9, 28, 12, 0, 0)

  test('dates: today, yesterday and last-<weekday>', () => {
    expect(defaultValue(input({ type: 'date', default: 'today' }), now)).toBe('2026-10-28')
    expect(defaultValue(input({ type: 'date', default: 'yesterday' }), now)).toBe('2026-10-27')
    expect(defaultValue(input({ type: 'date', default: 'last-monday' }), now)).toBe('2026-10-26')
    // The same weekday is a week back, not today.
    expect(defaultValue(input({ type: 'date', default: 'last-wednesday' }), now)).toBe('2026-10-21')
    expect(defaultValue(input({ type: 'date', default: 'last-thursday' }), now)).toBe('2026-10-22')
    expect(defaultValue(input({ type: 'date', default: '2026-01-02' }), now)).toBe('2026-01-02')
  })

  test('last-monday from a Monday and a Sunday', () => {
    expect(defaultValue(input({ type: 'date', default: 'last-monday' }), new Date(2026, 9, 26, 9))).toBe('2026-10-19')
    expect(defaultValue(input({ type: 'date', default: 'last-monday' }), new Date(2026, 10, 1, 9))).toBe('2026-10-26')
  })

  test('booleans, selects and text', () => {
    expect(defaultValue(input({ type: 'boolean', default: 'true' }))).toBe('true')
    expect(defaultValue(input({ type: 'boolean', default: 'yes' }))).toBe('false')
    expect(defaultValue(input({ type: 'select', options: ['a', 'b'], default: 'b' }))).toBe('b')
    expect(defaultValue(input({ type: 'select', options: ['a', 'b'], default: 'z' }))).toBe('a')
    expect(defaultValue(input({ type: 'text', default: 'hello' }))).toBe('hello')
  })
})

describe('inputProblems', () => {
  const wf = (inputs: InputSpec[]): Workflow => ({ id: 'w', title: 'W', description: '', owner: '', tags: [], env: [], inputs, steps: [], outputs: [] })

  test('required, numbers, dates, selects and file types', () => {
    const w = wf([
      input({ id: 'name', label: 'Name' }),
      input({ id: 'opt', label: 'Optional', required: false }),
      input({ id: 'n', label: 'Count', type: 'number' }),
      input({ id: 'd', label: 'Day', type: 'date' }),
      input({ id: 's', label: 'Size', type: 'select', options: ['s', 'm'] }),
      input({ id: 'f', label: 'Sheet', type: 'file', accept: ['.csv'] }),
      input({ id: 'fs', label: 'Sheets', type: 'file', accept: ['.csv'], multiple: true }),
    ])
    expect(inputProblems(w, { name: ' ', n: 'ten', d: '28/10/2026', s: 'xl', f: '/a/b.txt', fs: '/a/1.csv\n/a/2.tsv' })).toEqual([
      'Name is required',
      'Count must be a number',
      'Day must be a date (YYYY-MM-DD)',
      'Size must be one of s, m',
      'Sheet: b.txt is not .csv',
      'Sheets: 2.tsv is not .csv',
    ])
    expect(inputProblems(w, { name: 'Ann', n: '3', d: '2026-10-28', s: 'm', f: '/a/B.CSV', fs: '/a/1.csv' })).toEqual([])
  })
})

describe('fill', () => {
  test('inputs, outputs and the run folder; anything else stays', () => {
    const ctx = { inputs: { csv: '/data/my file.csv' }, outputs: { stats: '42 rows' }, runDir: '/runs/r1' }
    expect(fill('cat "{{inputs.csv}}" > {{ run.dir }}/out; echo {{steps.stats.output}}', ctx)).toBe('cat "/data/my file.csv" > /runs/r1/out; echo 42 rows')
    expect(fill('{{inputs.none}}|{{steps.none.output}}|{{other}}', ctx)).toBe('||{{other}}')
  })
})

describe('stepLevels', () => {
  test('groups steps into the order they can run in', () => {
    const found = parse(`
steps:
  - id: tests
    run: ls
    after: []
  - id: lint
    run: ls
    after: []
  - id: audit
    agent: medium
    prompt: look
    after: [tests, lint]
  - id: summary
    claude: sum up
  - id: side
    run: ls
    after: [tests]
`)
    expect(found.errors).toEqual([])
    const levels = stepLevels((found.workflow as Workflow).steps).map(g => g.map(s => s.id))
    expect(levels).toEqual([['tests', 'lint'], ['audit', 'side'], ['summary']])
  })
})

describe('conditions', () => {
  const scope: ConditionScope = {
    inputs: { env: 'prod', n: '12', flag: 'true', off: 'false', zero: '0', empty: '' },
    steps: { build: { status: 'done', output: 'ok', exit: '0' }, lint: { status: 'failed', output: '', exit: '2' }, 'my-step': { status: 'skipped', output: '', exit: '' } },
    after: ['done', 'failed'],
  }
  const ev = (text: string, sc = scope) => {
    const { node, error } = parseCondition(text)
    if (!node) throw new Error(error)
    return evalCondition(node, sc)
  }

  test('comparisons, logic, literals and references', () => {
    expect(ev("inputs.env == 'prod'")).toBe(true)
    expect(ev('inputs.env != "prod"')).toBe(false)
    expect(ev('inputs.n > 9 && inputs.n <= 12')).toBe(true)
    // Numbers compare as numbers when both sides are numbers, else as strings.
    expect(ev("inputs.n < '9'")).toBe(false)
    expect(ev("inputs.env > 'a'")).toBe(true)
    expect(ev('steps.build.exit == 0 && steps.lint.exit >= 2')).toBe(true)
    expect(ev("steps.lint.status == 'failed' || false")).toBe(true)
    expect(ev("!(steps.build.status == 'done')")).toBe(false)
    expect(ev("steps.my-step.status == 'skipped'")).toBe(true)
    expect(ev('inputs.flag == true')).toBe(true)
    expect(ev("steps.build.output == 'it\\'s'")).toBe(false)
    expect(ev('true && !false')).toBe(true)
    expect(ev('-1 < 0')).toBe(true)
  })

  test('truthiness: non-empty and not "false" or "0"', () => {
    expect(ev('inputs.flag')).toBe(true)
    expect(ev('inputs.off')).toBe(false)
    expect(ev('inputs.zero')).toBe(false)
    expect(ev('inputs.empty')).toBe(false)
    expect(ev('steps.build.output')).toBe(true)
    expect(ev('steps.build.exit')).toBe(false)
    expect(ev('!inputs.empty')).toBe(true)
  })

  test('always() and failure()', () => {
    expect(ev('always()')).toBe(true)
    expect(ev('failure()')).toBe(true)
    expect(ev('failure()', { ...scope, after: ['done', 'skipped'] })).toBe(false)
    expect(checksStatus(parseCondition("always() && inputs.env == 'prod'").node as never)).toBe(true)
    expect(checksStatus(parseCondition("inputs.env == 'prod'").node as never)).toBe(false)
  })

  test('errors say what is wrong', () => {
    expect(parseCondition('').error).toBe('is empty')
    expect(parseCondition("inputs.env = 'prod'").error).toBe('use == to compare')
    expect(parseCondition("inputs.env == 'prod").error).toMatch(/is not closed/)
    expect(parseCondition('(true').error).toBe('expected ")" but found the end')
    expect(parseCondition('true true').error).toBe('unexpected "true"')
    expect(parseCondition('success()').error).toBe('"success()" is not a function (use always() or failure())')
    expect(parseCondition('steps.build.stdout').error).toMatch(/^"steps.build.stdout" is not a reference/)
    expect(parseCondition('env.HOME').error).toMatch(/^"env.HOME" is not a reference/)
    expect(parseCondition('inputs.env ==').error).toBe('expected a value but found the end')
  })
})

describe('the CI fields', () => {
  test('a good file reads them', () => {
    const found = parse(`
inputs:
  - id: clients
steps:
  - id: build
    run: make
    retry: 2
    retry_delay: 3
    outputs: [dist/app.js]
  - id: each
    for_each: "{{inputs.clients}}"
    as: client
    max_parallel: 2
    run: echo {{client | sh}} {{item_index}} > "{{run.dir}}/{{item}}.txt"
    outputs: ["{{client}}.txt"]
  - id: ready
    wait: { url: "https://example.com/health" }
    interval: 30
  - id: at
    wait:
      until: "09:30"
      interval: 60
  - id: sub
    uses: other-flow
    with:
      path: "{{steps.build.files}}"
      count: 3
    if: always() && steps.build.status == 'done'
`)
    expect(found.errors).toEqual([])
    const [build, each, ready, at, sub] = (found.workflow as Workflow).steps
    expect(build).toMatchObject({ retry: 2, retryDelaySec: 3, outputs: ['dist/app.js'], timeoutSec: 600 })
    expect(each).toMatchObject({ forEach: '{{inputs.clients}}', as: 'client', maxParallel: 2, retry: 0, retryDelaySec: 10 })
    expect(ready).toMatchObject({ kind: 'wait', wait: { kind: 'url', target: 'https://example.com/health' }, intervalSec: 30, timeoutSec: 3600 })
    expect(at).toMatchObject({ kind: 'wait', wait: { kind: 'until', target: '09:30' }, intervalSec: 60 })
    expect(sub).toMatchObject({ kind: 'uses', uses: 'other-flow', body: 'other-flow', with: { path: '{{steps.build.files}}', count: '3' }, if: "always() && steps.build.status == 'done'" })
  })

  test('errors name the field', () => {
    const errors = errorsOf(`
id: me
inputs:
  - id: x
steps:
  - id: a
    run: ls
    if: inputs.y == 'z' || steps.ghost.status == 'done'
  - id: b
    run: ls
    if: inputs.x = 1
  - id: c
    approve: ok?
    retry: 1
  - id: d
    run: ls
    retry: 9
    retry_delay: -1
  - id: e
    run: ls
    outputs: [/etc/passwd, ../up.txt, ok.txt]
  - id: f
    run: echo {{item}} {{inputs.x | upper}}
    as: thing
  - id: g
    for_each: { a: 1 }
    run: ls
    as: steps
    max_parallel: 0
  - id: h
    wait: { file: a, url: "https://x" }
  - id: i
    wait: { url: "ftp://x" }
    interval: 0
  - id: j
    wait: { until: "25:00" }
  - id: k
    uses: me
  - id: l
    uses: Not An Id
  - id: m
    run: ls
    with: { a: 1 }
    interval: 5
  - id: n
    for_each: "{{item}}"
    run: echo {{steps.ghost.files}}
`)
    expect(errors).toEqual([
      'steps[1].if: use == to compare',
      'steps[2].retry: only run, agent, python, mcp, http and model steps take retry:',
      'steps[3].retry: must be a whole number from 0 to 5',
      'steps[3].retry_delay: must be a number of seconds',
      'steps[4].outputs: "/etc/passwd" must be a path inside the run folder',
      'steps[4].outputs: "../up.txt" must be a path inside the run folder',
      'steps[5].as: only a for_each step takes as:',
      'steps[6].for_each: must be a list or a template string',
      'steps[6].as: "steps" must be a name (letters, digits, _), not inputs, steps, run, item_index',
      'steps[6].max_parallel: must be a whole number from 1',
      'steps[7].wait: needs exactly one of file, url, until (has file, url)',
      'steps[8].wait.url: "ftp://x" must be an http or https URL',
      'steps[8].interval: must be a number of seconds',
      'steps[9].wait.until: "25:00" must be HH:MM or an ISO date and time',
      'steps[10].uses: a workflow cannot use itself',
      'steps[11].uses: "Not An Id" must be a workflow id',
      'steps[12].with: only uses steps take with:',
      'steps[12].interval: only wait steps take interval:',
      'steps[0].if: inputs.y names no input',
      'steps[0].if: steps.ghost names no step',
      "steps[5]: {{item}} only works in a for_each step's command, prompt, cwd or outputs",
      'steps[5]: {{inputs.x | upper}} uses "upper", which is not a filter (use sh or json)',
      "steps[13]: {{item}} only works in a for_each step's command, prompt, cwd or outputs",
      'steps[13]: {{steps.ghost.files}} names no step',
    ])
  })
})

describe('fill: filters, files, dir and items', () => {
  const ctx = {
    inputs: { msg: `it's $(rm -rf) "x"`, path: '/a b/c' },
    outputs: { build: 'built' },
    runDir: '/runs/r1',
    files: { build: ['/runs/r1/a.txt', '/runs/r1/b c.txt'] },
    dirs: { sub: '/runs/child/r2' },
  }

  test('| sh single-quotes for bash; | json makes a JSON string', () => {
    expect(shQuote(`it's $(rm -rf) "x"`)).toBe(`'it'\\''s $(rm -rf) "x"'`)
    expect(fill('echo {{inputs.msg | sh}}', ctx)).toBe(`echo 'it'\\''s $(rm -rf) "x"'`)
    expect(fill('{{ inputs.msg | json }}', ctx)).toBe(JSON.stringify(`it's $(rm -rf) "x"`))
    expect(fill('{{inputs.path|sh}} {{steps.build.output | sh}} {{run.dir | sh}}', ctx)).toBe(`'/a b/c' 'built' '/runs/r1'`)
    expect(fill('{{inputs.msg | nope}}', ctx)).toBe('{{inputs.msg | nope}}')
  })

  test('files, dir and the item templates', () => {
    expect(fill('{{steps.build.files}}', ctx)).toBe('/runs/r1/a.txt\n/runs/r1/b c.txt')
    expect(fill('{{steps.sub.dir}}|{{steps.build.dir}}|{{steps.none.files}}', ctx)).toBe('/runs/child/r2|/runs/r1|')
    const item = { value: 'acme', index: 2, as: 'client' }
    expect(fill('{{item}} {{client}} {{item_index}} {{client | sh}}', { ...ctx, item })).toBe(`acme acme 2 'acme'`)
    expect(fill('{{item}}', ctx)).toBe('{{item}}')
  })
})

describe('untilTime', () => {
  const now = new Date(2026, 9, 28, 12, 0, 0)
  test('HH:MM is the next occurrence; ISO dates are local', () => {
    expect(untilTime('13:30', now)).toBe(new Date(2026, 9, 28, 13, 30).getTime())
    expect(untilTime('09:00', now)).toBe(new Date(2026, 9, 29, 9, 0).getTime())
    expect(untilTime('12:00', now)).toBe(new Date(2026, 9, 29, 12, 0).getTime())
    expect(untilTime('2026-11-01T08:15', now)).toBe(new Date(2026, 10, 1, 8, 15).getTime())
    expect(untilTime('2026-11-01 08:15:30', now)).toBe(new Date(2026, 10, 1, 8, 15, 30).getTime())
    expect(untilTime('2026-11-01', now)).toBe(new Date(2026, 10, 1).getTime())
    expect(untilTime('2026-11-01T08:15:00Z', now)).toBe(Date.UTC(2026, 10, 1, 8, 15))
    expect(untilTime('24:00', now)).toBeUndefined()
    expect(untilTime('soon', now)).toBeUndefined()
  })
})

describe('python, mcp and http steps', () => {
  test('a good file reads them', () => {
    const found = parse(`
env: [SHOP_TOKEN]
inputs:
  - id: csv
steps:
  - id: stats
    python:
      file: scripts/summarize.py
      args: ["{{inputs.csv}}", --out, "{{run.dir}}/stats.md", 3]
      requirements: [pandas, os.path]
    retry: 1
  - id: inline
    python: print(1)
  - id: line
    python:
      code: print(2)
      args: --name "{{inputs.csv}}" 'a b'
      interpreter: .venv/bin/python
  - id: orders
    mcp:
      server: shopify
      tool: list-orders
      args: { since: "{{inputs.csv}}", limit: 50, deep: [{ k: "{{env.SHOP_TOKEN}}" }] }
  - id: fetch
    for_each: [a, b]
    http:
      url: "https://api.example.com/{{item}}?t={{env.SHOP_TOKEN}}"
      headers: { Authorization: "Bearer {{env.SHOP_TOKEN}}" }
      body: { q: "{{steps.orders.json.items[0].id}}" }
      expect: 201
`)
    expect(found.errors).toEqual([])
    const steps = found.workflow?.steps ?? []
    expect(steps.map(s => s.kind)).toEqual(['python', 'python', 'python', 'mcp', 'http'])
    expect(steps[0]?.python).toEqual({ file: 'scripts/summarize.py', args: ['{{inputs.csv}}', '--out', '{{run.dir}}/stats.md', '3'], interpreter: 'python3', requirements: ['pandas', 'os.path'] })
    expect(steps[1]?.python).toEqual({ code: 'print(1)', args: [], interpreter: 'python3', requirements: [] })
    expect(steps[2]?.python?.args).toEqual(['--name', '{{inputs.csv}}', 'a b'])
    expect(steps[3]?.mcp).toEqual({ server: 'shopify', tool: 'list-orders', args: { since: '{{inputs.csv}}', limit: 50, deep: [{ k: '{{env.SHOP_TOKEN}}' }] } })
    expect(steps[4]?.http).toMatchObject({ method: 'GET', expect: [201], body: { q: '{{steps.orders.json.items[0].id}}' } })
    expect(steps.map(s => stepEnvNames(s))).toEqual([[], [], [], ['SHOP_TOKEN'], ['SHOP_TOKEN']])
    expect(steps.map(s => isAIStep(s))).toEqual([false, false, false, false, false])
    expect(isAIStep({ kind: 'agent' })).toBe(true)
    expect(isAIStep({ kind: 'claude' })).toBe(true)
  })

  test('errors name the field', () => {
    const errors = errorsOf(`
env: [TOKEN]
steps:
  - id: a
    python: { file: x.py, code: "print(1)", nope: 1 }
  - id: b
    python: { args: "'open" }
  - id: c
    python: { file: x.py, requirements: [pandas, "no-dash"] }
  - id: d
    mcp: { server: "", args: [1] }
  - id: e
    mcp: shopify
  - id: f
    http: { url: "ftp://x", method: "G T", expect: [99], headers: { A: [1] } }
  - id: g
    run: curl -H {{env.TOKEN}}
  - id: h
    http: { url: "https://x/{{env.OTHER}}" }
  - id: i
    run: echo {{steps.a.json.x.}} {{steps.ghost.json.n}} {{steps.a.json[0].ok}}
    if: steps.ghost.json.n > 1
  - id: j
    approve: ok?
    for_each: [a]
`)
    expect(errors).toEqual([
      'steps[0].python.nope: is not a python field (use file, code, args, interpreter, requirements)',
      'steps[0].python: needs exactly one of file or code',
      'steps[1].python: needs exactly one of file or code',
      "steps[1].python.args: the quote starting at 'open is not closed",
      'steps[2].python.requirements: "no-dash" is not an import name',
      "steps[3].mcp.server: must be the server's name, as /mcp lists it",
      "steps[3].mcp.tool: must be the tool's name on that server",
      'steps[3].mcp.args: must be a mapping of argument names to values',
      'steps[4].mcp: must be a mapping with server, tool and args',
      'steps[5].http.method: "G T" is not an HTTP method',
      'steps[5].http.url: "ftp://x" must be an http or https URL',
      'steps[5].http.headers.A: must be a single value',
      'steps[5].http.expect: must be HTTP status codes (100 to 599)',
      'steps[9].for_each: only run, agent, python, mcp, http and model steps take for_each:',
      'steps[6]: {{env.TOKEN}} only works in python args, mcp args and http url, headers and body (a run step has $TOKEN)',
      'steps[7]: {{env.OTHER}} needs OTHER listed under env:',
      'steps[8]: {{steps.a.json.x.}} is not a JSON path (use steps.<id>.json, then .key and [n], as in steps.fetch.json.orders[0].total)',
      'steps[8]: {{steps.ghost.json}} names no step',
      'steps[8].if: steps.ghost names no step',
    ])
  })

  test('splitArgs splits like a shell line and keeps a template whole', () => {
    expect(splitArgs(`a "b c" 'd "e"' f\\ g {{ inputs.x | sh }} x{{run.dir}}/y "q\\"r"`)).toEqual({ args: ['a', 'b c', 'd "e"', 'f g', '{{ inputs.x | sh }}', 'x{{run.dir}}/y', 'q"r'] })
    expect(splitArgs('  ').args).toEqual([])
    expect(splitArgs('"" x').args).toEqual(['', 'x'])
    expect(splitArgs('{{inputs.x').error).toBe('the template starting at {{inputs.x is not closed')
  })
})

describe('JSON paths', () => {
  const ctx = { inputs: {}, outputs: { f: '{"count": 2, "orders": [{"total": 40.5, "tags": ["a"]}], "ok": true, "none": null}', t: 'not json' }, runDir: '/r' }
  test('fill renders scalars as text, objects and arrays as JSON, and nothing for what is not there', () => {
    expect(fill('{{steps.f.json.count}}|{{steps.f.json.orders[0].total}}|{{steps.f.json.orders[0].tags}}|{{steps.f.json.ok}}', ctx)).toBe('2|40.5|["a"]|true')
    expect(fill('[{{steps.f.json.none}}][{{steps.f.json.orders[3].total}}][{{steps.t.json.x}}][{{steps.missing.json}}]', ctx)).toBe('[][][][]')
    expect(fill('{{steps.f.json.orders[0] | sh}}', ctx)).toBe(`'{"total":40.5,"tags":["a"]}'`)
    expect(fill('{{env.TOKEN}}', ctx)).toBe('{{env.TOKEN}}')
    expect(fill('{{env.TOKEN}}', { ...ctx, env: { TOKEN: 's' } })).toBe('s')
  })

  test('if: compares JSON values as numbers, booleans and text', () => {
    const scope: ConditionScope = { inputs: {}, steps: { f: { status: 'done', output: ctx.outputs.f, exit: '0' }, t: { status: 'done', output: 'x', exit: '0' } }, after: [] }
    const check = (text: string) => {
      const { node, error } = parseCondition(text)
      if (!node) throw new Error(error)
      return evalCondition(node, scope)
    }
    expect(check('steps.f.json.count > 1')).toBe(true)
    expect(check('steps.f.json.orders[0].total == 40.5 && steps.f.json.ok')).toBe(true)
    expect(check("steps.f.json.orders[0].tags == '[\"a\"]'")).toBe(true)
    expect(check('steps.f.json.none || steps.t.json.count')).toBe(false)
    expect(check('!steps.f.json.orders[9]')).toBe(true)
    expect(parseCondition('steps.f.json.orders[x]').error).toBe('unexpected "["')
    expect(parseCondition('steps.f.output[0]').error).toMatch(/^"steps.f.output\[0\]" is not a reference/)
  })
})

describe('outputs: paths or { file, title, chart }', () => {
  test('both forms read; a chart gets its defaults', () => {
    const found = parse(`
steps:
  - id: a
    run: echo
outputs:
  - report.md
  - { file: sales.csv, title: Totals by category, chart: { type: bar, x: category, y: price } }
  - file: visits.tsv
    chart: { type: line, x: date, top: 30 }
  - { file: notes.txt }
`)
    expect(found.errors).toEqual([])
    expect(found.workflow?.outputs).toEqual([
      { file: 'report.md', title: 'report.md' },
      { file: 'sales.csv', title: 'Totals by category', chart: { type: 'bar', x: 'category', y: 'price', agg: 'sum', top: 12, sort: 'value' } },
      { file: 'visits.tsv', title: 'visits.tsv', chart: { type: 'line', x: 'date', agg: 'count', top: 30, sort: 'label' } },
      { file: 'notes.txt', title: 'notes.txt' },
    ])
  })

  test('a bad chart field is named', () => {
    expect(
      errorsOf(`
steps:
  - id: a
    run: echo
outputs:
  - { file: a.csv, chart: { type: pie, x: category } }
  - { file: b.csv, chart: { type: bar, agg: mean, top: 0, colour: red } }
  - { file: c.md, chart: { type: bar, x: k } }
  - { title: No file }
  - { file: d.csv, chart: { type: line, x: day, sort: random } }
`),
    ).toEqual([
      'outputs[0].chart.type: "pie" must be bar or line',
      'outputs[1].chart.colour: is not a chart field (use type, x, y, agg, top, sort)',
      'outputs[1].chart.x: is required (the column to group by)',
      'outputs[1].chart.agg: mean needs y (a numeric column)',
      'outputs[1].chart.top: must be a whole number from 1 to 50',
      'outputs[2].chart: only a .csv, .tsv or .json output can be charted',
      'outputs[3].file: is required (a path in the run folder)',
      'outputs[4].chart.sort: "random" must be value or label',
    ])
  })
})

test('loader: a model step is AI, and its fields are checked', () => {
  const ok = parseWorkflow('steps:\n  - id: a\n    model: { prompt: hi, files: [x.md], write: out.md, use: haiku }\n', '/f/w', '/f/w/flow.yaml')
  expect(ok.errors).toEqual([])
  expect(ok.workflow?.steps[0]?.kind).toBe('model')
  expect(isAIStep(ok.workflow!.steps[0]!)).toBe(true)
  const bad = parseWorkflow('steps:\n  - id: a\n    model: { files: [x], effort: huge, max_tokens: 0, colour: red }\n', '/f/w', '/f/w/flow.yaml')
  expect(bad.errors.join('\n')).toContain('model.prompt: a model step needs a prompt')
  expect(bad.errors.join('\n')).toContain('model.effort: must be one of')
  expect(bad.errors.join('\n')).toContain('model.max_tokens')
})

test('loader: an agent step takes tools, read, write and budget, and never Bash', () => {
  const ok = parse('title: T\nsteps:\n  - id: a\n    agent: medium\n    tools: [Read, Grep]\n    read: ["{{inputs.repo}}"]\n    budget: 2\n    prompt: look\ninputs:\n  - id: repo\n    type: folder\n')
  expect(ok.errors).toEqual([])
  expect(ok.workflow?.steps[0]?.agent).toEqual({ tools: ['Read', 'Grep'], read: ['{{inputs.repo}}'], write: [], budget: 2, use: '', effort: '' })
  const bad = parse('title: T\nsteps:\n  - id: a\n    agent: medium\n    tools: [Read, Bash]\n    budget: 50\n    prompt: look\n  - id: b\n    run: echo\n    tools: [Read]\n')
  expect(bad.errors.join('\n')).toContain('Bash is not allowed in an agent step')
  expect(bad.errors.join('\n')).toContain('budget: must be dollars')
  expect(bad.errors.join('\n')).toContain('steps[1].tools: only agent steps take tools:')
})

test('flows.yaml: groups in order, Other for the rest, and each problem named', () => {
  const ok = parseLayout('groups:\n  - title: Reports\n    workflows: [b, a]\n  - title: Empty\n')
  expect(ok.errors).toEqual([])
  const found = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  expect(arrange(found, ok.groups).map(s => [s.title, s.items.map(f => f.id)])).toEqual([['Reports', ['b', 'a']], ['Empty', []], ['Other', ['c']]])
  const bad = parseLayout('groups:\n  - title: Other\n  - title: X\n    workflows: [a]\n  - title: Y\n    workflows: [a]\nextra: 1\n')
  expect(bad.errors.join('\n')).toContain('"Other" is kept')
  expect(bad.errors.join('\n')).toContain('"a" is already in X')
  expect(bad.errors.join('\n')).toContain('flows.yaml.extra: is not a field')
  expect(parseLayout('').groups).toEqual([])
})

test('flows.yaml edits: move, regroup, add, rename, reorder and remove', () => {
  let g = [{ title: 'A', workflows: ['x', 'gone', 'y'] }]
  // Moving among what is shown keeps the id of a workflow missing here.
  g = moveWorkflow(g, 'y', ['x', 'y'], -1)
  expect(g[0]?.workflows).toEqual(['y', 'gone', 'x'])
  g = addGroup(g, 'B')
  expect(addGroup(g, 'Other')).toEqual(g)
  g = setGroup(g, 'x', 'B')
  expect(g).toEqual([{ title: 'A', workflows: ['y', 'gone'] }, { title: 'B', workflows: ['x'] }])
  g = moveGroup(g, 'B', -1)
  expect(g.map(x => x.title)).toEqual(['B', 'A'])
  g = renameGroup(g, 'B', 'Bee')
  expect(renameGroup(g, 'Bee', 'A')).toEqual(g)
  g = setGroup(g, 'y', 'Other')
  expect(g[1]?.workflows).toEqual(['gone'])
  g = removeGroup(g, 'Bee')
  expect(g.map(x => x.title)).toEqual(['A'])
})
