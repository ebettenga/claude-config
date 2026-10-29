import { expect, test } from 'claude-code/testing'

import { activeFilters, fillArgs, fillView, formDefaults, formValues, getPath, listArgs, missingFields, parseView, pickRows, rangeOf, shiftAnchor, withFilter } from '../hooks/views'

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
  expect(fillArgs({ body: { sso: null, gone: '{{nope}}' } }, {})).toEqual({ body: { sso: null } })
  const view = parse(VIEW).view!
  expect(listArgs(view, ' sam ', 'active')).toEqual({ search: 'sam', limit: 25, active: true })
  expect(listArgs(view, '', 'all')).toEqual({ limit: 25 })
  expect(pickRows({ items: 'r', text: 'x', empty: '', limit: 2 }, { r: [1, 2, 3] })).toEqual({ items: [1, 2], total: 3 })
  expect(pickRows({ items: 'r', text: 'x', empty: '', limit: 2 }, { r: 'no' })).toEqual({ items: [], total: 0 })
})

const FULL = `
title: Clients
filters:
  - { id: live, label: Live, group: status, args: { statuses: active } }
  - { id: setup, label: Setup, group: status, args: { statuses: setup } }
  - { id: real, label: Real, group: test, args: { is_test_client: false } }
  - { id: test, label: Test, group: test, args: { is_test_client: true } }
list:
  mcp: { server: kh, tool: get, args: { path: /api/v2/clients/, params: { page: "{{page}}" } } }
  items: data
  key: id
  title: "{{item.name}}"
  paged: true
detail:
  title: "{{client.data.name}}"
  calls:
    client: { server: kh, tool: get, args: { path: "/api/v2/clients/{{key}}/" } }
  actions:
    - id: rename
      label: Rename
      style: primary
      fields:
        - { id: name, label: Name, required: true, default: "{{client.data.name}}" }
        - { id: is_test, label: For testing, type: toggle, default: "{{client.data.is_test}}" }
        - { id: tier, label: Tier, type: number }
      mcp: { server: kh, tool: write, args: { method: PUT, path: "/api/v2/clients/{{key}}", body: { name: "{{form.name}}", is_test: "{{form.is_test}}" } } }
      done: "Renamed to {{form.name}}"
  tabs:
    - id: reporting
      title: Reporting
      range: { modes: [week, month, year], default: month }
      calls:
        report: { server: kh, tool: get, args: { path: "/api/v2/reporting/client/{{key}}/summary", params: { start_date: "{{range.start}}", end_date: "{{range.end}}" } } }
      sections:
        - title: Topics
          from: report
          chart: { items: report.data.engagement_by_topic, label: "{{row.label}}", value: "{{row.value}}" }
    - id: admins
      title: Admins
      calls:
        admins: { server: kh, tool: get, args: { path: "/api/v2/clients/{{key}}/client_administrators" } }
      sections:
        - title: Admins
          from: admins
          table:
            items: admins.data
            columns:
              - { label: Email, value: "{{row.email_address}}" }
              - { label: Status, value: "{{row.status | words}}" }
          row_actions:
            - id: remove
              label: Remove
              style: danger
              confirm: "Remove {{row.email_address}} from {{client.data.name}}?"
              mcp: { server: kh, tool: write, args: { method: DELETE, path: "/api/v2/clients/{{key}}/client_administrator/{{row.id}}" } }
        - title: SSO
          from: client
          pairs: client.data.sso_configuration
`

test('view.yaml: tabs, ranges, charts, tables, pairs, actions and filter groups read', () => {
  const v = parse(FULL)
  expect(v.errors).toEqual([])
  const d = v.view!.detail!
  expect(d.tabs.map(t => [t.id, Object.keys(t.calls), t.range?.default ?? ''])).toEqual([['reporting', ['report'], 'month'], ['admins', ['admins'], '']])
  expect(d.actions[0]).toMatchObject({ id: 'rename', style: 'primary', done: 'Renamed to {{form.name}}' })
  expect(d.actions[0]?.fields.map(f => [f.id, f.type, f.required])).toEqual([['name', 'text', true], ['is_test', 'toggle', false], ['tier', 'number', false]])
  expect(d.tabs[1]?.sections[0]?.row_actions[0]?.confirm).toContain('{{row.email_address}}')
  expect(d.tabs[1]?.sections[1]?.pairs).toBe('client.data.sso_configuration')
  expect(v.view!.list.paged).toBe(true)
})

test('view.yaml: a tab section may use its own tab\'s calls only; reused call names and bad fields are named', () => {
  const bad = parse(`
title: X
list: { mcp: { server: a, tool: b }, items: i, key: id, title: t }
detail:
  calls: { c: { server: a, tool: b } }
  tabs:
    - id: one
      calls: { c: { server: a, tool: b }, mine: { server: a, tool: b } }
      range: { modes: [day] }
    - id: two
      sections: [{ title: S, from: mine }]
      actions: [{ id: go, label: Go, mcp: { server: a, tool: b }, fields: [{ id: x, type: color }, { id: y, type: select }] }]
  sections: [{ title: T, rows: { items: r, text: t }, row_actions: [{ id: z, label: Z, mcp: { server: a, tool: b, args: { q: "{{nope}}" } } }] }]
`).errors.join('\n')
  expect(bad).toContain('detail.tabs[0].calls.c: "c" is already a call of this page')
  expect(bad).toContain('"day" must be one of week, month, year, ytd')
  expect(bad).toContain('detail.tabs[1].sections[0].from: no call "mine" on this page or tab')
  expect(bad).toContain('fields[0].type: "color" must be one of')
  expect(bad).toContain('fields[1].options: a select needs options')
  expect(bad).toContain('{{nope...}} names nothing')
})

test('filter groups: one on per group, each group\'s first by default; withFilter swaps within a group', () => {
  const v = parse(FULL).view!
  expect(activeFilters(v, '').map(f => f.id)).toEqual(['live', 'real'])
  expect(withFilter(v, 'live,real', 'test')).toBe('live,test')
  expect(listArgs(v, '', 'setup,test', 3)).toEqual({ path: '/api/v2/clients/', params: { page: 3 }, statuses: 'setup', is_test_client: true })
})

test('ranges: a Monday-to-Sunday week, a month, a year, the year to date; and stepping', () => {
  expect(rangeOf('week', '2026-10-29')).toMatchObject({ start: '2026-10-26', end: '2026-11-01' })
  expect(rangeOf('month', '2026-02-10')).toMatchObject({ start: '2026-02-01', end: '2026-02-28', label: 'Feb 2026' })
  expect(rangeOf('year', '2026-10-29')).toMatchObject({ start: '2026-01-01', end: '2026-12-31' })
  expect(rangeOf('ytd', '2026-10-29')).toMatchObject({ start: '2026-01-01', end: '2026-10-29' })
  expect(shiftAnchor('month', '2026-01-31', -1)).toBe('2025-12-01')
  expect(shiftAnchor('week', '2026-10-29', 1)).toBe('2026-11-05')
})

test('forms: defaults fill from the page; values type for the call; required blanks are named', () => {
  const action = parse(FULL).view!.detail!.actions[0]!
  const values = formDefaults(action.fields, { client: { data: { name: 'Acme', is_test: true } } })
  expect(values).toEqual({ name: 'Acme', is_test: 'true', tier: '' })
  expect(formValues(action.fields, { ...values, tier: '2' })).toEqual({ name: 'Acme', is_test: true, tier: 2 })
  expect(missingFields(action.fields, { name: ' ' })).toEqual(['Name'])
  expect(fillView("{{g | map:'3=Approved,7=Ungraded'}} {{h | map:'3=Approved'}}", { g: 7, h: 'x' })).toBe('Ungraded x')
  expect(fillView('{{a | words}} {{b | count}} {{c | duration}} {{d | clip:5}}', { a: 'active_listener', b: [1, 2], c: 3725, d: 'abcdefgh' })).toBe('Active listener 2 1:02:05 abcd…')
})

test('filters merge into nested args; tab calls may use the page\'s calls', () => {
  const v = parse(`
title: P
filters:
  - { id: live, label: Live, args: { params: { status: live } } }
list:
  mcp: { server: kh, tool: get, args: { path: /p, params: { search: "{{query}}", limit: 25 } } }
  items: data
  key: id
  title: x
detail:
  calls: { profile: { server: kh, tool: get, args: { path: "/p/{{key}}" } } }
  tabs:
    - id: pay
      calls: { pay: { server: kh, tool: get, args: { path: "/users/{{profile.data.user.id}}/money" } } }
`)
  expect(v.errors).toEqual([])
  expect(listArgs(v.view!, 'sam', '')).toEqual({ path: '/p', params: { search: 'sam', limit: 25, status: 'live' } })
})
