import { describe, expect, test } from 'claude-code/testing'

import { declaredLocals, localsYaml, parseLocalsFile, resolveLocals } from '../hooks/locals'
import { defaultValue, evalCondition, fill, fillLocals, parseCondition, parseWorkflow } from '../hooks/spec'
import type { Found, InputSpec, LocalSpec, Workflow } from '../types'

const DIR = '/flows/sample'
const parse = (yaml: string) => parseWorkflow(yaml, DIR, `${DIR}/flow.yaml`)
const errorsOf = (yaml: string) => parse(yaml).errors

const local = (over: Partial<LocalSpec>): LocalSpec => ({ id: 'x', label: 'x', type: 'text', help: '', default: '', ...over })

describe('locals: parsing', () => {
  test('a good locals: list reads, with defaults filled in', () => {
    const found = parse(`
locals:
  - id: backend_repo
    label: Backend repo (web-application)
    type: folder
    help: Your checkout of web-application.
    default: ~/Documents/repos/web-application
  - id: aws_profile
inputs:
  - id: repo
    type: folder
    default: "{{local.backend_repo}}/app"
steps:
  - run: cd {{local.backend_repo | sh}} && aws --profile {{ local.aws_profile }} s3 ls
    cwd: "{{local.backend_repo}}"
    if: local.aws_profile != ""
`)
    expect(found.errors).toEqual([])
    const wf = found.workflow as Workflow
    expect(wf.locals).toEqual([
      { id: 'backend_repo', label: 'Backend repo (web-application)', type: 'folder', help: 'Your checkout of web-application.', default: '~/Documents/repos/web-application' },
      { id: 'aws_profile', label: 'aws_profile', type: 'text', help: '', default: '' },
    ])
  })

  test('no locals: is an empty list', () => {
    expect(parse('steps:\n  - run: ls').workflow?.locals).toEqual([])
  })

  test('errors name the field', () => {
    expect(errorsOf('locals: nope\nsteps:\n  - run: ls')).toContain('locals: must be a list')
    const errors = errorsOf(`
locals:
  - just text
  - id: Bad-Id
  - id: repo
    type: colour
  - id: repo
  - id: other
    defualt: x
  - id: tmpl
    default: "{{inputs.x}}"
steps:
  - run: ls
`)
    expect(errors).toEqual([
      'locals[0]: must be a mapping with id (and label, type, help, default)',
      'locals[1].id: "Bad-Id" must be snake_case (lowercase letters, digits or _, starting with a letter)',
      'locals[2].type: "colour" must be one of text, folder, file',
      'locals[3].id: "repo" is used twice',
      'locals[4].defualt: is not a locals field (use id, label, type, help, default)',
      'locals[5].default: cannot hold a template',
    ])
  })

  test('a {{local.x}} with no x under locals: is an error, in steps and input defaults', () => {
    const errors = errorsOf(`
locals:
  - id: known
inputs:
  - id: a
    default: "{{local.nope}}"
steps:
  - run: echo {{local.known}} {{local.missing | sh}}
  - python:
      code: print(1)
      args: ["{{local.gone}}"]
  - run: ls
    if: local.ghost == "x"
hide_when: local.phantom == "y"
`)
    expect(errors).toEqual([
      'inputs[0].default: {{local.nope}} needs nope listed under locals:',
      'steps[0]: {{local.missing}} needs missing listed under locals:',
      'steps[1]: {{local.gone}} needs gone listed under locals:',
      'steps[2].if: local.ghost names no local',
      'hide_when: local.phantom names no local',
    ])
  })
})

describe('locals: templates and conditions', () => {
  const ctx = { inputs: { a: 'A' }, outputs: {}, runDir: '/run', locals: { repo: "/Users/me/it's here", profile: 'dev' } }

  test('fill fills {{local.x}} with filters; one not given stays as written', () => {
    expect(fill('cd {{local.repo | sh}} && echo {{ local.profile }} {{inputs.a}}', ctx)).toBe(`cd '/Users/me/it'\\''s here' && echo dev A`)
    expect(fill('{{local.profile | json}}', ctx)).toBe('"dev"')
    expect(fill('{{local.other}}', ctx)).toBe('{{local.other}}')
    expect(fill('{{local.repo}}', { inputs: {}, outputs: {}, runDir: '' })).toBe('{{local.repo}}')
  })

  test('fillLocals fills only the locals', () => {
    expect(fillLocals('{{local.profile}}/{{inputs.a}}/{{run.dir}}', { profile: 'dev' })).toBe('dev/{{inputs.a}}/{{run.dir}}')
  })

  test('defaultValue fills an input default from the locals', () => {
    const input: InputSpec = { id: 'r', label: 'R', type: 'folder', options: [], accept: [], multiple: false, remember: false, contains: [], default: '{{local.repo}}/app', required: true, help: '' }
    expect(defaultValue(input, new Date(), { repo: '/src/web' })).toBe('/src/web/app')
    expect(defaultValue(input)).toBe('{{local.repo}}/app')
  })

  test('local.<id> in a condition', () => {
    const node = parseCondition('local.profile == "dev" && !local.unset').node
    expect(node).toBeDefined()
    if (!node) return
    expect(evalCondition(node, { inputs: {}, locals: { profile: 'dev' }, steps: {}, after: [] })).toBe(true)
    expect(evalCondition(node, { inputs: {}, locals: { profile: 'prod' }, steps: {}, after: [] })).toBe(false)
    expect(evalCondition(node, { inputs: {}, steps: {}, after: [] })).toBe(false)
  })
})

describe('locals: storage and resolving', () => {
  test('parseLocalsFile keeps string values; bad YAML or a list is {}', () => {
    expect(parseLocalsFile('# head\nrepo: /a\nport: 5432\nflag: true\nnested: {a: 1}\nprofile: dev\n')).toEqual({ repo: '/a', profile: 'dev' })
    expect(parseLocalsFile('a: [unclosed')).toEqual({})
    expect(parseLocalsFile('- a\n- b')).toEqual({})
    expect(parseLocalsFile('')).toEqual({})
  })

  test('localsYaml writes the header and round-trips', () => {
    const text = localsYaml({ repo: '/Users/me/web app', port: '5432' })
    expect(text.split('\n')[0]).toBe('# Your flow locals: values only you use. Never committed anywhere.')
    expect(parseLocalsFile(text)).toEqual({ repo: '/Users/me/web app', port: '5432' })
    expect(localsYaml({})).toBe('# Your flow locals: values only you use. Never committed anywhere.\n')
  })

  test('resolveLocals: stored, then default, else missing; ~ expands for folders and files only', () => {
    const wf = {
      locals: [
        local({ id: 'repo', type: 'folder', default: '~/repos/web' }),
        local({ id: 'key', type: 'file' }),
        local({ id: 'profile', default: '~dev' }),
        local({ id: 'note', type: 'text' }),
        local({ id: 'blank', type: 'folder', default: '~/x' }),
      ],
    }
    const { values, missing } = resolveLocals(wf, { key: '~/.ssh/id', note: '~/as typed', blank: '  ', other: 'x' }, '/Users/me')
    expect(values).toEqual({ repo: '/Users/me/repos/web', key: '/Users/me/.ssh/id', profile: '~dev', note: '~/as typed', blank: '/Users/me/x' })
    expect(missing).toEqual([])
    expect(resolveLocals({ locals: [local({ id: 'repo', label: 'Repo' })] }, {}, '/h').missing.map(l => l.label)).toEqual(['Repo'])
    expect(resolveLocals({} as Workflow, {}, '/h')).toEqual({ values: {}, missing: [] })
  })

  test('declaredLocals: one entry per id, the first declaration wins, usedBy lists each workflow', () => {
    const found = (id: string, locals: LocalSpec[]): Found => ({ id, dir: `/f/${id}`, file: `/f/${id}/flow.yaml`, errors: [], workflow: { id, title: id, description: '', owner: '', tags: [], env: [], locals, inputs: [], steps: [], outputs: [] } })
    const out = declaredLocals([
      found('a', [local({ id: 'repo', label: 'Repo A', type: 'folder' })]),
      { id: 'broken', dir: '/f/broken', file: '/f/broken/flow.yaml', errors: ['bad'] },
      found('b', [local({ id: 'repo', label: 'Repo B' }), local({ id: 'profile' })]),
    ])
    expect(out).toEqual([
      { spec: local({ id: 'repo', label: 'Repo A', type: 'folder' }), usedBy: ['a', 'b'] },
      { spec: local({ id: 'profile' }), usedBy: ['b'] },
    ])
  })
})
