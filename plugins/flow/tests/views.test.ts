import { expect, test } from 'claude-code/testing'

import { fillArgs, fillView, getPath, listArgs, parseView, pickRows } from '../hooks/views'

const DIR = '/flows/people'
const VIEW = `
title: People
description: Find someone.
search: { placeholder: Name or id }
filters:
  - { id: active, label: Active, args: { active: true } }
  - { id: all, label: Everyone }
list:
  mcp: { server: crm, tool: search_people, args: { search: "{{query}}", limit: 25 } }
  items: people
  key: id
  count: total
  title: "{{item.first}} {{item.last}}"
  subtitle: "#{{item.id}} · {{item.state | default:'unknown'}}"
  dot: item.on
detail:
  title: "{{profile.person.first}}"
  subtitle: "#{{key}}"
  calls:
    profile: { server: crm, tool: get_person, args: { id: "{{key | number}}" } }
    open: { mcp: { server: crm, tool: open_items, args: { id: "{{key}}" } } }
  sections:
    - title: Profile
      from: profile
      stats:
        - { label: Rate, value: "{{profile.person.rate | percent}}" }
        - { label: Earned, value: "{{profile.person.cents | money}}" }
      text: ["{{profile.person.about}}", "{{profile.person.tags | join}}"]
    - title: Open
      from: open
      rows: { items: open.rows, text: "{{row.status}} · {{row.at | date}}", empty: Nothing open., limit: 2 }
`
const parse = (yaml: string) => parseView(yaml, DIR, `${DIR}/view.yaml`)

test('view.yaml: a good view reads, with the folder name as its id', () => {
  const v = parse(VIEW)
  expect(v.errors).toEqual([])
  expect(v.id).toBe('people')
  expect(v.view?.filters.map(f => f.id)).toEqual(['active', 'all'])
  expect(v.view?.list).toMatchObject({ key: 'id', count: 'total', call: { server: 'crm', tool: 'search_people' } })
  expect(Object.keys(v.view?.detail?.calls ?? {})).toEqual(['profile', 'open'])
  expect(v.view?.detail?.sections[1]?.rows).toMatchObject({ items: 'open.rows', limit: 2, empty: 'Nothing open.' })
})

test('view.yaml: each problem is named by field', () => {
  const bad = parse(`
title: X
extra: 1
list:
  mcp: { server: crm, args: [] }
  title: "{{nope.x}}"
detail:
  calls:
    key: { server: a, tool: b }
  sections:
    - title: S
      from: missing
      stats: [{ label: A, value: "{{profile.x | shout}}" }]
`).errors.join('\n')
  expect(bad).toContain('extra: is not a field')
  expect(bad).toContain('list.mcp.tool: is empty')
  expect(bad).toContain('list.mcp.args: must be a mapping')
  expect(bad).toContain('list.items: is empty')
  expect(bad).toContain('list.key: is empty')
  expect(bad).toContain('list.title: {{nope...}} names nothing')
  expect(bad).toContain('detail.calls.key: "key" is a template name')
  expect(bad).toContain('detail.sections[0].from: no call "missing"')
  expect(bad).toContain('no filter "shout"')
})

test('templates: paths, filters, and what leads nowhere', () => {
  const ctx = { a: { b: [{ c: 0.281 }], cents: 90050, sec: 3600, when: '2026-10-29T15:00:00', tags: ['x', '', 'y'], no: false } }
  expect(getPath(ctx, 'a.b[0].c')).toBe(0.281)
  expect(getPath(ctx, 'a.zz.c')).toBeUndefined()
  expect(fillView('{{a.b[0].c | percent}} · {{a.cents | money}} · {{a.sec | minutes}}', ctx)).toBe('28% · $900.50 · 60 min')
  expect(fillView('{{a.tags | join}}|{{a.tags | join:", "}}', ctx)).toBe('x · y|x, y')
  expect(fillView('{{a.no | yesno}} {{a.missing | default:"none"}} {{a.missing}}!', ctx)).toBe('no none !')
  expect(fillView('{{a.when | date}}', ctx)).toBe('Oct 29, 2026')
  expect(fillView('{{a.b}}', ctx)).toBe('[{"c":0.281}]')
})

test('args: a whole template keeps its type, an empty one is left out, filters add theirs', () => {
  expect(fillArgs({ id: '{{key | number}}', n: '{{key}}', s: 'id {{key}}', q: '{{query}}', deep: ['{{key}}'] }, { key: 42, query: '' })).toEqual({ id: '42', n: 42, s: 'id 42', deep: [42] })
  const view = parse(VIEW).view!
  expect(listArgs(view, ' sam ', 'active')).toEqual({ search: 'sam', limit: 25, active: true })
  expect(listArgs(view, '', 'all')).toEqual({ limit: 25 })
  expect(pickRows({ items: 'r', text: 'x', empty: '', limit: 2 }, { r: [1, 2, 3] })).toEqual({ items: [1, 2], total: 3 })
  expect(pickRows({ items: 'r', text: 'x', empty: '', limit: 2 }, { r: 'no' })).toEqual({ items: [], total: 0 })
})
