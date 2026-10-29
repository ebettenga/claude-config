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
// A detail page can have tabs, each with its own calls (run when it opens)
// and an optional date range; sections show stats, text lines, rows, a
// table, a bar chart or an object's pairs; actions are buttons that call a
// tool (a write), optionally after a form and a confirm.
//
// A template is {{path}} or {{path | filter | filter}}. Paths are dotted keys
// and [n] indexes into the context: query, filter, page, key, item (a list
// row), row (a section row), form (an action's fields), range (start, end,
// label) and each detail call's result by its name. A key of digits reaches
// a call as a number.

import { load } from './vendor/js-yaml.mjs'
import type { FoundView, ViewAction, ViewCall, ViewChart, ViewField, ViewFilter, ViewRange, ViewRows, ViewSection, ViewSpec, ViewStat, ViewTab, ViewTable } from '../types'

export const VIEW_FILE = 'view.yaml'
export const VIEW_FILTERS = ['percent', 'money', 'number', 'minutes', 'duration', 'date', 'datetime', 'join', 'count', 'lower', 'upper', 'words', 'yesno', 'default', 'clip', 'map'] as const
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/
const CALL_NAME_RE = /^[a-z][a-z0-9_]*$/
/** Names a detail call may not take: they are the template's own. */
const RESERVED = ['query', 'filter', 'page', 'key', 'item', 'row', 'form', 'range']
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
    case 'duration': {
      // Seconds in, h:mm:ss out.
      if (n === undefined) return undefined
      const t = Math.max(0, Math.round(n))
      const hh = Math.floor(t / 3600)
      const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0')
      const ss = String(t % 60).padStart(2, '0')
      return hh ? `${hh}:${mm}:${ss}` : `${Math.floor(t / 60)}:${ss}`
    }
    case 'count':
      return Array.isArray(value) ? value.length : isObj(value) ? Object.keys(value).length : value === undefined || value === null ? undefined : 1
    case 'words':
      // snake_case or SHOUTING to words: active_listener -> Active listener.
      return typeof value === 'string' && value ? (value.replace(/[_-]+/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase())) : value
    case 'map': {
      // map:'3=Approved,7=Ungraded': a label for each value; others stay as they are.
      if (value === undefined || value === null) return value
      for (const pair of (arg ?? '').split(',')) {
        const i = pair.indexOf('=')
        if (i > 0 && pair.slice(0, i).trim() === String(value)) return pair.slice(i + 1).trim()
      }
      return value
    }
    case 'clip': {
      const max = Number(arg ?? 80)
      return typeof value === 'string' && value.length > max ? `${value.slice(0, Math.max(1, max - 1)).trimEnd()}…` : value
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
 * fills as nothing is left out, so an empty search sends no search; a null
 * written in the file is sent as null.
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
      // A null written in the file is sent (to clear a field); a template that fills as nothing is not.
      if (v === null) {
        out[k] = null
        continue
      }
      const filled = fillArgs(v, ctx)
      if (filled === undefined || filled === null || filled === '') continue
      out[k] = filled
    }
    return out
  }
  return args
}

/** The filter ids that are on: the ones named in `chosen` (comma-joined), else each group's first. */
export function activeFilters(view: ViewSpec, chosen: string): ViewFilter[] {
  const want = new Set(chosen.split(',').map(x => x.trim()).filter(Boolean))
  const groups = [...new Set(view.filters.map(f => f.group))]
  return groups.flatMap(g => {
    const inGroup = view.filters.filter(f => f.group === g)
    const hit = inGroup.find(f => want.has(f.id)) ?? inGroup[0]
    return hit ? [hit] : []
  })
}

/** `chosen` with one filter turned on in its group (the others of that group off). */
export function withFilter(view: ViewSpec, chosen: string, id: string): string {
  const f = view.filters.find(x => x.id === id)
  if (!f) return chosen
  return activeFilters(view, chosen)
    .map(x => (x.group === f.group ? id : x.id))
    .join(',')
}

/** `b` over `a`, mappings merged key by key (so a filter can add to a call's nested params). */
function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v
  return out
}

/** The list call's args for a search: the call's own, then each active filter's merged on top. */
export function listArgs(view: ViewSpec, query: string, filterIds: string, page = 1): Record<string, unknown> {
  const on = activeFilters(view, filterIds)
  const ctx = { query: query.trim(), filter: on.map(f => f.id).join(','), page }
  let out = fillArgs(view.list.call.args, ctx) as Record<string, unknown>
  for (const f of on) out = deepMerge(out, fillArgs(f.args, ctx) as Record<string, unknown>)
  return out
}

// ── ranges ──────────────────────────────────────────────────────────────────

const iso = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
const parseDay = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined
}

/** The days a range covers: a Monday-to-Sunday week, a month, a year, or the year to the anchor. */
export function rangeOf(mode: string, anchor: string): { mode: string; start: string; end: string; label: string } {
  const d = parseDay(anchor) ?? new Date(0)
  const y = d.getUTCFullYear()
  const mo = d.getUTCMonth()
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  if (mode === 'week') {
    const start = new Date(d)
    start.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
    const end = new Date(start)
    end.setUTCDate(start.getUTCDate() + 6)
    return { mode, start: iso(start), end: iso(end), label: `${MONTHS[start.getUTCMonth()]} ${start.getUTCDate()} – ${MONTHS[end.getUTCMonth()]} ${end.getUTCDate()}, ${end.getUTCFullYear()}` }
  }
  if (mode === 'month') {
    const start = new Date(Date.UTC(y, mo, 1))
    const end = new Date(Date.UTC(y, mo + 1, 0))
    return { mode, start: iso(start), end: iso(end), label: `${MONTHS[mo]} ${y}` }
  }
  if (mode === 'ytd') return { mode, start: `${y}-01-01`, end: iso(d), label: `${y} to ${MONTHS[mo]} ${d.getUTCDate()}` }
  return { mode: 'year', start: `${y}-01-01`, end: `${y}-12-31`, label: String(y) }
}

/** The anchor one period earlier (-1) or later (1). */
export function shiftAnchor(mode: string, anchor: string, by: -1 | 1): string {
  const d = parseDay(anchor) ?? new Date(0)
  if (mode === 'week') d.setUTCDate(d.getUTCDate() + 7 * by)
  else if (mode === 'month') d.setUTCMonth(d.getUTCMonth() + by, 1)
  else d.setUTCFullYear(d.getUTCFullYear() + by)
  return iso(d)
}

// ── forms ───────────────────────────────────────────────────────────────────

/** A form's values typed for a call: numbers as numbers, toggles as booleans, blanks left out. */
export function formValues(fields: ViewField[], values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const raw = values[f.id] ?? ''
    if (f.type === 'toggle') out[f.id] = raw === 'true'
    else if (raw.trim() === '') continue
    else if (f.type === 'number') out[f.id] = Number.isFinite(Number(raw)) ? Number(raw) : raw
    else out[f.id] = raw
  }
  return out
}

/** The fields a form still needs: required ones left blank. */
export function missingFields(fields: ViewField[], values: Record<string, string>): string[] {
  return fields.filter(f => f.required && f.type !== 'toggle' && !(values[f.id] ?? '').trim()).map(f => f.label)
}

/** A form's opening values: each field's default filled from the page. */
export function formDefaults(fields: ViewField[], ctx: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) {
    const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(f.default)
    const v = whole ? evalExpr(whole[1] as string, ctx) : fillView(f.default, ctx)
    out[f.id] = f.type === 'toggle' ? String(v === true || v === 'true' || v === 1) : v === undefined || v === null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
  return out
}

/** Every call a detail page can make, by name: the page's own, then each tab's. */
export function allCalls(view: ViewSpec): Record<string, ViewCall> {
  const out: Record<string, ViewCall> = { ...(view.detail?.calls ?? {}) }
  for (const t of view.detail?.tabs ?? []) Object.assign(out, t.calls)
  return out
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

function parseCalls(raw: unknown, at: string, errors: string[], taken: Set<string>): Record<string, ViewCall> {
  const calls: Record<string, ViewCall> = {}
  if (raw === undefined) return calls
  if (!isObj(raw)) {
    errors.push(`${at}: must be a mapping of name: { server, tool, args }`)
    return calls
  }
  for (const [name, c] of Object.entries(raw)) {
    if (!CALL_NAME_RE.test(name)) errors.push(`${at}.${name}: a call name is lowercase letters, digits or _`)
    else if (RESERVED.includes(name)) errors.push(`${at}.${name}: "${name}" is a template name; call it something else`)
    else if (taken.has(name)) errors.push(`${at}.${name}: "${name}" is already a call of this page`)
    taken.add(name)
    const parsed = parseCall(c, `${at}.${name}`, errors)
    if (parsed) calls[name] = parsed
  }
  return calls
}

function parseRows(raw: Record<string, unknown>, at: string, errors: string[], textKey: 'title' | 'text'): ViewRows {
  const items = str(raw.items)
  if (!items) errors.push(`${at}.items: is empty (the path to the list in the result)`)
  const line = str(raw[textKey])
  if (!line) errors.push(`${at}.${textKey}: is empty`)
  return {
    items,
    text: line,
    ...(str(raw.subtitle) ? { subtitle: str(raw.subtitle) } : {}),
    ...(str(raw.dot) ? { dot: str(raw.dot) } : {}),
    empty: str(raw.empty) || 'Nothing here.',
    limit: parseLimit(raw.limit, at, errors),
  }
}

function parseLimit(raw: unknown, at: string, errors: string[]): number {
  const limit = raw === undefined ? 25 : Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) errors.push(`${at}.limit: must be a whole number from 1 to ${MAX_ROWS}`)
  return Number.isInteger(limit) ? Math.min(MAX_ROWS, Math.max(1, limit)) : 25
}

const FIELD_TYPES = ['text', 'textarea', 'number', 'toggle', 'select', 'date'] as const

function parseActions(raw: unknown, at: string, errors: string[]): ViewAction[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    errors.push(`${at}: must be a list of { id, label, mcp }`)
    return []
  }
  const out: ViewAction[] = []
  raw.forEach((a, i) => {
    const where = `${at}[${i}]`
    if (!isObj(a)) return void errors.push(`${where}: must be { id, label, mcp }`)
    const id = str(a.id) || `action_${i + 1}`
    if (!ID_RE.test(id)) errors.push(`${where}.id: "${id}" must be lowercase letters, digits, - or _`)
    if (out.some(x => x.id === id)) errors.push(`${where}.id: "${id}" is used twice`)
    const call = parseCall(a.mcp ?? { server: a.server, tool: a.tool, args: a.args }, `${where}.mcp`, errors)
    const fields: ViewField[] = []
    if (a.fields !== undefined && !Array.isArray(a.fields)) errors.push(`${where}.fields: must be a list`)
    ;(Array.isArray(a.fields) ? a.fields : []).forEach((f, j) => {
      const fat = `${where}.fields[${j}]`
      if (!isObj(f)) return void errors.push(`${fat}: must be { id, label, type }`)
      const fid = str(f.id)
      if (!CALL_NAME_RE.test(fid)) errors.push(`${fat}.id: "${fid}" must be lowercase letters, digits or _`)
      const type = (str(f.type) || 'text') as ViewField['type']
      if (!(FIELD_TYPES as readonly string[]).includes(type)) errors.push(`${fat}.type: "${type}" must be one of ${FIELD_TYPES.join(', ')}`)
      const options = (Array.isArray(f.options) ? f.options : []).map(o => (isObj(o) ? { value: str(o.value), label: str(o.label) || str(o.value) } : { value: str(o), label: str(o) }))
      if (type === 'select' && !options.length) errors.push(`${fat}.options: a select needs options`)
      fields.push({ id: fid, label: str(f.label) || fid, type, options, default: f.default === undefined || f.default === null ? '' : typeof f.default === 'string' ? f.default : String(f.default), required: f.required === true, ...(str(f.help) ? { help: str(f.help) } : {}) })
    })
    const style = (str(a.style) || 'plain') as ViewAction['style']
    if (!['primary', 'danger', 'plain'].includes(style)) errors.push(`${where}.style: must be primary, danger or plain`)
    for (const k of Object.keys(a)) if (!['id', 'label', 'mcp', 'server', 'tool', 'args', 'fields', 'confirm', 'style', 'done'].includes(k)) errors.push(`${where}.${k}: is not a field`)
    out.push({
      id,
      label: str(a.label) || id,
      call: call ?? { server: '', tool: '', args: {} },
      fields,
      ...(str(a.confirm) ? { confirm: str(a.confirm) } : {}),
      style: ['primary', 'danger', 'plain'].includes(style) ? style : 'plain',
      ...(str(a.done) ? { done: str(a.done) } : {}),
    })
  })
  return out
}

function parseSections(raw: unknown, at: string, errors: string[]): ViewSection[] {
  const sections: ViewSection[] = []
  if (raw === undefined) return sections
  if (!Array.isArray(raw)) {
    errors.push(`${at}: must be a list`)
    return sections
  }
  raw.forEach((sec, i) => {
    const where = `${at}[${i}]`
    if (!isObj(sec)) return void errors.push(`${where}: must be a mapping with title`)
    const stats: ViewStat[] = []
    if (sec.stats !== undefined && !Array.isArray(sec.stats)) errors.push(`${where}.stats: must be a list of { label, value }`)
    ;(Array.isArray(sec.stats) ? sec.stats : []).forEach((st, j) => {
      if (!isObj(st) || !str(st.label)) return void errors.push(`${where}.stats[${j}]: must be { label, value }`)
      stats.push({ label: str(st.label), value: str(st.value) })
    })
    const lines = Array.isArray(sec.text) ? sec.text.map(str) : sec.text === undefined ? [] : [str(sec.text)]
    let rows: ViewRows | undefined
    if (sec.rows !== undefined) {
      if (!isObj(sec.rows)) errors.push(`${where}.rows: must be { items, text }`)
      else rows = parseRows(sec.rows, `${where}.rows`, errors, 'text')
    }
    let table: ViewTable | undefined
    if (sec.table !== undefined) {
      const t = isObj(sec.table) ? sec.table : {}
      if (!isObj(sec.table)) errors.push(`${where}.table: must be { items, columns }`)
      if (!str(t.items)) errors.push(`${where}.table.items: is empty`)
      const cols = Array.isArray(t.columns) ? t.columns : []
      if (!cols.length) errors.push(`${where}.table.columns: needs at least one { label, value }`)
      table = {
        items: str(t.items),
        columns: cols.map((c, j) => {
          if (!isObj(c) || !str(c.label)) errors.push(`${where}.table.columns[${j}]: must be { label, value }`)
          return { label: isObj(c) ? str(c.label) : '', value: isObj(c) ? str(c.value) : '' }
        }),
        empty: str(t.empty) || 'Nothing here.',
        limit: parseLimit(t.limit, `${where}.table`, errors),
      }
    }
    let chart: ViewChart | undefined
    if (sec.chart !== undefined) {
      const c = isObj(sec.chart) ? sec.chart : {}
      if (!str(c.items) || !str(c.label) || !str(c.value)) errors.push(`${where}.chart: needs items, label and value`)
      chart = { items: str(c.items), label: str(c.label), value: str(c.value), ...(str(c.title) ? { title: str(c.title) } : {}) }
    }
    const actions = parseActions(sec.actions, `${where}.actions`, errors)
    const rowActions = parseActions(sec.row_actions, `${where}.row_actions`, errors)
    if (rowActions.length && !rows && !table) errors.push(`${where}.row_actions: needs rows or table to go on`)
    for (const k of Object.keys(sec)) if (!['title', 'from', 'stats', 'text', 'rows', 'table', 'chart', 'pairs', 'actions', 'row_actions'].includes(k)) errors.push(`${where}.${k}: is not a field`)
    sections.push({
      title: str(sec.title) || `Section ${i + 1}`,
      ...(str(sec.from) ? { from: str(sec.from) } : {}),
      stats,
      text: lines.filter(Boolean),
      ...(rows ? { rows } : {}),
      ...(table ? { table } : {}),
      ...(chart ? { chart } : {}),
      ...(str(sec.pairs) ? { pairs: str(sec.pairs) } : {}),
      actions,
      row_actions: rowActions,
    })
  })
  return sections
}

const RANGE_MODES = ['week', 'month', 'year', 'ytd'] as const

function parseRange(raw: unknown, at: string, errors: string[]): ViewRange | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined
  const r = isObj(raw) ? raw : {}
  const modes = (Array.isArray(r.modes) ? r.modes.map(str) : ['week', 'month', 'year']) as ViewRange['modes']
  for (const m of modes) if (!(RANGE_MODES as readonly string[]).includes(m)) errors.push(`${at}.modes: "${m}" must be one of ${RANGE_MODES.join(', ')}`)
  const def = (str(r.default) || modes[0] || 'month') as ViewRange['default']
  if (!modes.includes(def)) errors.push(`${at}.default: "${def}" is not one of its modes`)
  return { modes, default: def }
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
        filters.push({ id: fid, label: str(f.label) || fid, group: str(f.group) || 'default', args: isObj(f.args) ? f.args : {} })
      })
  }

  const rawList = isObj(doc.list) ? doc.list : undefined
  if (!rawList) errors.push('list: is missing (the call that finds the items, and how to show each)')
  const listCall = parseCall(rawList ?? {}, 'list.mcp', errors) ?? { server: '', tool: '', args: {} }
  const listRows = parseRows(rawList ?? {}, 'list', errors, 'title')
  const key = str(rawList?.key)
  if (rawList && !key) errors.push("list.key: is empty (the path to each item's id)")
  for (const k of Object.keys(rawList ?? {}))
    if (!['mcp', 'server', 'tool', 'args', 'items', 'key', 'title', 'subtitle', 'dot', 'empty', 'limit', 'count', 'paged'].includes(k)) errors.push(`list.${k}: is not a field`)

  let detail: ViewSpec['detail']
  if (doc.detail !== undefined) {
    const d = isObj(doc.detail) ? doc.detail : {}
    if (!isObj(doc.detail)) errors.push('detail: must be a mapping with calls, sections or tabs')
    for (const k of Object.keys(d)) if (!['title', 'subtitle', 'calls', 'actions', 'sections', 'tabs'].includes(k)) errors.push(`detail.${k}: is not a field`)
    const taken = new Set<string>()
    const calls = parseCalls(d.calls, 'detail.calls', errors, taken)
    const tabs: ViewTab[] = []
    if (d.tabs !== undefined && !Array.isArray(d.tabs)) errors.push('detail.tabs: must be a list')
    ;(Array.isArray(d.tabs) ? d.tabs : []).forEach((t, i) => {
      const at = `detail.tabs[${i}]`
      if (!isObj(t)) return void errors.push(`${at}: must be { id, title, sections }`)
      const tid = str(t.id) || `tab_${i + 1}`
      if (!ID_RE.test(tid)) errors.push(`${at}.id: "${tid}" must be lowercase letters, digits, - or _`)
      if (tabs.some(x => x.id === tid)) errors.push(`${at}.id: "${tid}" is used twice`)
      for (const k of Object.keys(t)) if (!['id', 'title', 'calls', 'range', 'sections', 'actions'].includes(k)) errors.push(`${at}.${k}: is not a field`)
      tabs.push({
        id: tid,
        title: str(t.title) || tid,
        calls: parseCalls(t.calls, `${at}.calls`, errors, taken),
        ...((): { range?: ViewRange } => {
          const r = parseRange(t.range, `${at}.range`, errors)
          return r ? { range: r } : {}
        })(),
        sections: parseSections(t.sections, `${at}.sections`, errors),
        actions: parseActions(t.actions, `${at}.actions`, errors),
      })
    })
    detail = {
      title: str(d.title) || '{{key}}',
      ...(str(d.subtitle) ? { subtitle: str(d.subtitle) } : {}),
      calls,
      actions: parseActions(d.actions, 'detail.actions', errors),
      sections: parseSections(d.sections, 'detail.sections', errors),
      tabs,
    }
    const names = new Set(Object.keys(calls))
    const fromCheck = (secs: ViewSection[], where: string, own: Record<string, ViewCall>) =>
      secs.forEach((sec, i) => {
        if (sec.from && !names.has(sec.from) && !own[sec.from]) errors.push(`${where}[${i}].from: no call "${sec.from}" on this page or tab`)
      })
    fromCheck(detail.sections, 'detail.sections', {})
    detail.tabs.forEach((t, i) => fromCheck(t.sections, `detail.tabs[${i}].sections`, t.calls))
  }

  // Every template names something the view has, and only known filters.
  const callNames = Object.keys(detail ? allCalls({ detail } as ViewSpec) : {})
  const pageNames = ['query', 'filter', 'page', 'key', 'item', 'range', ...callNames]
  const check = (where: string, template: string, names: string[]) => {
    for (const r of roots(template)) if (!names.includes(r)) errors.push(`${where}: {{${r}...}} names nothing (use ${names.join(', ')})`)
    for (const f of badFilters(template)) errors.push(`${where}: no filter "${f}" (${VIEW_FILTERS.join(', ')})`)
  }
  for (const s of deepStrings(listCall.args)) check('list.mcp.args', s, ['query', 'filter', 'page'])
  for (const f of filters) for (const s of deepStrings(f.args)) check(`filters.${f.id}.args`, s, ['query', 'filter', 'page'])
  for (const [k, v] of [['list.title', listRows.text], ['list.subtitle', listRows.subtitle ?? '']] as const) check(k, v, ['query', 'filter', 'page', 'item'])
  const checkActions = (where: string, actions: ViewAction[], names: string[]) =>
    actions.forEach(a => {
      for (const s of deepStrings(a.call.args)) check(`${where}.${a.id}.args`, s, [...names, 'form'])
      if (a.confirm) check(`${where}.${a.id}.confirm`, a.confirm, [...names, 'form'])
      if (a.done) check(`${where}.${a.id}.done`, a.done, [...names, 'form'])
      for (const f of a.fields) check(`${where}.${a.id}.fields.${f.id}.default`, f.default, names)
    })
  const checkSections = (where: string, secs: ViewSection[]) =>
    secs.forEach((sec, i) => {
      const at = `${where}[${i}]`
      const rowNames = [...pageNames, 'row']
      for (const st of sec.stats) check(`${at}.stats.${st.label}`, st.value, pageNames)
      for (const line of sec.text) check(`${at}.text`, line, pageNames)
      if (sec.rows) {
        check(`${at}.rows.text`, sec.rows.text, rowNames)
        if (sec.rows.subtitle) check(`${at}.rows.subtitle`, sec.rows.subtitle, rowNames)
      }
      for (const c of sec.table?.columns ?? []) check(`${at}.table.${c.label}`, c.value, rowNames)
      if (sec.chart) for (const t of [sec.chart.label, sec.chart.value]) check(`${at}.chart`, t, rowNames)
      checkActions(`${at}.actions`, sec.actions, pageNames)
      checkActions(`${at}.row_actions`, sec.row_actions, rowNames)
    })
  if (detail) {
    for (const [name, c] of Object.entries(detail.calls)) for (const s of deepStrings(c.args)) check(`detail.calls.${name}.args`, s, ['query', 'filter', 'key'])
    // A tab's calls run once the page's have answered, so they can use them (a user id from the profile).
    detail.tabs.forEach((t, i) => {
      for (const [name, c] of Object.entries(t.calls)) for (const s of deepStrings(c.args)) check(`detail.tabs[${i}].calls.${name}.args`, s, ['query', 'filter', 'key', 'range', ...Object.keys(detail?.calls ?? {})])
    })
    check('detail.title', detail.title, pageNames)
    if (detail.subtitle) check('detail.subtitle', detail.subtitle, pageNames)
    checkActions('detail.actions', detail.actions, pageNames)
    checkSections('detail.sections', detail.sections)
    detail.tabs.forEach((t, i) => {
      checkSections(`detail.tabs[${i}].sections`, t.sections)
      checkActions(`detail.tabs[${i}].actions`, t.actions, pageNames)
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
      list: { call: listCall, rows: listRows, key, paged: rawList?.paged === true, ...(str(rawList?.count) ? { count: str(rawList?.count) } : {}) },
      ...(detail ? { detail } : {}),
    }
  return found
}
