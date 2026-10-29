// Views (view.yaml): a search, a list and a detail page over MCP tool calls,
// drawn on the hub's Views tab. No `$` here, so the rules can be tested on
// their own; runner.ts reads the files and makes the calls.
//
//   id: listeners
//   title: Listeners
//   search: { placeholder: Name, email or id }
//   filters:
//     - { id: active, label: Active, args: { active_listeners: true } }
//   list:
//     mcp: { server: crm, tool: search_people, args: { search: "{{query}}" } }
//     items: people
//     key: id
//     title: "{{item.name}}"
//     subtitle: "#{{item.id}} · {{item.state}}"
//   detail:
//     title: "{{profile.name}}"
//     calls:
//       profile: { server: crm, tool: get_person, args: { id: "{{key}}" } }
//     sections:
//       - title: Profile
//         from: profile
//         stats: [{ label: Calls, value: "{{profile.calls | number}}" }]
//
// A template is {{path}} or {{path | filter | filter}}. Paths are dotted keys
// and [n] indexes into the context: query, filter, key, item (a list row),
// row (a section row), and each detail call's result by its name. A key of
// digits reaches a call as a number.

import { load } from './vendor/js-yaml.mjs'
import type { FoundView, ViewCall, ViewFilter, ViewRows, ViewSection, ViewSpec, ViewStat } from '../types'

export const VIEW_FILE = 'view.yaml'
export const VIEW_FILTERS = ['percent', 'money', 'number', 'minutes', 'date', 'datetime', 'join', 'lower', 'upper', 'yesno', 'default'] as const
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/
const CALL_NAME_RE = /^[a-z][a-z0-9_]*$/
/** Names a detail call may not take: they are the template's own. */
const RESERVED = ['query', 'filter', 'key', 'item', 'row']
const MAX_ROWS = 100

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')

// ── templates ───────────────────────────────────────────────────────────────

/** The value at a dotted path (`a.b[0].c`); undefined when it leads nowhere. */
export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root
  for (const part of path.match(/[^.[\]]+|\[\d+\]/g) ?? []) {
    if (cur === null || cur === undefined) return undefined
    if (part.startsWith('[')) {
      const i = Number(part.slice(1, -1))
      cur = Array.isArray(cur) ? cur[i] : undefined
    } else cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

const asNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

const asDate = (v: unknown): Date | undefined => {
  if (typeof v !== 'string' || !v.trim()) return undefined
  // A time with no zone is UTC, as the backends write it.
  const iso = /T\d\d:\d\d/.test(v) && !/(Z|[+-]\d\d:?\d\d)$/.test(v) ? `${v}Z` : v
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/** One filter applied to a value; `arg` is the text after `:` (`default:'none'`). */
function applyFilter(value: unknown, name: string, arg: string | undefined): unknown {
  const n = asNumber(value)
  switch (name) {
    case 'percent':
      // 0.28 and 28 both read as 28%.
      return n === undefined ? undefined : `${Math.round(Math.abs(n) <= 1 ? n * 100 : n)}%`
    case 'money':
      // Cents, as the backends keep money.
      return n === undefined ? undefined : `$${(n / 100).toLocaleString('en-US', { maximumFractionDigits: n % 100 === 0 ? 0 : 2, minimumFractionDigits: n % 100 === 0 ? 0 : 2 })}`
    case 'number':
      return n === undefined ? undefined : n.toLocaleString('en-US', { maximumFractionDigits: 1 })
    case 'minutes':
      // Seconds in, minutes out.
      return n === undefined ? undefined : `${Math.round(n / 60).toLocaleString('en-US')} min`
    case 'date': {
      const d = asDate(value)
      return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : undefined
    }
    case 'datetime': {
      const d = asDate(value)
      return d ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : undefined
    }
    case 'join':
      return Array.isArray(value) ? value.filter(x => x !== null && x !== undefined && x !== '').join(arg ?? ' · ') : value
    case 'lower':
      return typeof value === 'string' ? value.toLowerCase() : value
    case 'upper':
      return typeof value === 'string' ? value.toUpperCase() : value
    case 'yesno':
      return value === undefined || value === null ? undefined : value ? 'yes' : 'no'
    case 'default':
      return value === undefined || value === null || value === '' ? (arg ?? '') : value
    default:
      return value
  }
}

const text = (v: unknown): string => {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/** Splits `path | f | g:'x'` into the path and its filters. */
function parseExpr(expr: string): { path: string; filters: { name: string; arg?: string }[] } {
  const [path = '', ...rest] = expr.split('|').map(p => p.trim())
  const filters = rest.map(f => {
    const m = /^([a-z]+)(?:\s*:\s*(?:'([^']*)'|"([^"]*)"|(\S+)))?$/.exec(f)
    return m ? { name: m[1] as string, arg: m[2] ?? m[3] ?? m[4] } : { name: f }
  })
  return { path, filters }
}

/** The value a whole-template `{{path | filters}}` gives, kept as a value (for args). */
export function evalExpr(expr: string, ctx: Record<string, unknown>): unknown {
  const { path, filters } = parseExpr(expr)
  let v = getPath(ctx, path)
  for (const f of filters) v = applyFilter(v, f.name, f.arg)
  return v
}

/** Fills every {{...}} in a template; what leads nowhere fills as nothing. */
export function fillView(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => text(evalExpr(expr, ctx)))
}

/**
 * A call's args with each string filled in. A string that is one template
 * alone keeps its value's type (a number stays a number), and an arg that
 * fills as nothing is left out, so an empty search sends no search.
 */
export function fillArgs(args: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof args === 'string') {
    const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(args)
    if (whole) return evalExpr(whole[1] as string, ctx)
    return fillView(args, ctx)
  }
  if (Array.isArray(args)) return args.map(a => fillArgs(a, ctx))
  if (isObj(args)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args)) {
      const filled = fillArgs(v, ctx)
      if (filled === undefined || filled === null || filled === '') continue
      out[k] = filled
    }
    return out
  }
  return args
}

/** The list call's args for a search: the call's own, then the filter's on top. */
export function listArgs(view: ViewSpec, query: string, filterId: string): Record<string, unknown> {
  const filter = view.filters.find(f => f.id === filterId)
  const ctx = { query: query.trim(), filter: filterId }
  return { ...(fillArgs(view.list.call.args, ctx) as Record<string, unknown>), ...(fillArgs(filter?.args ?? {}, ctx) as Record<string, unknown>) }
}

/** A tool's text answer as JSON when it is JSON, else the text. */
export function parseResult(textOut: string): unknown {
  const t = textOut.trim()
  if (!t) return null
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

/** The rows a ViewRows picks out of a result (at most `limit`), and how many there were. */
export function pickRows(rows: ViewRows, root: unknown): { items: unknown[]; total: number } {
  const list = getPath(root, rows.items)
  const items = Array.isArray(list) ? list : []
  return { items: items.slice(0, rows.limit), total: items.length }
}

// ── view.yaml ───────────────────────────────────────────────────────────────

/** Every {{path}} root a template names, so a check can say it names nothing. */
function roots(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([^}|]+?)\s*(?:\|[^}]*)?\}\}/g)].map(m => (m[1] as string).split(/[.[]/)[0] as string)
}

function deepStrings(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.flatMap(deepStrings)
  if (isObj(v)) return Object.values(v).flatMap(deepStrings)
  return []
}

function badFilters(template: string): string[] {
  const out: string[] = []
  for (const m of template.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g))
    for (const f of parseExpr(m[1] as string).filters) if (!(VIEW_FILTERS as readonly string[]).includes(f.name)) out.push(f.name)
  return out
}

function parseCall(raw: unknown, at: string, errors: string[]): ViewCall | undefined {
  // `mcp: { server, tool, args }`, or the three fields directly.
  const m = isObj(raw) && isObj(raw.mcp) ? raw.mcp : raw
  if (!isObj(m)) return void errors.push(`${at}: must be { server, tool, args }`)
  const server = str(m.server)
  const tool = str(m.tool)
  if (!server) errors.push(`${at}.server: is empty`)
  if (!tool) errors.push(`${at}.tool: is empty`)
  if (m.args !== undefined && !isObj(m.args)) errors.push(`${at}.args: must be a mapping`)
  for (const k of Object.keys(m)) if (!['server', 'tool', 'args'].includes(k)) errors.push(`${at}.${k}: is not a field (server, tool, args)`)
  return { server, tool, args: isObj(m.args) ? m.args : {} }
}

function parseRows(raw: Record<string, unknown>, at: string, errors: string[], textKey: 'title' | 'text'): ViewRows {
  const items = str(raw.items)
  if (!items) errors.push(`${at}.items: is empty (the path to the list in the result)`)
  const line = str(raw[textKey])
  if (!line) errors.push(`${at}.${textKey}: is empty`)
  const limit = raw.limit === undefined ? 25 : Number(raw.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) errors.push(`${at}.limit: must be a whole number from 1 to ${MAX_ROWS}`)
  return {
    items,
    text: line,
    ...(str(raw.subtitle) ? { subtitle: str(raw.subtitle) } : {}),
    ...(str(raw.dot) ? { dot: str(raw.dot) } : {}),
    empty: str(raw.empty) || 'Nothing here.',
    limit: Number.isInteger(limit) ? Math.min(MAX_ROWS, Math.max(1, limit)) : 25,
  }
}

/** Reads a view.yaml; problems are named by field, as for flow.yaml. */
export function parseView(textIn: string, dir: string, file: string): FoundView {
  const folderId = dir.replace(/\/+$/, '').split('/').pop() ?? ''
  const found: FoundView = { id: folderId, dir, file, errors: [] }
  let doc: unknown
  try {
    doc = load(textIn)
  } catch (err) {
    found.errors.push(`not valid YAML: ${String((err as Error)?.message ?? err).split('\n')[0]}`)
    return found
  }
  if (!isObj(doc)) {
    found.errors.push('the file must be a mapping (id:, title:, list: ...)')
    return found
  }
  const errors = found.errors
  const id = str(doc.id) || folderId
  if (!ID_RE.test(id)) errors.push(`id: "${id}" must be lowercase letters, digits, - or _`)
  found.id = id
  const title = str(doc.title)
  if (!title) errors.push('title: is empty')
  const known = ['id', 'title', 'description', 'owner', 'tags', 'search', 'filters', 'list', 'detail']
  for (const k of Object.keys(doc)) if (!known.includes(k)) errors.push(`${k}: is not a field`)

  let search: ViewSpec['search']
  if (doc.search !== undefined && doc.search !== null && doc.search !== false) {
    const s = isObj(doc.search) ? doc.search : {}
    search = { placeholder: str(s.placeholder) || 'Search' }
  }

  const filters: ViewFilter[] = []
  if (doc.filters !== undefined) {
    if (!Array.isArray(doc.filters)) errors.push('filters: must be a list')
    else
      doc.filters.forEach((f, i) => {
        const at = `filters[${i}]`
        if (!isObj(f)) return void errors.push(`${at}: must be { id, label, args }`)
        const fid = str(f.id)
        if (!ID_RE.test(fid)) errors.push(`${at}.id: "${fid}" must be lowercase letters, digits, - or _`)
        if (filters.some(x => x.id === fid)) errors.push(`${at}.id: "${fid}" is used twice`)
        if (f.args !== undefined && !isObj(f.args)) errors.push(`${at}.args: must be a mapping`)
        filters.push({ id: fid, label: str(f.label) || fid, args: isObj(f.args) ? f.args : {} })
      })
  }

  const rawList = isObj(doc.list) ? doc.list : undefined
  if (!rawList) errors.push('list: is missing (the call that finds the items, and how to show each)')
  const listCall = parseCall(rawList ?? {}, 'list.mcp', errors) ?? { server: '', tool: '', args: {} }
  const listRows = parseRows(rawList ?? {}, 'list', errors, 'title')
  const key = str(rawList?.key)
  if (rawList && !key) errors.push('list.key: is empty (the path to each item\'s id)')
  for (const k of Object.keys(rawList ?? {}))
    if (!['mcp', 'server', 'tool', 'args', 'items', 'key', 'title', 'subtitle', 'dot', 'empty', 'limit', 'count'].includes(k)) errors.push(`list.${k}: is not a field`)

  let detail: ViewSpec['detail']
  if (doc.detail !== undefined) {
    const d = isObj(doc.detail) ? doc.detail : {}
    if (!isObj(doc.detail)) errors.push('detail: must be a mapping with calls and sections')
    const calls: Record<string, ViewCall> = {}
    const rawCalls = isObj(d.calls) ? d.calls : {}
    if (d.calls !== undefined && !isObj(d.calls)) errors.push('detail.calls: must be a mapping of name: { server, tool, args }')
    for (const [name, raw] of Object.entries(rawCalls)) {
      if (!CALL_NAME_RE.test(name)) errors.push(`detail.calls.${name}: a call name is lowercase letters, digits or _`)
      else if (RESERVED.includes(name)) errors.push(`detail.calls.${name}: "${name}" is a template name; call it something else`)
      const c = parseCall(raw, `detail.calls.${name}`, errors)
      if (c) calls[name] = c
    }
    const sections: ViewSection[] = []
    const rawSections = d.sections ?? []
    if (!Array.isArray(rawSections)) errors.push('detail.sections: must be a list')
    else
      rawSections.forEach((sec, i) => {
        const at = `detail.sections[${i}]`
        if (!isObj(sec)) return void errors.push(`${at}: must be a mapping with title`)
        const from = str(sec.from) || undefined
        if (from && !calls[from]) errors.push(`${at}.from: no call "${from}" in detail.calls`)
        const stats: ViewStat[] = []
        if (sec.stats !== undefined && !Array.isArray(sec.stats)) errors.push(`${at}.stats: must be a list of { label, value }`)
        ;(Array.isArray(sec.stats) ? sec.stats : []).forEach((st, j) => {
          if (!isObj(st) || !str(st.label)) return void errors.push(`${at}.stats[${j}]: must be { label, value }`)
          stats.push({ label: str(st.label), value: str(st.value) })
        })
        const lines = Array.isArray(sec.text) ? sec.text.map(str) : sec.text === undefined ? [] : [str(sec.text)]
        let rows: ViewRows | undefined
        if (sec.rows !== undefined) {
          if (!isObj(sec.rows)) errors.push(`${at}.rows: must be { items, text }`)
          else rows = parseRows(sec.rows, `${at}.rows`, errors, 'text')
        }
        sections.push({ title: str(sec.title) || `Section ${i + 1}`, ...(from ? { from } : {}), stats, text: lines.filter(Boolean), ...(rows ? { rows } : {}) })
      })
    detail = {
      title: str(d.title) || '{{key}}',
      ...(str(d.subtitle) ? { subtitle: str(d.subtitle) } : {}),
      calls,
      sections,
    }
  }

  // Every template names something the view has, and only known filters.
  const listNames = ['query', 'filter', 'item']
  const detailNames = ['query', 'filter', 'key', 'item', 'row', ...Object.keys(detail?.calls ?? {})]
  const check = (where: string, template: string, names: string[]) => {
    for (const r of roots(template)) if (!names.includes(r)) errors.push(`${where}: {{${r}...}} names nothing (use ${names.join(', ')})`)
    for (const f of badFilters(template)) errors.push(`${where}: no filter "${f}" (${VIEW_FILTERS.join(', ')})`)
  }
  for (const s of deepStrings(listCall.args)) check('list.mcp.args', s, ['query', 'filter'])
  for (const f of filters) for (const s of deepStrings(f.args)) check(`filters.${f.id}.args`, s, ['query', 'filter'])
  for (const [k, v] of [['list.title', listRows.text], ['list.subtitle', listRows.subtitle ?? '']] as const) check(k, v, listNames)
  if (detail) {
    for (const [name, c] of Object.entries(detail.calls)) for (const s of deepStrings(c.args)) check(`detail.calls.${name}.args`, s, ['query', 'filter', 'key'])
    check('detail.title', detail.title, detailNames)
    if (detail.subtitle) check('detail.subtitle', detail.subtitle, detailNames)
    detail.sections.forEach((sec, i) => {
      for (const st of sec.stats) check(`detail.sections[${i}].stats.${st.label}`, st.value, detailNames)
      for (const line of sec.text) check(`detail.sections[${i}].text`, line, detailNames)
      if (sec.rows) {
        check(`detail.sections[${i}].rows.text`, sec.rows.text, detailNames)
        if (sec.rows.subtitle) check(`detail.sections[${i}].rows.subtitle`, sec.rows.subtitle, detailNames)
      }
    })
  }

  if (!errors.length)
    found.view = {
      id,
      title,
      description: str(doc.description),
      owner: str(doc.owner),
      ...(search ? { search } : {}),
      filters,
      list: { call: listCall, rows: listRows, key, ...(str(rawList?.count) ? { count: str(rawList?.count) } : {}) },
      ...(detail ? { detail } : {}),
    }
  return found
}
