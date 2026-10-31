// Workflow runs: finds the flow.yaml folders, starts runs, schedules their steps
// (shell commands, python scripts, MCP tool calls, HTTP requests, flow agents,
// approvals, prompts to the main session), keeps
// each run's folder (run.json, <step>.log) and serves the flow tools.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessSpawnResult, Register, Timer, TurnCompleteInput } from 'claude-code'

import type { Found, FoundView, HubInputSearch, InputOption, ItemRun, Layout, LayoutGroup, Run, RunStatus, Source, SourceState, StepRun, StepSpec, StepStatus, Tier, ViewAction, ViewCall, ViewPart, ViewSpec, ViewState, ViewTab, Workflow } from '../types'
import { LAYOUT_FILE, layoutYaml, parseLayout, parseSources, rawSources } from './layout'
import { VIEW_FILE, activeFilters, fillArgs, fillView, formValues, getPath, listArgs, missingFields, parseResult, parseView, pickRows, rangeOf, shiftAnchor } from './views'
import { rememberValues } from './file-finder'
import {
  WORK_KINDS,
  checksStatus,
  deepMap,
  defaultValue,
  evalCondition,
  fill,
  inputProblems,
  isAIStep,
  parseCondition,
  parseJson,
  parseWorkflow,
  shQuote,
  stepEnvNames,
  stepLevels,
  untilTime,
} from './spec'
import type { ConditionScope, TemplateContext } from './spec'
import { hubRunStarted, hubSessionStart, hubTick, showView } from './hub-state'

export const workflowsAtom = atom({ plugin: 'flow', key: 'workflows' } as const, [], { shape: 'workflows-1' })
/** The flows folder's flows.yaml: how the Workflows page groups and orders them. */
export const layoutAtom = atom({ plugin: 'flow', key: 'layout' } as const, { groups: [], errors: [] } as Layout, { shape: 'layout-1' })
export const runsAtom = atom({ plugin: 'flow', key: 'runs' } as const, [], { shape: 'runs-1' })
export const viewsAtom = atom({ plugin: 'flow', key: 'views' } as const, [] as FoundView[], { shape: 'views-1' })
export const viewStatesAtom = atom({ plugin: 'flow', key: 'viewStates' } as const, {} as Record<string, ViewState>, { shape: 'view-states-1' })
export const hubInputSearch = atom({ plugin: 'flow', key: 'hubInputSearch' } as const, {} as HubInputSearch, { shape: 'hub-input-search-1' })

const MAX_RUNS = 30
/** Run and agent steps (or for_each items) going at once in one run. */
const MAX_PARALLEL = 6
/** How many uses steps deep a run may nest below the run the user started. */
const MAX_DEPTH = 3
const OUTPUT_MAX = 20_000
const TAIL_MAX = 4_000
// fs.write takes at most 4 MiB: a log is kept to a million characters.
const LOG_MAX = 1_000_000
const STATE_MS = 300
const LOG_MS = 500
const STEP_LOG_MAX = 200_000
const RUN_ID_RE = /^\d{8}-\d{6}-[a-z0-9]{4}$/
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const TOOL = (name: string) => `mcp__flow__${name}`

type $ = EngineInterface

type Log = { text: string; isTruncated: boolean; timer?: Timer }

/** A run this module drives: the copy it changes, the workflow it runs, and what stops its steps. */
type Live = {
  run: Run
  wf: Workflow
  stops: Map<string, () => void>
  logs: Map<string, Log>
  syncTimer?: Timer
  /** run.json writes, one after another. */
  writes: Promise<void>
  /** {{env.NAME}} values resolved for this run: never logged (each is *** in logs, outputs and errors). */
  secrets?: Map<string, string>
}

/** Replaces each resolved {{env.NAME}} value with ***. */
function redact(ctx: Live, text: string): string {
  if (!ctx.secrets?.size || !text) return text
  let out = text
  for (const value of ctx.secrets.values()) if (value) out = out.split(value).join('***')
  return out
}

const longestSecret = (ctx: Live) => Math.max(0, ...[...(ctx.secrets?.values() ?? [])].map(v => v.length))

// Module state. registerRunner clears it on every (re)load: a reload kills the
// children, and the runs left in the atom are taken over by `hydrate`.
const live = new Map<string, Live>()
type AgentHit = { runId: string; stepId: string; index?: number }
const agentSteps = new Map<string, AgentHit>()
const queuedPrompts: { runId: string; stepId: string; text: string }[] = []
let workflowsDir = '~/Documents/flows'
/** Sources tried for a clone this load, so a bad URL is not cloned again on every refresh. */
const cloneTried = new Set<string>()
/** The last pull of each source, by name. */
const pulls = new Map<string, { at: number; error?: string }>()
let sessionCwd: string | undefined
let isHydrated = false

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const errText = (err: unknown) => String((err as Error)?.message ?? err).split('\n')[0] ?? 'error'
const isEnded = (s: StepStatus) => s !== 'pending' && s !== 'running' && s !== 'waiting'
const pad2 = (n: number) => String(n).padStart(2, '0')

async function home($: $): Promise<string> {
  return ((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
}

const expand = (path: string, homeDir: string) => (path === '~' ? homeDir : path.startsWith('~/') ? `${homeDir}${path.slice(1)}` : path)

async function cwdOf($: $): Promise<string> {
  return sessionCwd ?? (await $.session.cwd())
}

// ---------------------------------------------------------------------------
// Discovery

/** git, with a minute to finish; the error is its last stderr line. */
async function git($: $, argv: string[], cwd?: string): Promise<string | undefined> {
  try {
    const r = await $.process.run(['git', ...argv], { ...(cwd ? { cwd } : {}), timeoutMs: 60_000, env: { GIT_TERMINAL_PROMPT: '0' } })
    if (r.exitCode === 0) return undefined
    return (r.stderr.trim().split('\n').pop() || `git ${argv[0]} exited ${r.exitCode}`).trim()
  } catch (err) {
    return errText(err)
  }
}

async function cloneSource($: $, src: Source): Promise<string | undefined> {
  if (!src.git) return `${src.path} does not exist`
  const parent = src.path.replace(/\/[^/]+$/, '')
  return git($, ['clone', '--quiet', ...(src.branch ? ['--branch', src.branch] : []), src.git, src.path], parent || undefined)
}

/**
 * Pulls every source (fast-forward only), cloning the ones not here yet,
 * then reads everything again. Returns one line per source.
 */
export async function pullSources($: $): Promise<string[]> {
  const { sources } = await readSources($)
  const lines: string[] = []
  for (const src of sources) {
    const isRepo = await $.fs.exists(`${src.path}/.git`).catch(() => false)
    const isHere = isRepo || (await $.fs.exists(src.path).catch(() => false))
    if (isHere && !isRepo) {
      lines.push(`${src.title}: a plain folder, nothing to pull (${src.path})`)
      continue
    }
    const error = isRepo ? await git($, ['pull', '--ff-only', '--quiet'], src.path) : await cloneSource($, src)
    pulls.set(src.name, { at: await $.clock.now(), ...(error ? { error } : {}) })
    lines.push(`${src.title}: ${error ? `failed: ${error}` : isRepo ? 'pulled' : 'cloned'} (${src.path})`)
  }
  await refreshWorkflows($)
  return lines.length ? lines : [`no sources in ${workflowsDir}/${LAYOUT_FILE}`]
}

async function readSources($: $) {
  const homeDir = await home($)
  const base = expand(workflowsDir, homeDir).replace(/\/+$/, '')
  const layoutFile = `${base}/${LAYOUT_FILE}`
  const text = (await $.fs.exists(layoutFile).catch(() => false)) ? await $.fs.read(layoutFile).catch(() => '') : ''
  return { base, layoutFile, text, ...parseSources(text, homeDir) }
}

/** Reads every workflow folder (the workflows folder, each source, then <cwd>/.flows) into `workflows`. */
export async function refreshWorkflows($: $): Promise<Found[]> {
  const { base, layoutFile, text, sources, errors: sourceErrors } = await readSources($)
  // A source with a git URL that is not here yet is cloned, once per load.
  for (const src of sources) {
    if (!src.git || cloneTried.has(src.name) || (await $.fs.exists(src.path).catch(() => false))) continue
    cloneTried.add(src.name)
    const error = await cloneSource($, src)
    pulls.set(src.name, { at: await $.clock.now(), ...(error ? { error } : {}) })
  }
  const local = `${(await cwdOf($)).replace(/\/+$/, '')}/.flows`
  const folders: { path: string; source?: string }[] = [{ path: base }]
  for (const src of sources) if (src.path !== base && src.path !== local) folders.push({ path: src.path, source: src.name })
  if (local !== base) folders.push({ path: local })
  const found: Found[] = []
  const views: FoundView[] = []
  for (const { path: folder, source } of folders) {
    if (!folder || !(await $.fs.exists(folder).catch(() => false))) continue
    const entries = await $.fs.list(folder).catch(() => [])
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || !(entry.kind === 'dir' || entry.isLink)) continue
      const dir = `${folder}/${entry.name}`
      const viewFile = `${dir}/${VIEW_FILE}`
      if (await $.fs.exists(viewFile).catch(() => false)) {
        let v: FoundView
        try {
          v = parseView(await $.fs.read(viewFile), dir, viewFile)
        } catch (err) {
          v = { id: entry.name, dir, file: viewFile, errors: [`cannot read ${viewFile}: ${errText(err)}`] }
        }
        if (source) v.source = source
        const first = views.find(x => x.id === v.id)
        if (first) v.errors.push(`id: "${v.id}" is already used by ${first.file}`)
        views.push(v)
      }
      const file = `${dir}/flow.yaml`
      if (!(await $.fs.exists(file).catch(() => false))) continue
      let f: Found
      try {
        f = parseWorkflow(await $.fs.read(file), dir, file)
      } catch (err) {
        f = { id: entry.name, dir, file, errors: [`cannot read ${file}: ${errText(err)}`] }
      }
      if (source) f.source = source
      const first = found.find(x => x.id === f.id)
      if (first) f.errors.push(`id: "${f.id}" is already used by ${first.file}`)
      found.push(f)
    }
  }
  await update($, workflowsAtom, () => found)
  await update($, viewsAtom, () => views)

  // Each source's own flows.yaml groups, titled "<source> · <group>", then the rest of its workflows under its title.
  const states: SourceState[] = []
  for (const src of sources) {
    const ids = found.filter(f => f.source === src.name).map(f => f.id)
    const own = `${src.path}/${LAYOUT_FILE}`
    const ownText = (await $.fs.exists(own).catch(() => false)) ? await $.fs.read(own).catch(() => '') : ''
    const groups = parseLayout(ownText).groups.map(g => ({ title: `${src.title} · ${g.title}`, workflows: g.workflows.filter(id => ids.includes(id)) }))
    const pull = pulls.get(src.name)
    states.push({
      ...src,
      isPresent: await $.fs.exists(src.path).catch(() => false),
      count: ids.length,
      groups: [...groups, { title: src.title, workflows: ids }],
      ...(pull ? { pulledAt: pull.at, ...(pull.error ? { error: pull.error } : {}) } : {}),
    })
  }
  const parsed = parseLayout(text)
  const errors = [...parsed.errors, ...sourceErrors, ...states.filter(s => s.error).map(s => `sources: ${s.name}: ${s.error}`)]
  await update($, layoutAtom, () => ({ ...parsed, errors, file: layoutFile, sources: states }))
  return found
}

// ---------------------------------------------------------------------------
// Views: the list and detail calls behind the Views tab

/** A result kept in state at most this big; a bigger one is an error that says so. */
const VIEW_RESULT_MAX = 400_000

async function viewCall($: $, c: ViewCall, ctx: Record<string, unknown>): Promise<unknown> {
  const args = fillArgs(c.args, ctx) as Record<string, unknown>
  const r = await $.mcp.call(c.server, c.tool, args)
  const out = r.content.map(b => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('')
  if (r.isError) throw new Error(out.trim().split('\n')[0] || `${c.server} ${c.tool} failed`)
  if (out.length > VIEW_RESULT_MAX) throw new Error(`${c.tool} answered ${Math.round(out.length / 1000)} kB, too much to show: trim it in the tool (no full: true)`)
  // Claude Code keeps a result over its size limit in a file and answers with a note about it.
  if (/exceeds maximum allowed tokens|Output has been saved to/i.test(out.slice(0, 400)))
    throw new Error(`${c.tool} answered more than Claude Code passes on: ask for less (fields, omit, max_items, a smaller limit)`)
  const value = parseResult(out)
  // JSON that does not parse was cut short on the way: say so, rather than draw an empty page.
  if (typeof value === 'string' && /^\s*[[{]/.test(value))
    throw new Error(`${c.tool}'s answer (${Math.round(out.length / 1000)} kB) was cut short: ask for less (fields, omit, a smaller limit)`)
  return value
}

const viewError = (err: unknown, c: ViewCall) => {
  const msg = errText(err)
  if (/unknown tool|tool .*not found|no such tool|no connected MCP tool/i.test(msg)) return `${c.server} has no tool ${c.tool} yet: update or restart its server, then reconnect it in /mcp`
  // Auto mode refuses a plugin's MCP call it was not asked about: an allow rule lets it through.
  if (/refused|classifier|not allowed|permission/i.test(msg))
    return `Claude Code did not allow ${c.server} ${c.tool}. Add "mcp__${c.server.replace(/[^A-Za-z0-9_-]/g, '_')}__${c.tool}" to permissions.allow in ~/.claude/settings.json, then press Refresh.`
  return msg
}

async function viewOf($: $, id: string): Promise<ViewSpec | undefined> {
  let all = await read($, viewsAtom)
  if (!all.some(v => v.id === id)) {
    await refreshWorkflows($)
    all = await read($, viewsAtom)
  }
  return all.find(v => v.id === id && v.view)?.view
}

async function setViewState($: $, id: string, change: (s: ViewState) => ViewState): Promise<ViewState | undefined> {
  await update($, viewStatesAtom, all => {
    const cur: ViewState = { query: '', filter: '', page: 1, list: { state: 'loading' }, key: '', detail: {}, tab: '', ranges: {}, ...all[id] }
    return { ...all, [id]: change(cur) }
  })
  // Read it back: the change may run after update resolves its caller.
  return (await read($, viewStatesAtom))[id]
}

/** Runs a view's list call for a search, filters (one per group; each group's first by default) and a page. */
export async function viewSearch($: $, id: string, query: string, filter?: string, page = 1): Promise<ViewState | undefined> {
  const view = await viewOf($, id)
  if (!view) return undefined
  const prev = (await read($, viewStatesAtom))[id]
  const f = activeFilters(view, filter ?? prev?.filter ?? '').map(x => x.id).join(',')
  const p = Math.max(1, Math.floor(page))
  await setViewState($, id, s => ({ ...s, query, filter: f, page: p, list: { state: 'loading' }, key: '', open: undefined, notice: undefined }))
  let list: ViewPart
  try {
    const value = await viewCall($, { ...view.list.call, args: listArgs(view, query, f, p) }, {})
    const { items, total } = pickRows(view.list.rows, value)
    const count = view.list.count ? Number(getPath(value, view.list.count)) : NaN
    list = { state: 'ok', value: { items, total: Number.isFinite(count) ? count : total } }
  } catch (err) {
    list = { state: 'error', message: viewError(err, view.list.call) }
  }
  return setViewState($, id, s => (s.query === query && s.filter === f && s.page === p ? { ...s, list } : s))
}

/**
 * A search input's suggestions for what was typed: its call with `{{query}}`
 * filled, each item made an option. Only the answer to the latest text is kept,
 * so a slow answer to an earlier keystroke never replaces a newer one.
 */
export async function inputSearch($: $, workflowId: string, inputId: string, query: string): Promise<void> {
  const wf = (await read($, workflowsAtom)).find(f => f.id === workflowId)?.workflow
  const search = wf?.inputs.find(i => i.id === inputId)?.search
  if (!search) return
  const key = `${workflowId}:${inputId}`
  const q = query.trim()
  if (q.length < search.min) {
    await update($, hubInputSearch, all => ({ ...all, [key]: { query: q, state: 'idle' as const, options: [] } }))
    return
  }
  await update($, hubInputSearch, all => ({ ...all, [key]: { query: q, state: 'loading' as const, options: all[key]?.options ?? [] } }))
  let next: HubInputSearch[string]
  try {
    const value = await viewCall($, { ...search.call, args: fillArgs(search.call.args, { query: q }) as Record<string, unknown> }, {})
    const list = getPath(value, search.items)
    const options: InputOption[] = (Array.isArray(list) ? list : []).slice(0, search.limit).map(item => {
      const sub = search.subtitle ? fillView(search.subtitle, { item }) : ''
      return { value: fillView(search.value, { item }), title: fillView(search.title, { item }), ...(sub ? { subtitle: sub } : {}) }
    })
    next = { query: q, state: 'ok' as const, options: options.filter(o => o.value) }
  } catch (err) {
    next = { query: q, state: 'error' as const, options: [], message: viewError(err, search.call) }
  }
  await update($, hubInputSearch, all => (all[key]?.query === q ? { ...all, [key]: { ...next, ...(all[key]?.picked ? { picked: all[key]?.picked } : {}) } } : all))
}

/** A search input's pick, or `undefined` to drop it (the person typed again). */
export async function inputPick($: $, workflowId: string, inputId: string, picked: InputOption | undefined): Promise<void> {
  const key = `${workflowId}:${inputId}`
  await update($, hubInputSearch, all => {
    const cur = all[key] ?? { query: '', state: 'idle' as const, options: [] }
    const { picked: _, ...rest } = cur
    return { ...all, [key]: picked ? { ...rest, state: 'idle' as const, options: [], picked } : rest }
  })
}

async function todayIso($: $): Promise<string> {
  return new Date(await $.clock.now()).toISOString().slice(0, 10)
}

/** The tab a state shows: the one it names, else the first. */
export function tabOf(view: ViewSpec, state: Pick<ViewState, 'tab'> | undefined): ViewTab | undefined {
  const tabs = view.detail?.tabs ?? []
  return tabs.find(t => t.id === state?.tab) ?? tabs[0]
}

/** A tab's range now: its mode and the days it covers. */
export function tabRange(tab: ViewTab | undefined, state: Pick<ViewState, 'ranges'> | undefined, today: string) {
  if (!tab?.range) return undefined
  const r = state?.ranges?.[tab.id]
  return rangeOf(r?.mode ?? tab.range.default, r?.anchor ?? today)
}

/** Runs calls and fills each in as it answers; only while the same item is open. */
async function runDetailCalls($: $, id: string, key: string, calls: [string, ViewCall][], ctx: Record<string, unknown>): Promise<void> {
  if (!calls.length) return
  await setViewState($, id, s => ({ ...s, detail: { ...s.detail, ...Object.fromEntries(calls.map(([name]) => [name, { state: 'loading' } as ViewPart])) } }))
  await Promise.all(
    calls.map(async ([name, c]) => {
      let part: ViewPart
      try {
        part = { state: 'ok', value: await viewCall($, c, ctx) }
      } catch (err) {
        part = { state: 'error', message: viewError(err, c) }
      }
      await setViewState($, id, s => (s.key === key ? { ...s, detail: { ...s.detail, [name]: part } } : s))
    }),
  )
}

// A key of digits is a number to the tool, as the list gave it (an id).
const keyValue = (key: string) => (/^\d{1,15}$/.test(key) ? Number(key) : key)

async function loadTab($: $, view: ViewSpec, id: string, key: string, tab: ViewTab | undefined): Promise<void> {
  if (!tab) return
  const state = (await read($, viewStatesAtom))[id]
  const range = tabRange(tab, state, await todayIso($))
  // The page's answered calls are in reach (a user id from the profile, say).
  const results: Record<string, unknown> = {}
  for (const [name, part] of Object.entries(state?.detail ?? {})) if (part.state === 'ok' && view.detail?.calls[name]) results[name] = part.value
  await runDetailCalls($, id, key, Object.entries(tab.calls), { ...results, key: keyValue(key), ...(range ? { range } : {}) })
}

/** Opens one item of a view: the page's calls and its first tab's run at once, each filling in as it answers. */
export async function viewOpen($: $, id: string, key: string, tabId?: string): Promise<ViewState | undefined> {
  const view = await viewOf($, id)
  if (!view?.detail) return undefined
  const prev = (await read($, viewStatesAtom))[id]
  const tab = tabOf(view, { tab: tabId ?? (prev?.key === key ? prev.tab : '') })
  await setViewState($, id, s => ({ ...s, key, detail: {}, tab: tab?.id ?? '', open: undefined, ...(s.key === key ? {} : { notice: undefined }) }))
  // The page's calls first: the tab's may use what they answer.
  await runDetailCalls($, id, key, Object.entries(view.detail.calls), { key: keyValue(key) })
  await loadTab($, view, id, key, tab)
  return (await read($, viewStatesAtom))[id]
}

/** Shows another tab of the open item and runs its calls. */
export async function viewTab($: $, id: string, tabId: string): Promise<void> {
  const view = await viewOf($, id)
  const state = (await read($, viewStatesAtom))[id]
  if (!view?.detail || !state?.key) return
  const tab = tabOf(view, { tab: tabId })
  await setViewState($, id, s => ({ ...s, tab: tab?.id ?? '', open: undefined }))
  await loadTab($, view, id, state.key, tab)
}

/** Changes the open tab's range: another mode, or one period back (-1) or on (1); then runs its calls again. */
export async function viewRange($: $, id: string, change: { mode?: string; by?: -1 | 1 }): Promise<void> {
  const view = await viewOf($, id)
  const state = (await read($, viewStatesAtom))[id]
  const tab = view ? tabOf(view, state) : undefined
  if (!view || !state?.key || !tab?.range) return
  const today = await todayIso($)
  const cur = state.ranges[tab.id] ?? { mode: tab.range.default, anchor: today }
  const next = change.mode ? { mode: change.mode, anchor: cur.anchor } : { mode: cur.mode, anchor: shiftAnchor(cur.mode, cur.anchor, change.by ?? 1) }
  await setViewState($, id, s => ({ ...s, ranges: { ...s.ranges, [tab.id]: next } }))
  await loadTab($, view, id, state.key, tab)
}

/** Runs an action's call with the page (and its row and form) in reach, then reloads what the page shows. */
export async function viewAction($: $, id: string, action: ViewAction, ctx: Record<string, unknown>, values: Record<string, string> = {}): Promise<{ ok: boolean; text: string }> {
  const missing = missingFields(action.fields, values)
  if (missing.length) {
    const text = `${action.label}: fill in ${missing.join(', ')}`
    await setViewState($, id, s => ({ ...s, notice: { ok: false, text } }))
    return { ok: false, text }
  }
  const full = { ...ctx, form: formValues(action.fields, values) }
  await setViewState($, id, s => (s.open ? { ...s, open: { ...s.open, isRunning: true } } : s))
  let notice: { ok: boolean; text: string }
  try {
    await viewCall($, action.call, full)
    notice = { ok: true, text: action.done ? fillView(action.done, full) : `${action.label}: done` }
  } catch (err) {
    notice = { ok: false, text: `${action.label}: ${viewError(err, action.call)}` }
  }
  await setViewState($, id, s => ({ ...s, notice, open: notice.ok ? undefined : s.open ? { ...s.open, isRunning: false, isConfirming: false } : undefined }))
  if (notice.ok) {
    const state = (await read($, viewStatesAtom))[id]
    if (state?.key) await viewOpen($, id, state.key)
    else if (state) await viewSearch($, id, state.query, state.filter, state.page)
  }
  return notice
}

/** The view's open item as text: its title and each section's stats and lines, as the pane shows them. */
function viewDetailText(view: ViewSpec, state: ViewState): string {
  const d = view.detail
  if (!d) return ''
  const ctx: Record<string, unknown> = { key: state.key, query: state.query, filter: state.filter }
  const range = tabRange(tabOf(view, state), state, new Date().toISOString().slice(0, 10))
  if (range) ctx.range = range
  const errors: string[] = []
  for (const [name, part] of Object.entries(state.detail)) {
    if (part.state === 'ok') ctx[name] = part.value
    else if (part.state === 'error') errors.push(`${name}: ${part.message}`)
  }
  const lines = [fillView(d.title, ctx), ...(d.subtitle ? [fillView(d.subtitle, ctx)] : [])]
  const tab = tabOf(view, state)
  if (d.tabs.length) lines.push('', `Tabs: ${d.tabs.map(t => (t.id === tab?.id ? `[${t.title}]` : t.title)).join(' · ')} (open_view with tab opens another)`)
  for (const sec of [...d.sections, ...(tab?.sections ?? [])]) {
    const part = sec.from ? state.detail[sec.from] : undefined
    lines.push('', `## ${sec.title}`)
    if (part?.state === 'error') {
      lines.push(`(${part.message})`)
      continue
    }
    for (const st of sec.stats) lines.push(`- ${st.label}: ${fillView(st.value, ctx) || '—'}`)
    for (const t of sec.text) {
      const filled = fillView(t, ctx).trim()
      if (filled) lines.push(filled)
    }
    if (sec.rows) {
      const { items, total } = pickRows(sec.rows, ctx)
      if (!items.length) lines.push(sec.rows.empty)
      for (const row of items) lines.push(`- ${fillView(sec.rows.text, { ...ctx, row })}`)
      if (total > items.length) lines.push(`(${total - items.length} more)`)
    }
    if (sec.table) {
      const { items, total } = pickRows({ items: sec.table.items, text: '', empty: '', limit: sec.table.limit }, ctx)
      if (!items.length) lines.push(sec.table.empty)
      else lines.push(`| ${sec.table.columns.map(c => c.label).join(' | ')} |`)
      for (const row of items) lines.push(`| ${sec.table.columns.map(c => fillView(c.value, { ...ctx, row }).replace(/\|/g, '/')).join(' | ')} |`)
      if (total > items.length) lines.push(`(${total - items.length} more)`)
    }
    if (sec.chart) {
      const { items } = pickRows({ items: sec.chart.items, text: '', empty: '', limit: 30 }, ctx)
      for (const row of items) lines.push(`- ${fillView(sec.chart.label, { ...ctx, row })}: ${fillView(sec.chart.value, { ...ctx, row })}`)
    }
    if (sec.pairs) {
      const obj = getPath(ctx, sec.pairs)
      if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) lines.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    }
  }
  if (errors.length) lines.push('', ...errors.map(e => `error: ${e}`))
  return lines.join('\n')
}

/** Writes the groups to flows.yaml in the flows folder, then reads everything again. */
export async function saveLayout($: $, groups: LayoutGroup[]): Promise<void> {
  const { layoutFile, text } = await readSources($)
  await $.fs.write(layoutFile, layoutYaml(groups, rawSources(text)))
  await refreshWorkflows($)
}

// ---------------------------------------------------------------------------
// Run folders

async function writeRunJson($: $, ctx: Live): Promise<void> {
  ctx.writes = ctx.writes
    .then(() => $.fs.write(`${ctx.run.dir}/run.json`, JSON.stringify(ctx.run, null, 2)))
    .catch(() => undefined)
  await ctx.writes
}

/** Puts the live copy of the run into `runs` (newest first, at most 30). */
async function syncAtom($: $, ctx: Live): Promise<void> {
  await update($, runsAtom, list => {
    const copy = clone(ctx.run)
    const i = list.findIndex(r => r.id === copy.id)
    if (i < 0) return [copy, ...list].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RUNS)
    const next = [...list]
    next[i] = copy
    return next
  })
}

/** Output or a log changed: the state follows within 300 ms. */
function syncSoon($: $, ctx: Live): void {
  if (ctx.syncTimer) return
  ctx.syncTimer = $.clock.after(STATE_MS, () => {
    ctx.syncTimer = undefined
    void syncAtom($, ctx).catch(() => undefined)
  })
}

/** A status changed: the state and run.json follow now. */
async function saveNow($: $, ctx: Live): Promise<void> {
  ctx.syncTimer?.cancel()
  ctx.syncTimer = undefined
  await Promise.all([syncAtom($, ctx).catch(() => undefined), writeRunJson($, ctx)])
}

function logOf(ctx: Live, stepId: string): Log {
  let log = ctx.logs.get(stepId)
  if (!log) ctx.logs.set(stepId, (log = { text: '', isTruncated: false }))
  return log
}

/** Adds to a step's (or an item's, under `<step>[<i>]`) log and tail. */
function appendLog($: $, ctx: Live, key: string, rec: { tail: string }, text: string): void {
  const log = logOf(ctx, key)
  let tail = rec.tail + text
  if (ctx.secrets?.size) {
    // A secret may span two pieces: the end of what is there is redacted again with the new text.
    tail = redact(ctx, tail)
    const back = log.isTruncated ? 0 : Math.min(log.text.length, longestSecret(ctx))
    text = redact(ctx, log.text.slice(log.text.length - back) + text)
    log.text = log.text.slice(0, log.text.length - back)
  }
  if (log.text.length + text.length <= LOG_MAX) log.text += text
  else if (!log.isTruncated) {
    log.text = log.text + text.slice(0, Math.max(0, LOG_MAX - log.text.length)) + '\n[flow: the log is cut here; it passed a million characters]\n'
    log.isTruncated = true
  }
  rec.tail = tail.slice(-TAIL_MAX)
  if (!log.timer)
    log.timer = $.clock.after(LOG_MS, () => {
      log.timer = undefined
      void flushLog($, ctx, key).catch(() => undefined)
    })
}

async function flushLog($: $, ctx: Live, key: string): Promise<void> {
  const log = logOf(ctx, key)
  log.timer?.cancel()
  log.timer = undefined
  await $.fs.write(`${ctx.run.dir}/${key}.log`, log.text).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Scheduling

const specOf = (wf: Workflow, id: string) => wf.steps.find(s => s.id === id)
const stepOf = (run: Run, id: string) => run.steps.find(s => s.id === id)
const isRunEnded = (s: RunStatus) => s !== 'running' && s !== 'waiting'
const takesSlot = (spec: StepSpec) => (WORK_KINDS as readonly string[]).includes(spec.kind)

/** What one launch drives: a step, or one item of a for_each step (`key` names its log and its stop). */
type Unit = { step: StepRun; index?: number; rec: StepRun | ItemRun; key: string }

function unitOf(step: StepRun, index?: number): Unit {
  const item = index === undefined ? undefined : step.items?.[index]
  return item && index !== undefined ? { step, index, rec: item, key: `${step.id}[${index}]` } : { step, rec: step, key: step.id }
}

function computeStatus(run: Run): RunStatus {
  if (run.status === 'cancelled') return 'cancelled'
  const has = (st: StepStatus) => run.steps.some(s => s.status === st)
  if (has('running')) return 'running'
  if (has('interrupted')) return 'interrupted'
  if (has('waiting')) return 'waiting'
  if (has('pending')) return 'running'
  return has('failed') ? 'failed' : 'done'
}

/** The folder of a run a uses step started: beside this run's workflow folder in ~/.flow/runs. */
function childDir(run: Run, workflowId: string, childId: string): string {
  const root = run.dir.slice(0, Math.max(0, run.dir.length - `/${run.workflowId}/${run.id}`.length))
  return `${root}/${workflowId}/${childId}`
}

const itemOf = (spec: StepSpec, index: number, value: string) => ({ value, index, as: spec.as ?? 'item' })

/** The templates without {{steps.<id>.files}}: what `outputs:` paths are filled with. */
function baseContext(run: Run): TemplateContext {
  const outputs: Record<string, string> = {}
  for (const s of run.steps) if (s.status === 'done') outputs[s.id] = s.output
  return { inputs: run.inputs, outputs, runDir: run.dir }
}

/** A step's `outputs:`, filled (per item for a for_each step) and relative to the run folder. */
function outputPaths(run: Run, spec: StepSpec, step: StepRun, index?: number): string[] {
  const base = baseContext(run)
  const units = spec.forEach === undefined ? [undefined] : index !== undefined ? [index] : (step.items ?? []).map((_, i) => i)
  const paths: string[] = []
  for (const i of units) {
    const item = i === undefined ? undefined : itemOf(spec, i, step.items?.[i]?.value ?? '')
    for (const p of spec.outputs ?? []) {
      const rel = fill(p, { ...base, item }).trim().replace(/^\.\/+/, '')
      if (rel && !paths.includes(rel)) paths.push(rel)
    }
  }
  return paths
}

function templateContext(ctx: Live, item?: TemplateContext['item']): TemplateContext {
  const { run, wf } = ctx
  const base = baseContext(run)
  const files: Record<string, string[]> = {}
  const dirs: Record<string, string> = {}
  for (const s of run.steps) {
    const spec = specOf(wf, s.id)
    if (!spec) continue
    if (s.status === 'done') files[s.id] = outputPaths(run, spec, s).map(p => `${run.dir}/${p}`)
    if (spec.kind === 'uses') dirs[s.id] = s.childRun ? childDir(run, spec.uses ?? spec.body, s.childRun) : ''
  }
  return { ...base, files, dirs, item }
}

function conditionScope(run: Run, spec: StepSpec): ConditionScope {
  const steps: ConditionScope['steps'] = {}
  for (const s of run.steps) steps[s.id] = { status: s.status, output: s.output, exit: s.exitCode === undefined ? '' : String(s.exitCode) }
  return { inputs: run.inputs, steps, after: spec.after.map(id => stepOf(run, id)?.status ?? '') }
}

/** Run and agent units going now: each step, or each item of a for_each step. */
function runningUnits(ctx: Live): number {
  let n = 0
  for (const s of ctx.run.steps) {
    const spec = specOf(ctx.wf, s.id)
    if (!spec || !takesSlot(spec)) continue
    if (s.items) n += s.items.filter(i => i.status === 'running').length
    else if (s.status === 'running') n++
  }
  return n
}

/** A for_each step's items: its list, or its template filled and split on newlines and commas. */
function itemValues(ctx: Live, spec: StepSpec): string[] {
  const tctx = templateContext(ctx)
  if (Array.isArray(spec.forEach)) return spec.forEach.map(v => fill(v, tctx).trim()).filter(Boolean)
  return fill(spec.forEach ?? '', tctx)
    .split(/[\n,]/)
    .map(v => v.trim())
    .filter(Boolean)
}

type Decision = 'wait' | 'skip' | 'condition' | 'start' | { error: string }

/** Skips what can no longer run, starts what can (6 run or agent units at a time), and sets the run's status. */
async function pump($: $, ctx: Live): Promise<void> {
  const { run, wf } = ctx
  const at = await $.clock.now()
  let isAgain = false
  if (run.status !== 'cancelled') {
    const blocks = (id: string) => {
      const dep = stepOf(run, id)
      if (!dep) return true
      if (dep.status === 'failed') return !specOf(wf, id)?.continueOnFail
      if (dep.status === 'skipped') return dep.reason !== 'condition'
      return dep.status === 'cancelled' || dep.status === 'interrupted'
    }
    const passes = (id: string) => {
      const dep = stepOf(run, id)
      return (
        dep?.status === 'done' ||
        (dep?.status === 'skipped' && dep.reason === 'condition') ||
        (dep?.status === 'failed' && specOf(wf, id)?.continueOnFail === true)
      )
    }
    const decide = (spec: StepSpec): Decision => {
      const cond = spec.if ? parseCondition(spec.if) : undefined
      if (cond?.error !== undefined) return { error: `if: ${cond.error}` }
      const lost = spec.after.some(id => stepOf(run, id)?.status === 'interrupted')
      if (cond?.node && checksStatus(cond.node)) {
        // always() and failure(): once every after step has ended, however it ended.
        if (lost) return 'skip'
        if (!spec.after.every(id => isEnded(stepOf(run, id)?.status ?? 'pending'))) return 'wait'
      } else {
        if (spec.after.some(blocks)) return 'skip'
        if (!spec.after.every(passes)) return 'wait'
      }
      if (cond?.node && !evalCondition(cond.node, conditionScope(run, spec))) return 'condition'
      return 'start'
    }
    for (let changed = true; changed; ) {
      changed = false
      for (const spec of wf.steps) {
        const s = stepOf(run, spec.id)
        if (s?.status !== 'pending') continue
        const d = decide(spec)
        if (d === 'wait' || d === 'start') continue
        if (typeof d === 'object') Object.assign(s, { status: 'failed', error: d.error })
        else {
          s.status = 'skipped'
          if (d === 'condition') s.reason = 'condition'
        }
        s.endedAt = at
        changed = true
      }
    }
    // Chosen and marked before anything is awaited, so two pumps never start one step twice.
    let slots = MAX_PARALLEL - runningUnits(ctx)
    for (const spec of wf.steps) {
      const s = stepOf(run, spec.id)
      if (!s) continue
      if (s.status === 'running' && s.items) {
        slots = startItems($, ctx, spec, s, slots, at)
        continue
      }
      if (s.status !== 'pending' || decide(spec) !== 'start') continue
      if (takesSlot(spec) && slots <= 0) continue
      s.startedAt = at
      s.endedAt = undefined
      if (spec.forEach !== undefined) {
        const values = itemValues(ctx, spec)
        s.status = 'running'
        s.items = values.map(value => ({ value, status: 'pending', output: '', tail: '' }))
        if (!values.length) {
          Object.assign(s, { status: 'done', output: '[]', endedAt: at })
          isAgain = true
          continue
        }
        slots = startItems($, ctx, spec, s, slots, at)
        continue
      }
      if (takesSlot(spec)) slots--
      s.status = spec.kind === 'approve' || spec.kind === 'claude' ? 'waiting' : 'running'
      void launch($, ctx, spec, unitOf(s))
    }
  }
  run.status = computeStatus(run)
  run.endedAt = isRunEnded(run.status) ? (run.endedAt ?? at) : undefined
  await saveNow($, ctx)
  if (isAgain) return pump($, ctx)
  if (run.parent && isRunEnded(run.status)) void childEnded($, run).catch(() => undefined)
}

/** Starts a running for_each step's pending items, within its max_parallel and the run's free slots. */
function startItems($: $, ctx: Live, spec: StepSpec, step: StepRun, slots: number, at: number): number {
  const items = step.items ?? []
  let going = items.filter(i => i.status === 'running').length
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item?.status !== 'pending') continue
    if (slots <= 0 || going >= (spec.maxParallel ?? 3)) break
    item.status = 'running'
    item.startedAt = at
    slots--
    going++
    void launch($, ctx, spec, unitOf(step, i))
  }
  return slots
}

async function finishStep($: $, ctx: Live, step: StepRun, status: StepStatus, patch: Partial<StepRun> = {}): Promise<void> {
  if (isEnded(step.status)) return
  Object.assign(step, patch)
  step.status = status
  step.endedAt = await $.clock.now()
  ctx.stops.delete(step.id)
  if (step.agentId) agentSteps.delete(step.agentId)
  await flushLog($, ctx, step.id)
  await pump($, ctx)
}

/** The first of a unit's `outputs:` that is not in the run folder. */
async function missingOutput($: $, ctx: Live, spec: StepSpec, unit: Unit): Promise<string | undefined> {
  for (const rel of outputPaths(ctx.run, spec, unit.step, unit.index))
    if (!(await $.fs.exists(`${ctx.run.dir}/${rel}`).catch(() => false))) return rel
  return undefined
}

/**
 * A unit's attempt ended: a success is checked against `outputs:`, a failure is
 * tried again while `retry:` allows, and then the step (or the item) ends.
 */
async function endUnit($: $, ctx: Live, spec: StepSpec, unit: Unit, status: 'done' | 'failed', patch: Partial<ItemRun> = {}): Promise<void> {
  const { rec, step } = unit
  const isGoing = () => (rec.status === 'running' || rec.status === 'waiting') && ctx.run.status !== 'cancelled'
  if (!isGoing()) return
  if (ctx.secrets?.size) {
    if (patch.output !== undefined) patch = { ...patch, output: redact(ctx, patch.output) }
    if (patch.error !== undefined) patch = { ...patch, error: redact(ctx, patch.error) }
  }
  if (status === 'done' && spec.outputs?.length && (unit.index !== undefined || spec.forEach === undefined)) {
    const missing = await missingOutput($, ctx, spec, unit)
    if (!isGoing()) return
    if (missing !== undefined) {
      status = 'failed'
      patch = { ...patch, error: `missing output ${missing}` }
      appendLog($, ctx, unit.key, rec, `[flow: missing output ${missing}]\n`)
    }
  }
  const attempt = rec.attempt ?? 1
  const retries = takesSlot(spec) ? (spec.retry ?? 0) : 0
  if (status === 'failed' && attempt <= retries) return retryLater($, ctx, spec, unit, patch)
  if (unit.index === undefined) return finishStep($, ctx, step, status, patch)

  Object.assign(rec, patch)
  rec.status = status
  rec.endedAt = await $.clock.now()
  ctx.stops.delete(unit.key)
  if (rec.agentId) agentSteps.delete(rec.agentId)
  appendLog($, ctx, step.id, step, `[${unit.index}] ${step.items?.[unit.index]?.value ?? ''}: ${status}${rec.error ? ` (${rec.error})` : ''}\n`)
  await flushLog($, ctx, unit.key)
  return itemsChanged($, ctx, step)
}

/** A failed attempt with retries left: the next one starts after retry_delay, on a timer. */
async function retryLater($: $, ctx: Live, spec: StepSpec, unit: Unit, patch: Partial<ItemRun>): Promise<void> {
  const { rec } = unit
  const attempt = rec.attempt ?? 1
  const delay = spec.retryDelaySec ?? 10
  Object.assign(rec, patch)
  appendLog($, ctx, unit.key, rec, `\n--- attempt ${attempt} of ${(spec.retry ?? 0) + 1} failed (${rec.error ?? 'failed'}); trying again in ${delay}s ---\n`)
  if (rec.agentId) agentSteps.delete(rec.agentId)
  delete rec.agentId
  const timer = $.clock.after(delay * 1000, () => {
    if (rec.status !== 'running' || ctx.run.status === 'cancelled') return
    rec.attempt = attempt + 1
    rec.output = ''
    delete rec.exitCode
    delete rec.error
    void launch($, ctx, spec, unit)
  })
  ctx.stops.set(unit.key, () => timer.cancel())
  await saveNow($, ctx)
}

/** An item ended: the step ends once every item has (failed if any failed), else more items start. */
async function itemsChanged($: $, ctx: Live, step: StepRun): Promise<void> {
  const items = step.items ?? []
  if (items.some(i => !isEnded(i.status))) return pump($, ctx)
  const output = clip(JSON.stringify(items.map(i => i.output)), OUTPUT_MAX)
  const failed = items.filter(i => i.status === 'failed').length
  if (failed) return finishStep($, ctx, step, 'failed', { output, error: `${failed} of ${items.length} items failed` })
  if (items.some(i => i.status === 'interrupted')) return finishStep($, ctx, step, 'interrupted', { output })
  return finishStep($, ctx, step, 'done', { output })
}

function launch($: $, ctx: Live, spec: StepSpec, unit: Unit): Promise<void> {
  if (takesSlot(spec)) {
    unit.rec.attempt ??= 1
    if (unit.rec.attempt > 1) appendLog($, ctx, unit.key, unit.rec, `--- attempt ${unit.rec.attempt} of ${(spec.retry ?? 0) + 1} ---\n`)
  }
  const work =
    spec.kind === 'run'
      ? runCommand($, ctx, spec, unit)
      : spec.kind === 'python'
        ? runPython($, ctx, spec, unit)
        : spec.kind === 'mcp'
          ? runMcp($, ctx, spec, unit)
          : spec.kind === 'http'
            ? runHttp($, ctx, spec, unit)
            : spec.kind === 'model'
              ? runModel($, ctx, spec, unit)
            : spec.kind === 'agent'
        ? runAgent($, ctx, spec, unit)
        : spec.kind === 'claude'
          ? askClaude($, ctx, spec, unit.step)
          : spec.kind === 'wait'
            ? runWait($, ctx, spec, unit)
            : spec.kind === 'uses'
              ? runUses($, ctx, spec, unit)
              : askApproval($, ctx, spec, unit.step)
  return work.catch(err => endUnit($, ctx, spec, unit, 'failed', { error: errText(err) })).catch(() => undefined)
}

// A `run` step: bash -c in the workflow folder (or cwd:), stdout as the output.
async function runCommand($: $, ctx: Live, spec: StepSpec, unit: Unit): Promise<void> {
  const { run } = ctx
  const value = unitItem(spec, unit)
  const tctx = templateContext(ctx, value)
  const command = fill(spec.body, tctx)
  return spawnUnit($, ctx, spec, unit, { argv: ['bash', '-c', command], cwd: stepCwd(run, spec, tctx), env: stepEnv(ctx, value) })
}

const unitItem = (spec: StepSpec, unit: Unit) => (unit.index === undefined ? undefined : itemOf(spec, unit.index, unit.step.items?.[unit.index]?.value ?? ''))

/** A step's cwd: the workflow folder, or `cwd:` (relative to it). */
function stepCwd(run: Run, spec: StepSpec, tctx: TemplateContext): string {
  const cwdText = fill(spec.cwd, tctx).trim()
  return !cwdText ? run.workflowDir : cwdText.startsWith('/') ? cwdText : `${run.workflowDir}/${cwdText}`
}

/** FLOW_RUN_DIR, FLOW_RUN_ID, FLOW_WORKFLOW_DIR, FLOW_INPUT_<ID> and, for an item, FLOW_ITEM and FLOW_ITEM_INDEX. */
function stepEnv(ctx: Live, value?: TemplateContext['item']): Record<string, string> {
  const { run } = ctx
  const env: Record<string, string> = { FLOW_RUN_DIR: run.dir, FLOW_RUN_ID: run.id, FLOW_WORKFLOW_DIR: run.workflowDir }
  for (const input of ctx.wf.inputs) env[`FLOW_INPUT_${input.id.toUpperCase()}`] = run.inputs[input.id] ?? ''
  if (value) {
    env.FLOW_ITEM = value.value
    env.FLOW_ITEM_INDEX = String(value.index)
  }
  return env
}

/**
 * Runs a child for a unit: stdout is the output (or what `outputOf` makes of it
 * after exit 0), both pipes go to the log, and `timeout:` stops it.
 */
async function spawnUnit(
  $: $,
  ctx: Live,
  spec: StepSpec,
  unit: Unit,
  plan: {
    argv: string[]
    cwd: string
    env: Record<string, string>
    outputOf?: (stdout: string) => Promise<string>
    /** Turns stdout pieces into what the log shows (stdout is then not the live output). */
    logOf?: (text: string) => string
    /** Why it failed, from what it printed, instead of its exit code. */
    errorOf?: () => string | undefined
  },
): Promise<void> {
  const { rec } = unit
  const stream = $.process.spawn({ argv: plan.argv, cwd: plan.cwd, env: plan.env })
  let isStopped = false
  const stop = () => {
    if (isStopped) return
    isStopped = true
    void stream.return({ code: null, signal: null }).catch(() => undefined)
  }
  ctx.stops.set(unit.key, stop)
  const timer = $.clock.after(spec.timeoutSec * 1000, () => {
    if (isStopped || rec.status !== 'running') return
    stop()
    void endUnit($, ctx, spec, unit, 'failed', { error: `timed out after ${spec.timeoutSec}s` }).catch(() => undefined)
  })
  await saveNow($, ctx)

  // Detached: the child outlives the dispatch that started it, and ends with the loop.
  void (async () => {
    let stdout = ''
    let result: ProcessSpawnResult | undefined
    let error: string | undefined
    try {
      for (;;) {
        const piece = await stream.next()
        if (piece.done) {
          result = piece.value
          break
        }
        if (isStopped) break
        const { stream: pipe, text } = piece.value
        if (pipe === 'stdout' && stdout.length < OUTPUT_MAX * 2) {
          stdout += text
          if (!plan.logOf) rec.output = clip(redact(ctx, stdout.trim()), OUTPUT_MAX)
        }
        const shown = pipe === 'stdout' && plan.logOf ? plan.logOf(text) : text
        if (shown) appendLog($, ctx, unit.key, rec, shown)
        syncSoon($, ctx)
      }
    } catch (err) {
      error = errText(err)
    }
    timer.cancel()
    if (isStopped || rec.status !== 'running') {
      await flushLog($, ctx, unit.key)
      return
    }
    let output = clip(stdout.trim(), OUTPUT_MAX)
    if (error !== undefined) return endUnit($, ctx, spec, unit, 'failed', { output, error })
    if (result?.code === 0) {
      if (plan.outputOf) {
        output = clip(await plan.outputOf(output).catch(() => output), OUTPUT_MAX)
        if (isStopped || rec.status !== 'running') return
      }
      return endUnit($, ctx, spec, unit, 'done', { output, exitCode: 0 })
    }
    if (result && result.code !== null)
      return endUnit($, ctx, spec, unit, 'failed', { output, exitCode: result.code, error: plan.errorOf?.() ?? `exited with code ${result.code}` })
    return endUnit($, ctx, spec, unit, 'failed', { output, error: `ended by ${result?.signal ?? 'a signal'}` })
  })().catch(() => undefined)
}

/** The {{env.NAME}} values a step uses, read from the environment once per run (never logged). */
async function stepSecrets($: $, ctx: Live, spec: StepSpec): Promise<Record<string, string>> {
  const values: Record<string, string> = {}
  ctx.secrets ??= new Map()
  for (const name of stepEnvNames(spec)) {
    let value = ctx.secrets.get(name)
    if (value === undefined) {
      const r = await $.process.run(['bash', '-c', 'printf %s "${!1}"', '_', name])
      value = r.stdout
      ctx.secrets.set(name, value)
    }
    values[name] = value
  }
  return values
}

// The helper a python step imports (`from flow import flow`), written to <run.dir>/.flow/flow.py.
const FLOW_PY = `"""The run's context for a flow python step; written by the flow plugin.

    from flow import flow
    flow.inputs["csv"]               # the run's inputs, as strings
    flow.steps["fetch"].json         # an earlier step: .output .json .files .dir .status .exit
    flow.run_dir, flow.item, flow.item_index
    flow.set_output({"count": 3})    # this step's output (as JSON) instead of stdout
    flow.chart("sales", "bar", labels=["a", "b"], series=[{"name": "total", "values": [3, 5]}])
                                     # <run dir>/sales.chart.json, drawn in the hub's Results

Standard library only.
"""
import json
import math
import os
import re

__all__ = ["flow"]

CHART_TYPES = ("bar", "line")


class Step:
    """One step of the run, as it was when this step started."""

    def __init__(self, step_id, data):
        self.id = step_id
        self.status = data.get("status", "")
        self.output = data.get("output", "")
        self.json = data.get("json")
        self.files = list(data.get("files") or [])
        self.dir = data.get("dir", "")
        self.exit = data.get("exit")

    def __repr__(self):
        return "Step(%r, status=%r)" % (self.id, self.status)


class Steps(dict):
    def __missing__(self, key):
        raise KeyError("no step %r in this workflow (steps: %s)" % (key, ", ".join(self) or "none"))


class Flow:
    def __init__(self):
        path = os.environ.get("FLOW_CONTEXT", "")
        data = {}
        if path and os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        self.inputs = dict(data.get("inputs") or {})
        self.steps = Steps((k, Step(k, v)) for k, v in (data.get("steps") or {}).items())
        self.run_dir = data.get("run_dir") or os.environ.get("FLOW_RUN_DIR", "")
        self.item = data.get("item")
        self.item_index = data.get("item_index")

    def set_output(self, value):
        """Makes value (anything json.dumps takes) this step's output, in place of stdout."""
        path = os.environ.get("FLOW_OUTPUT", "")
        if not path:
            raise RuntimeError("FLOW_OUTPUT is not set: run this from a flow python step")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False)

    def chart(self, name, type="bar", labels=(), series=(), title=None, y_label=None):
        \"\"\"Writes <run dir>/<name>.chart.json, which the hub draws as a bar or line chart.

        labels: one per bar or point; series: [{"name": str, "values": [number, ...]}],
        one value per label. Returns the file's path.
        \"\"\"
        if type not in CHART_TYPES:
            raise ValueError("chart type must be bar or line, not %r" % (type,))
        labels = [str(x) for x in labels]
        rows = []
        for i, s in enumerate(series):
            if not isinstance(s, dict) or "values" not in s:
                raise ValueError("series[%d] must be a dict with name and values" % i)
            values = []
            for v in s["values"]:
                if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                    raise ValueError("series[%d] %r: %r is not a number" % (i, s.get("name", ""), v))
                values.append(v)
            if len(values) != len(labels):
                raise ValueError("series[%d] has %d values for %d labels" % (i, len(values), len(labels)))
            rows.append({"name": str(s.get("name") or "series %d" % (i + 1)), "values": values})
        if not rows:
            raise ValueError("a chart needs at least one series")
        if not self.run_dir:
            raise RuntimeError("no run folder: run this from a flow python step")
        slug = re.sub(r"[^\\w]+", "-", str(name).lower()).strip("-_") or "chart"
        data = {"type": type, "title": str(title or name), "labels": labels, "series": rows}
        if y_label:
            data["yLabel"] = str(y_label)
        path = os.path.join(self.run_dir, slug + ".chart.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return path


flow = Flow()
`

/** What a python step's helper reads: the inputs, every step so far, the run folder and the item. */
function pythonContext(ctx: Live, value?: TemplateContext['item']) {
  const { run } = ctx
  const tctx = templateContext(ctx)
  const steps: Record<string, { status: string; output: string; json: unknown; files: string[]; dir: string; exit: number | null }> = {}
  for (const s of run.steps)
    steps[s.id] = { status: s.status, output: s.output, json: parseJson(s.output), files: tctx.files?.[s.id] ?? [], dir: tctx.dirs?.[s.id] || run.dir, exit: s.exitCode ?? null }
  return { inputs: run.inputs, steps, run_dir: run.dir, item: value?.value ?? null, item_index: value?.index ?? null }
}

// A `python` step: [interpreter, script, ...args] (no shell) in the workflow folder, with the flow helper on PYTHONPATH.
async function runPython($: $, ctx: Live, spec: StepSpec, unit: Unit): Promise<void> {
  const { run } = ctx
  const { rec } = unit
  const py = spec.python
  if (!py) return endUnit($, ctx, spec, unit, 'failed', { error: 'the python step says nothing to run' })
  const value = unitItem(spec, unit)
  const env = await stepSecrets($, ctx, spec)
  if (rec.status !== 'running') return
  const plain = templateContext(ctx, value)
  const tctx = { ...plain, env }
  const homeDir = await home($)
  const inWorkflow = (p: string) => {
    const path = expand(p, homeDir)
    return path.startsWith('/') ? path : `${run.workflowDir}/${path.replace(/^\.\/+/, '')}`
  }
  const interpreter = py.interpreter.includes('/') || py.interpreter.startsWith('~') ? inWorkflow(py.interpreter) : py.interpreter
  const flowDir = `${run.dir}/.flow`
  let script: string
  if (py.code !== undefined) {
    script = `${flowDir}/${unit.key}.py`
    await $.fs.write(script, py.code)
  } else {
    script = inWorkflow(fill(py.file ?? '', plain).trim())
    if (!(await $.fs.exists(script).catch(() => false))) return endUnit($, ctx, spec, unit, 'failed', { error: `no script at ${script}` })
  }
  const args = py.args.map(a => fill(a, tctx))
  const cwd = stepCwd(run, spec, plain)
  for (const name of py.requirements) {
    let isThere = false
    try {
      isThere = (await $.process.run([interpreter, '-c', `import ${name}`], { cwd })).exitCode === 0
    } catch (err) {
      return endUnit($, ctx, spec, unit, 'failed', { error: `cannot start ${interpreter}: ${errText(err)}` })
    }
    if (rec.status !== 'running') return
    if (!isThere) return endUnit($, ctx, spec, unit, 'failed', { error: `missing Python package ${name} (install it into ${interpreter})` })
  }
  const contextFile = `${flowDir}/${unit.key}.context.json`
  const outputFile = `${flowDir}/${unit.key}.output.json`
  await $.fs.write(`${flowDir}/flow.py`, FLOW_PY)
  await $.fs.write(contextFile, JSON.stringify(pythonContext(ctx, value), null, 2))
  await $.fs.write(outputFile, '')
  if (rec.status !== 'running') return
  const pythonPath = (await $.env.get('PYTHONPATH')) ?? ''
  if (rec.status !== 'running') return
  const argv = [interpreter, script, ...args]
  appendLog($, ctx, unit.key, rec, `$ ${argv.map(a => (/^[\w@%+=:,./-]+$/.test(a) ? a : shQuote(a))).join(' ')}\n`)
  return spawnUnit($, ctx, spec, unit, {
    argv,
    cwd,
    env: {
      ...stepEnv(ctx, value),
      PYTHONPATH: pythonPath ? `${flowDir}:${pythonPath}` : flowDir,
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      FLOW_CONTEXT: contextFile,
      FLOW_OUTPUT: outputFile,
    },
    // flow.set_output(...) wrote JSON: that is the output, not stdout.
    outputOf: async stdout => {
      const set = (await $.fs.read(outputFile).catch(() => '')).trim()
      return set || stdout
    },
  })
}

type CallEnd = { status: 'done' | 'failed'; patch: Partial<ItemRun> }

/** Runs one call for a unit (an MCP tool, an HTTP request): `timeout:` fails it, and a late answer is then ignored. */
async function callUnit($: $, ctx: Live, spec: StepSpec, unit: Unit, call: () => Promise<CallEnd>): Promise<void> {
  const { rec } = unit
  let isStopped = false
  const timer = $.clock.after(spec.timeoutSec * 1000, () => {
    if (isStopped || rec.status !== 'running') return
    isStopped = true
    void endUnit($, ctx, spec, unit, 'failed', { error: `timed out after ${spec.timeoutSec}s` }).catch(() => undefined)
  })
  ctx.stops.set(unit.key, () => {
    isStopped = true
    timer.cancel()
  })
  await saveNow($, ctx)
  void (async () => {
    let end: CallEnd
    try {
      end = await call()
    } catch (err) {
      end = { status: 'failed', patch: { error: errText(err) } }
    }
    timer.cancel()
    if (isStopped || rec.status !== 'running') return
    isStopped = true
    return endUnit($, ctx, spec, unit, end.status, end.patch)
  })().catch(() => undefined)
}

const oneLine = (text: string, n: number) => clip(text.replace(/\s+/g, ' ').trim(), n)

// An `mcp` step: one tool call on a connected MCP server; the text blocks are the output.
async function runMcp($: $, ctx: Live, spec: StepSpec, unit: Unit): Promise<void> {
  const { rec } = unit
  const m = spec.mcp
  if (!m) return endUnit($, ctx, spec, unit, 'failed', { error: 'the mcp step names no tool' })
  const env = await stepSecrets($, ctx, spec)
  if (rec.status !== 'running') return
  const tctx = { ...templateContext(ctx, unitItem(spec, unit)), env }
  const args = deepMap(m.args, t => fill(t, tctx)) as Record<string, unknown>
  appendLog($, ctx, unit.key, rec, `mcp ${m.server} ${m.tool} ${JSON.stringify(args)}\n`)
  return callUnit($, ctx, spec, unit, async () => {
    const result = await $.mcp.call(m.server, m.tool, args)
    const blocks = (result.content ?? []).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text ?? '')
    let text = blocks.join('\n')
    if (!blocks.length && result.structuredContent !== undefined) text = JSON.stringify(result.structuredContent)
    if (rec.status === 'running') appendLog($, ctx, unit.key, rec, `${text}${text.endsWith('\n') ? '' : '\n'}`)
    const output = clip(text.trim(), OUTPUT_MAX)
    if (result.isError) return { status: 'failed', patch: { output, error: oneLine(text, 300) || `${m.tool} reported an error` } }
    return { status: 'done', patch: { output } }
  })
}

// A `model` step: one prompt to Claude through $.model.complete, with the named
// files' text attached. No agent starts and no tool runs, so no permission is
// asked; the answer is the output, and written to `write` when given.
const MODEL_FILE_MAX = 200_000
const MODEL_FILES_MAX = 400_000

async function runModel($: $, ctx: Live, spec: StepSpec, unit: Unit): Promise<void> {
  const { rec } = unit
  const m = spec.ask
  if (!m) return endUnit($, ctx, spec, unit, 'failed', { error: 'the model step has no prompt' })
  const tctx = templateContext(ctx, unitItem(spec, unit))
  const prompt = fill(m.prompt, tctx)
  const write = m.write ? fill(m.write, tctx).trim() : ''
  const attached: string[] = []
  let total = 0
  for (const raw of m.files) {
    const path = fill(raw, tctx).trim()
    if (!path) continue
    if (!(await $.fs.exists(path).catch(() => false))) return endUnit($, ctx, spec, unit, 'failed', { error: `model.files: no file at ${path}` })
    const text = await $.fs.read(path).catch(() => undefined)
    if (typeof text !== 'string') return endUnit($, ctx, spec, unit, 'failed', { error: `model.files: can't read ${path}` })
    const piece = clip(text, Math.min(MODEL_FILE_MAX, Math.max(0, MODEL_FILES_MAX - total)))
    total += piece.length
    attached.push(`<file path="${path}">\n${piece}\n</file>`)
  }
  const model = m.use || (await $.session.model().catch(() => '')) || 'sonnet'
  const full = [prompt, ...attached].join('\n\n')
  appendLog($, ctx, unit.key, rec, `model ${model}${m.files.length ? `, ${m.files.length} file(s) attached` : ''}\n--- prompt ---\n${clip(prompt, 4000)}\n`)
  return callUnit($, ctx, spec, unit, async () => {
    const r = await $.model.complete({
      model,
      prompt: full,
      maxTokens: m.maxTokens,
      ...(m.system ? { system: fill(m.system, tctx) } : {}),
      ...(m.effort ? { effort: m.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
    })
    if (!r.isAnswered) {
      const why = r.reason === 'api-error' ? `the API answered with an error${r.status ? ` (${r.status})` : ''}` : r.reason === 'empty-reply' ? 'the model gave no text' : `the call ended: ${r.reason}`
      return { status: 'failed', patch: { error: why } }
    }
    const answer = r.text.trim()
    if (rec.status === 'running') appendLog($, ctx, unit.key, rec, `--- answer ---\n${answer}\n`)
    if (write) {
      const wrote = await $.fs.write(write, `${answer}\n`).then(() => true, () => false)
      if (!wrote) return { status: 'failed', patch: { output: clip(answer, OUTPUT_MAX), error: `model.write: can't write ${write}` } }
    }
    return { status: 'done', patch: { output: clip(answer, OUTPUT_MAX) } }
  })
}

// An `http` step: one request through the host; the response text is the output.
async function runHttp($: $, ctx: Live, spec: StepSpec, unit: Unit): Promise<void> {
  const { rec } = unit
  const h = spec.http
  if (!h) return endUnit($, ctx, spec, unit, 'failed', { error: 'the http step names no URL' })
  const env = await stepSecrets($, ctx, spec)
  if (rec.status !== 'running') return
  const tctx = { ...templateContext(ctx, unitItem(spec, unit)), env }
  const url = fill(h.url, tctx).trim()
  if (!/^https?:\/\/\S+$/i.test(url)) return endUnit($, ctx, spec, unit, 'failed', { error: `http.url: "${url}" is not an http or https URL` })
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(h.headers)) headers[k] = fill(v, tctx)
  let body: string | undefined
  if (typeof h.body === 'string') body = fill(h.body, tctx)
  else if (h.body !== undefined) {
    body = JSON.stringify(deepMap(h.body, t => fill(t, tctx)))
    if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'
  }
  appendLog($, ctx, unit.key, rec, `${h.method} ${url}\n`)
  return callUnit($, ctx, spec, unit, async () => {
    const res = await $.http.fetch(url, { method: h.method, headers, ...(body !== undefined ? { body } : {}) })
    const text = res.text ?? ''
    if (rec.status === 'running') appendLog($, ctx, unit.key, rec, `HTTP ${res.status}\n${text}${text && !text.endsWith('\n') ? '\n' : ''}`)
    const output = clip(text.trim(), OUTPUT_MAX)
    const isExpected = h.expect.length ? h.expect.includes(res.status) : res.status >= 200 && res.status < 300
    if (isExpected) return { status: 'done', patch: { output } }
    const wanted = h.expect.length ? ` (expected ${h.expect.join(' or ')})` : ''
    return { status: 'failed', patch: { output, error: `HTTP ${res.status}${wanted}: ${oneLine(text, 300)}` } }
  })
}

// An `agent` step: a headless Claude (`claude -p --restricted`) with only the
// tools, folders and budget the step names. It is its own process, so nothing
// asks this session's permissions: tools that run commands or code are gone,
// file tools stay inside its folders, and anything not allowed up front is
// refused (dontAsk). Writes go to the run folder and the step's `write:` folders.

/** Each tier's model and effort, as agents/flow-<tier>.md set them. */
const TIER_RUN: Record<Tier, { model: string; effort: string }> = {
  light: { model: 'opus', effort: 'low' },
  medium: { model: 'opus', effort: 'medium' },
  careful: { model: 'opus', effort: 'high' },
  heavy: { model: 'opus', effort: 'xhigh' },
  fable: { model: 'fable', effort: 'high' },
}

const NOT_SIGNED_IN = 'headless Claude is not signed in on this Mac: run `claude auth login` once in a terminal, then re-run'

/** The `claude -p` command line for an agent step (exported for tests). */
export function agentArgv(o: { prompt: string; tools: string[]; read: string[]; write: string[]; model: string; effort: string; budget: number }): string[] {
  // File-writing rules are Edit(...) rules: they cover Write too (a Write(...) rule matches nothing).
  const isWriting = o.tools.some(t => t === 'Write' || t === 'Edit')
  const allowed = [...o.tools.filter(t => t !== 'Write' && t !== 'Edit'), ...(isWriting ? o.write.map(d => `Edit(/${d.replace(/\/+$/, '')}/**)`) : [])]
  const dirs = [...new Set([...o.read, ...o.write])]
  return [
    'claude', '-p', o.prompt,
    '--restricted', '--strict-mcp-config', '--no-session-persistence',
    '--permission-mode', 'dontAsk',
    '--tools', o.tools.join(','),
    '--allowedTools', allowed.join(','),
    ...(dirs.length ? ['--add-dir', ...dirs] : []),
    '--model', o.model,
    ...(o.effort ? ['--effort', o.effort] : []),
    '--max-budget-usd', String(o.budget),
    '--output-format', 'stream-json', '--verbose',
  ]
}

/** One stream-json event as a log line, or nothing. */
function agentLogLine(ev: Record<string, unknown>): string {
  const content = (ev.message as { content?: unknown } | undefined)?.content
  const blocks = Array.isArray(content) ? (content as Record<string, unknown>[]) : []
  if (ev.type === 'system' && ev.subtype === 'init') return `--- claude started: ${String(ev.model ?? '')} · tools ${((ev.tools as string[] | undefined) ?? []).join(', ')} ---\n`
  if (ev.type === 'assistant')
    return blocks
      .map(b => {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) return `${b.text.trim()}\n`
        if (b.type === 'tool_use') {
          const input = (b.input ?? {}) as Record<string, unknown>
          const what = [input.file_path, input.path, input.pattern, input.query, input.url].find(v => typeof v === 'string')
          return `→ ${String(b.name)}${what ? ` ${String(what)}` : ''}\n`
        }
        return ''
      })
      .join('')
  if (ev.type === 'user')
    return blocks
      .filter(b => b.type === 'tool_result' && b.is_error)
      .map(b => `  ✗ ${oneLine(typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''), 300)}\n`)
      .join('')
  if (ev.type === 'result') {
    const cost = typeof ev.total_cost_usd === 'number' ? ` · $${ev.total_cost_usd.toFixed(2)}` : ''
    const denied = Array.isArray(ev.permission_denials) ? ev.permission_denials.length : 0
    return `--- ${ev.is_error ? 'stopped' : 'done'}: ${String(ev.num_turns ?? '?')} turns${cost}${denied ? ` · ${denied} refused` : ''} ---\n`
  }
  return ''
}

async function runAgent($: $, ctx: Live, spec: StepSpec, unit: Unit): Promise<void> {
  const { run } = ctx
  const value = unitItem(spec, unit)
  const tctx = templateContext(ctx, value)
  const a = spec.agent ?? { tools: ['Read', 'Grep', 'Glob', 'Write'], read: [], write: [], budget: 1, use: '', effort: '' }
  const tier = TIER_RUN[spec.tier ?? 'medium']
  const abs = (p: string) => (p.startsWith('/') ? p : `${run.workflowDir}/${p}`)
  const read = a.read.map(d => fill(d, tctx).trim()).filter(Boolean).map(abs)
  const write = [run.dir, ...a.write.map(d => fill(d, tctx).trim()).filter(Boolean).map(abs)]
  const body = fill(spec.body, tctx)
  const prompt = [
    `You are running one step of the flow workflow "${run.title}" (${run.workflowId}).`,
    `Step: ${spec.title} (${spec.id})`,
    ...(value ? [`Item ${value.index}: ${value.value}`] : []),
    `Run folder: ${run.dir}`,
    `You can read: ${[run.dir, ...read].join(', ')}. You can write only in: ${write.join(', ')}.`,
    `Your final answer becomes this step's output.`,
    '',
    body,
  ].join('\n')
  appendLog($, ctx, unit.key, unit.rec, `${prompt}\n\n`)

  let buffer = ''
  let result: Record<string, unknown> | undefined
  const logOf = (text: string) => {
    buffer += text
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    let shown = ''
    for (const line of lines) {
      if (!line.trim()) continue
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(line) as Record<string, unknown>
      } catch {
        shown += `${line}\n`
        continue
      }
      if (ev.type === 'result') result = ev
      shown += agentLogLine(ev)
    }
    return shown
  }
  const answer = () => (typeof result?.result === 'string' ? result.result.trim() : '')
  return spawnUnit($, ctx, spec, unit, {
    argv: agentArgv({ prompt, tools: a.tools, read, write, model: a.use || tier.model, effort: a.effort || tier.effort, budget: a.budget }),
    cwd: run.dir,
    env: stepEnv(ctx, value),
    logOf,
    outputOf: async () => {
      if (buffer.trim()) logOf('\n')
      return answer()
    },
    errorOf: () => {
      if (buffer.trim()) logOf('\n')
      const text = answer()
      if (/not logged in|\/login/i.test(text)) return NOT_SIGNED_IN
      if (result?.subtype === 'error_max_budget_usd') return `stopped at its $${a.budget} budget`
      return text ? `claude stopped: ${oneLine(text, 300)}` : undefined
    },
  })
}

async function agentDone($: $, hit: AgentHit, e: TurnCompleteInput): Promise<void> {
  const ctx = await liveCtx($, hit.runId)
  const step = ctx && stepOf(ctx.run, hit.stepId)
  const spec = ctx && specOf(ctx.wf, hit.stepId)
  if (!ctx || !step || !spec) return
  const unit = unitOf(step, hit.index)
  if (unit.rec.status !== 'running') return
  if (e.reason === 'answer') {
    const answer = e.answer.trim()
    appendLog($, ctx, unit.key, unit.rec, `--- answer ---\n${answer}\n`)
    return endUnit($, ctx, spec, unit, 'done', { output: clip(answer, OUTPUT_MAX) })
  }
  appendLog($, ctx, unit.key, unit.rec, `--- the agent's turn ended: ${e.reason} ---\n`)
  return endUnit($, ctx, spec, unit, 'failed', { error: `the agent's turn ended: ${e.reason}` })
}

// A `claude` step: a prompt for the main session, which reports back through complete_step.
async function askClaude($: $, ctx: Live, spec: StepSpec, step: StepRun): Promise<void> {
  const { run } = ctx
  const text =
    `[flow] Workflow "${run.title}", step "${spec.title}" (run ${run.id}, step ${spec.id}).\n\n` +
    fill(spec.body, templateContext(ctx)) +
    `\n\nRun folder: ${run.dir}\nWhen done, call the tool ${TOOL('complete_step')} with run "${run.id}", step "${spec.id}", ok true or false, and a one-paragraph output.`
  appendLog($, ctx, step.id, step, `${text}\n`)
  await saveNow($, ctx)
  // The host refuses a submit made from a tool.call hook (run_workflow,
  // complete_step), since it would wait on the turn that call holds: such a
  // prompt waits for the main loop's turn.complete and goes from there.
  try {
    await $.prompt.submit({ text })
  } catch {
    queuedPrompts.push({ runId: run.id, stepId: step.id, text })
  }
}

/** Sends the prompts a tool call could not; from the main loop's turn.complete. */
function sendQueuedPrompts($: $): void {
  for (const p of queuedPrompts.splice(0))
    void (async () => {
      const ctx = await liveCtx($, p.runId)
      const step = ctx && stepOf(ctx.run, p.stepId)
      if (!ctx || step?.status !== 'waiting') return
      try {
        await $.prompt.submit({ text: p.text })
      } catch (err) {
        await finishStep($, ctx, step, 'failed', { error: `could not hand the step to Claude: ${errText(err)}` })
      }
    })().catch(() => undefined)
}

// An `approve` step: waits for decideStep.
async function askApproval($: $, ctx: Live, spec: StepSpec, step: StepRun): Promise<void> {
  appendLog($, ctx, step.id, step, `${fill(spec.body, templateContext(ctx))}\n`)
  await saveNow($, ctx)
}

const localStamp = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// A `wait` step: checks its file, URL or time every `interval` seconds, on timers, until `timeout`.
async function runWait($: $, ctx: Live, spec: StepSpec, unit: Unit): Promise<void> {
  const { run } = ctx
  const { rec } = unit
  const wait = spec.wait
  if (!wait) return endUnit($, ctx, spec, unit, 'failed', { error: 'the wait step says nothing to wait for' })
  const raw = fill(wait.target, templateContext(ctx)).trim()
  let target = raw
  let check: () => Promise<boolean>
  if (wait.kind === 'file') {
    const path = expand(raw, await home($))
    target = path.startsWith('/') ? path : `${run.dir}/${path}`
    check = () => $.fs.exists(target).catch(() => false)
  } else if (wait.kind === 'url') {
    if (!/^https?:\/\/\S+$/i.test(raw)) return endUnit($, ctx, spec, unit, 'failed', { error: `wait.url: "${raw}" is not an http or https URL` })
    check = async () => {
      const r = await $.process.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', raw]).catch(() => undefined)
      return /^2\d\d$/.test(r?.stdout.trim() ?? '')
    }
  } else {
    const when = untilTime(raw, new Date(await $.clock.now()))
    if (when === undefined) return endUnit($, ctx, spec, unit, 'failed', { error: `wait.until: "${raw}" is not HH:MM or an ISO date and time` })
    target = localStamp(when)
    check = async () => (await $.clock.now()) >= when
  }
  const intervalMs = (spec.intervalSec ?? 15) * 1000
  appendLog($, ctx, unit.key, rec, `Waiting for ${wait.kind} ${target} (checked every ${intervalMs / 1000}s, at most ${spec.timeoutSec}s)\n`)

  let isStopped = false
  let poll: Timer | undefined
  let deadline: Timer | undefined
  const stop = () => {
    isStopped = true
    poll?.cancel()
    deadline?.cancel()
  }
  ctx.stops.set(unit.key, stop)
  deadline = $.clock.after(spec.timeoutSec * 1000, () => {
    if (isStopped || rec.status !== 'running') return
    stop()
    void endUnit($, ctx, spec, unit, 'failed', { error: `timed out after ${spec.timeoutSec}s` }).catch(() => undefined)
  })
  const tick = async (): Promise<void> => {
    if (isStopped || rec.status !== 'running') return
    const isThere = await check()
    if (isStopped || rec.status !== 'running') return
    if (isThere) {
      stop()
      appendLog($, ctx, unit.key, rec, `Done: ${target}\n`)
      return endUnit($, ctx, spec, unit, 'done', { output: target })
    }
    poll = $.clock.after(intervalMs, () => void tick().catch(() => undefined))
  }
  await saveNow($, ctx)
  void tick().catch(() => undefined)
}

/** The workflow ids from the top run down to this one. */
async function chainOf($: $, run: Run): Promise<string[]> {
  const chain = [run.workflowId]
  const seen = new Set([run.id])
  for (let cur: Run | undefined = run; cur?.parent && !seen.has(cur.parent.run) && chain.length <= MAX_DEPTH + 1; ) {
    seen.add(cur.parent.run)
    const parentId: string = cur.parent.run
    cur = live.get(parentId)?.run ?? (await read($, runsAtom)).find(r => r.id === parentId)
    if (cur) chain.unshift(cur.workflowId)
  }
  return chain
}

// A `uses` step: another workflow as a child run; this step goes until that run ends.
async function runUses($: $, ctx: Live, spec: StepSpec, unit: Unit): Promise<void> {
  const { run } = ctx
  const { rec, step } = unit
  const childWf = spec.uses ?? spec.body
  const chain = await chainOf($, run)
  if (chain.includes(childWf)) return endUnit($, ctx, spec, unit, 'failed', { error: `refused: ${[...chain, childWf].join(' → ')} goes in a circle` })
  if (chain.length > MAX_DEPTH) return endUnit($, ctx, spec, unit, 'failed', { error: `refused: ${[...chain, childWf].join(' → ')} nests deeper than ${MAX_DEPTH}` })
  const tctx = templateContext(ctx)
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(spec.with ?? {})) values[key] = fill(value, tctx)
  const started = await startRun($, childWf, values, { parent: { run: run.id, step: step.id } })
  if (!started.run) return endUnit($, ctx, spec, unit, 'failed', { error: `${childWf} did not start: ${started.problems.join('; ')}` })
  const childId = started.run
  if (rec.status !== 'running' || run.status === 'cancelled') {
    await cancelRun($, childId).catch(() => undefined)
    return
  }
  step.childRun = childId
  ctx.stops.set(unit.key, () => void cancelRun($, childId).catch(() => undefined))
  appendLog($, ctx, unit.key, rec, `Started ${childWf} run ${childId}\n${childDir(run, childWf, childId)}\n`)
  await saveNow($, ctx)
  const child = live.get(childId)?.run
  if (child && isRunEnded(child.status)) await childEnded($, child)
}

/** A child run ended: its uses step follows (done when the child is done). */
async function childEnded($: $, child: Run): Promise<void> {
  if (!child.parent) return
  const pctx = await liveCtx($, child.parent.run)
  const step = pctx && stepOf(pctx.run, child.parent.step)
  const spec = pctx && specOf(pctx.wf, child.parent.step)
  if (!pctx || !step || !spec || step.status !== 'running' || step.childRun !== child.id) return
  const output = `${child.id}\n${child.dir}`
  appendLog($, pctx, step.id, step, `Run ${child.id} ended: ${child.status}\n`)
  if (child.status === 'done') return endUnit($, pctx, spec, unitOf(step), 'done', { output })
  if (child.status === 'interrupted') return finishStep($, pctx, step, 'interrupted', { output, error: `run ${child.id} of ${child.workflowId} was interrupted` })
  return endUnit($, pctx, spec, unitOf(step), 'failed', { output, error: `run ${child.id} of ${child.workflowId} ${child.status}` })
}

// ---------------------------------------------------------------------------
// Live runs: the ones started here, and the ones taken over from the atom.

async function readWorkflowSnapshot($: $, run: Run): Promise<Workflow | undefined> {
  const file = `${run.dir}/workflow.json`
  try {
    if (await $.fs.exists(file)) {
      const wf = JSON.parse(await $.fs.read(file)) as Workflow
      if (Array.isArray(wf?.steps)) return wf
    }
  } catch {
    // Fall back to the workflow as found now.
  }
  const found = (await read($, workflowsAtom)).find(f => f.id === run.workflowId && f.workflow)
  return found?.workflow ? clone(found.workflow) : undefined
}

async function liveCtx($: $, runId: string): Promise<Live | undefined> {
  await hydrate($)
  const known = live.get(runId)
  if (known) return known
  const stored = (await read($, runsAtom)).find(r => r.id === runId)
  if (!stored) return undefined
  const run = clone(stored)
  const wf = await readWorkflowSnapshot($, run)
  if (!wf) return undefined
  const ctx: Live = { run, wf, stops: new Map(), logs: new Map(), writes: Promise.resolve() }
  live.set(runId, ctx)
  return ctx
}

/**
 * After this module (re)loaded: a run the atom shows as going lost its children,
 * so its run steps are interrupted; an agent step still has its agent, and a
 * waiting step still waits.
 */
async function hydrate($: $): Promise<void> {
  if (isHydrated) return
  isHydrated = true
  for (const stored of await read($, runsAtom)) {
    if (live.has(stored.id) || (stored.status !== 'running' && stored.status !== 'waiting')) continue
    const run = clone(stored)
    const wf = await readWorkflowSnapshot($, run)
    if (!wf) continue
    const ctx: Live = { run, wf, stops: new Map(), logs: new Map(), writes: Promise.resolve() }
    live.set(run.id, ctx)
    let changed = false
    for (const s of run.steps) {
      if (s.status !== 'running') continue
      const isAgent = specOf(wf, s.id)?.kind === 'agent'
      if (s.items) {
        // Agent items still have their agents; anything else lost its child or its timers.
        let isLive = false
        for (const [index, item] of s.items.entries()) {
          if (item.status !== 'running') continue
          if (isAgent && item.agentId) {
            agentSteps.set(item.agentId, { runId: run.id, stepId: s.id, index })
            isLive = true
          } else {
            item.status = 'interrupted'
            item.endedAt = await $.clock.now()
            changed = true
          }
        }
        if (isLive) continue
      } else if (isAgent && s.agentId) {
        agentSteps.set(s.agentId, { runId: run.id, stepId: s.id })
        continue
      }
      s.status = 'interrupted'
      s.endedAt = await $.clock.now()
      changed = true
    }
    if (changed) await pump($, ctx)
  }
}

/** On session start: the newest 30 run.json files; what was going when the last session ended is interrupted. */
async function loadRuns($: $): Promise<void> {
  const root = `${await home($)}/.flow/runs`
  const found: { wf: string; id: string }[] = []
  if (await $.fs.exists(root).catch(() => false))
    for (const wfDir of await $.fs.list(root).catch(() => [])) {
      if (wfDir.kind !== 'dir') continue
      for (const runDir of await $.fs.list(`${root}/${wfDir.name}`).catch(() => []))
        if (runDir.kind === 'dir' && RUN_ID_RE.test(runDir.name)) found.push({ wf: wfDir.name, id: runDir.name })
    }
  found.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))

  const runs: Run[] = []
  for (const { wf: wfId, id } of found) {
    if (runs.length >= MAX_RUNS) break
    const known = live.get(id)
    if (known) {
      runs.push(clone(known.run))
      continue
    }
    const file = `${root}/${wfId}/${id}/run.json`
    let run: Run
    try {
      if (!(await $.fs.exists(file))) continue
      run = JSON.parse(await $.fs.read(file)) as Run
      if (!run || typeof run.id !== 'string' || !Array.isArray(run.steps)) continue
    } catch {
      continue
    }
    if (run.status === 'running' || run.status === 'waiting') {
      const wf = await readWorkflowSnapshot($, run)
      const at = await $.clock.now()
      let changed = false
      for (const s of run.steps) {
        const kind = wf && specOf(wf, s.id)?.kind
        const isLost = s.status === 'running' || (s.status === 'waiting' && kind !== 'approve' && kind !== undefined)
        if (!isLost) continue
        s.status = 'interrupted'
        s.endedAt = at
        for (const item of s.items ?? []) if (item.status === 'running') Object.assign(item, { status: 'interrupted', endedAt: at })
        changed = true
      }
      const status = computeStatus(run)
      const next: RunStatus = status === 'running' ? 'interrupted' : status
      if (next !== run.status) changed = true
      run.status = next
      if (next !== 'waiting') run.endedAt = run.endedAt ?? at
      if (changed) await $.fs.write(file, JSON.stringify(run, null, 2)).catch(() => undefined)
    }
    runs.push(run)
  }
  runs.sort((a, b) => b.startedAt - a.startedAt)
  await update($, runsAtom, () => runs)
}

// ---------------------------------------------------------------------------
// Actions (the hub pane and the tools call these)

async function newRunId($: $): Promise<string> {
  const d = new Date(await $.clock.now())
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  const taken = new Set([...live.keys(), ...(await read($, runsAtom)).map(r => r.id)])
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  for (;;) {
    let tail = ''
    for (let i = 0; i < 4; i++) tail += alphabet[Math.floor(Math.random() * alphabet.length)]
    const id = `${stamp}-${tail}`
    if (!taken.has(id)) return id
  }
}

async function isEnvSet($: $, name: string): Promise<boolean> {
  try {
    const { exitCode } = await $.process.run(['bash', '-c', '[ -n "${!1+x}" ]', '_', name])
    return exitCode === 0
  } catch {
    return false
  }
}

/**
 * The MCP servers this workflow's mcp steps call that no Claude Code config
 * on this Mac sets up: ~/.claude.json (user and this project's local scope)
 * and the project's .mcp.json. claude.ai connectors and plugin servers are
 * not in those files, so they are taken on trust.
 */
async function mcpProblems($: $, wf: Workflow, found: Found): Promise<string[]> {
  const wanted = [...new Set(wf.steps.map(s => s.mcp?.server).filter((x): x is string => Boolean(x) && !x!.includes('{{')))]
  const asked = wanted.filter(name => !/^claude\.ai /i.test(name) && !name.startsWith('plugin:'))
  if (!asked.length) return []
  const homeDir = await home($)
  const cwd = (await cwdOf($)).replace(/\/+$/, '')
  const names = new Set<string>()
  const add = (servers: unknown) => {
    if (servers && typeof servers === 'object') for (const k of Object.keys(servers)) names.add(k)
  }
  const readJson = async (path: string): Promise<Record<string, unknown> | undefined> => {
    if (!(await $.fs.exists(path).catch(() => false))) return undefined
    try {
      return JSON.parse(await $.fs.read(path)) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  const user = await readJson(`${homeDir}/.claude.json`)
  // No config to judge by (another home, a test): leave it to the call.
  if (!user) return []
  add(user.mcpServers)
  const projects = (user.projects ?? {}) as Record<string, { mcpServers?: unknown }>
  add(projects[cwd]?.mcpServers)
  add((await readJson(`${cwd}/.mcp.json`))?.mcpServers)
  const setup = found.source ? ` (see the setup notes in ${found.dir.replace(/\/[^/]+$/, '')}/README.md)` : ''
  return asked
    .filter(name => !names.has(name))
    .map(name => `MCP server "${name}" is not set up in Claude Code on this Mac${setup}. Add it with \`claude mcp add\`, then start a new session.`)
}

/**
 * Checks the workflow and the inputs and starts a run; problems mean nothing
 * started. `parent`: the run and uses step starting it as a child run (inputs
 * the child does not have are then problems too).
 */
export async function startRun(
  $: $,
  workflowId: string,
  inputs: Record<string, unknown>,
  options: { parent?: { run: string; step: string } } = {},
): Promise<{ run?: string; problems: string[] }> {
  await hydrate($)
  let all = await read($, workflowsAtom)
  if (!all.some(f => f.id === workflowId)) all = await refreshWorkflows($)
  const found = all.find(f => f.id === workflowId && !f.errors.length) ?? all.find(f => f.id === workflowId)
  if (!found) return { problems: [`no workflow "${workflowId}" (folders: ${workflowsDir}, its sources, and .flows/ in the project; pull_sources fetches the sources)`] }
  const wf = found.workflow
  if (!wf || found.errors.length) return { problems: found.errors.length ? found.errors.map(e => `${found.file}: ${e}`) : [`${found.file} did not load`] }

  const values: Record<string, string> = {}
  const at = await $.clock.now()
  for (const input of wf.inputs) {
    const given = inputs[input.id]
    values[input.id] =
      given === undefined || given === null ? defaultValue(input, new Date(at)) : typeof given === 'string' ? given : String(given)
  }
  const problems = inputProblems(wf, values)
  if (options.parent)
    for (const key of Object.keys(inputs)) if (!wf.inputs.some(i => i.id === key)) problems.push(`with.${key}: ${wf.id} has no input "${key}"`)
  for (const name of wf.env) {
    if (!ENV_NAME_RE.test(name)) problems.push(`env: "${name}" is not a variable name`)
    else if (!(await isEnvSet($, name))) problems.push(`${name} is not set in the environment`)
  }
  problems.push(...(await mcpProblems($, wf, found)))
  for (const input of wf.inputs) {
    if ((input.type !== 'file' && input.type !== 'folder') || !values[input.id]?.trim()) continue
    const paths = input.multiple ? (values[input.id] ?? '').split('\n').map(p => p.trim()).filter(Boolean) : [(values[input.id] ?? '').trim()]
    for (const path of paths) {
      if (!(await $.fs.exists(path).catch(() => false))) {
        problems.push(`${input.label}: ${path} does not exist`)
        continue
      }
      for (const rel of input.type === 'folder' ? input.contains ?? [] : [])
        if (!(await $.fs.exists(`${path.replace(/\/+$/, '')}/${rel}`).catch(() => false))) problems.push(`${input.label}: ${path} has no ${rel}`)
    }
  }
  if (problems.length) return { problems }
  // A remembered select keeps what this run used, for the next run's form.
  for (const input of wf.inputs)
    if (input.type === 'select' && input.remember)
      await rememberValues($, wf.id, input.id, (values[input.id] ?? '').split('\n').map(v => v.trim()).filter(Boolean)).catch(() => undefined)

  const id = await newRunId($)
  const run: Run = {
    id,
    workflowId: wf.id,
    title: wf.title,
    workflowDir: found.dir,
    dir: `${await home($)}/.flow/runs/${wf.id}/${id}`,
    inputs: values,
    status: 'running',
    startedAt: at,
    steps: wf.steps.map(s => ({ id: s.id, status: 'pending', output: '', tail: '' })),
    ...(options.parent ? { parent: options.parent } : {}),
  }
  const ctx: Live = { run, wf: clone(wf), stops: new Map(), logs: new Map(), writes: Promise.resolve() }
  live.set(id, ctx)
  await $.fs.write(`${run.dir}/workflow.json`, JSON.stringify(wf, null, 2))
  await pump($, ctx)
  // The hub pane opens on a run started anywhere (not a uses step's child).
  if (!options.parent) await hubRunStarted($, id).catch(() => undefined)
  return { run: id, problems: [] }
}

/** Answers a waiting step: an approval (ok: approved, else rejected), or a claude step. */
export async function decideStep($: $, runId: string, stepId: string, ok: boolean, output?: string): Promise<{ error?: string }> {
  const ctx = await liveCtx($, runId)
  const step = ctx && stepOf(ctx.run, stepId)
  if (!ctx || !step) return { error: `no step "${stepId}" in run ${runId}` }
  if (step.status !== 'waiting') return { error: `step "${stepId}" is ${step.status}, not waiting` }
  const spec = specOf(ctx.wf, stepId)
  if (!spec) return { error: `no step "${stepId}" in run ${runId}` }
  const isApproval = spec.kind === 'approve'
  const text = output?.trim() || (isApproval ? (ok ? 'approved' : 'rejected') : ok ? 'done' : 'failed')
  appendLog($, ctx, step.id, step, `${text}\n`)
  await endUnit($, ctx, spec, unitOf(step), ok ? 'done' : 'failed', { output: clip(text, OUTPUT_MAX), ...(ok ? {} : { error: isApproval ? 'rejected' : text }) })
  return {}
}

/** Stops a run: running and waiting steps are cancelled, pending ones skipped. */
export async function cancelRun($: $, runId: string): Promise<{ error?: string }> {
  const ctx = await liveCtx($, runId)
  if (!ctx) return { error: `no run ${runId}` }
  const { run } = ctx
  if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') return { error: `run ${runId} is already ${run.status}` }
  const at = await $.clock.now()
  // Marked first, so nothing a stop sets off (a retry, a child run ending) carries on.
  run.status = 'cancelled'
  run.endedAt = at
  for (const s of run.steps) {
    if (s.status === 'running' || s.status === 'waiting') {
      for (const [index, item] of (s.items ?? []).entries()) {
        const key = `${s.id}[${index}]`
        if (item.status === 'running') {
          ctx.stops.get(key)?.()
          ctx.stops.delete(key)
          if (item.agentId) agentSteps.delete(item.agentId)
          Object.assign(item, { status: 'cancelled', endedAt: at })
          await flushLog($, ctx, key)
        } else if (item.status === 'pending') Object.assign(item, { status: 'skipped', endedAt: at })
      }
      ctx.stops.get(s.id)?.()
      ctx.stops.delete(s.id)
      if (s.agentId) agentSteps.delete(s.agentId)
      s.status = 'cancelled'
      s.endedAt = at
      await flushLog($, ctx, s.id)
    } else if (s.status === 'pending') {
      s.status = 'skipped'
      s.endedAt = at
    }
  }
  await saveNow($, ctx)
  if (run.parent) await childEnded($, run).catch(() => undefined)
  return {}
}

/** A new run of the same workflow with the same inputs. */
export async function rerun($: $, runId: string): Promise<{ run?: string; problems: string[] }> {
  const run = live.get(runId)?.run ?? (await read($, runsAtom)).find(r => r.id === runId)
  if (!run) return { problems: [`no run ${runId}`] }
  return startRun($, run.workflowId, { ...run.inputs })
}

/** Runs an interrupted run's interrupted steps again (and what they had skipped), then carries on. */
export async function resumeRun($: $, runId: string): Promise<{ error?: string }> {
  const ctx = await liveCtx($, runId)
  if (!ctx) return { error: `no run ${runId}` }
  const { run } = ctx
  if (run.status !== 'interrupted') return { error: `run ${runId} is ${run.status}, not interrupted` }
  for (const s of run.steps) {
    if (s.status !== 'interrupted' && s.status !== 'skipped') continue
    Object.assign(s, { status: 'pending', output: '', tail: '' })
    for (const k of ['startedAt', 'endedAt', 'exitCode', 'error', 'agentId', 'reason', 'attempt', 'items', 'childRun'] as const) delete s[k]
    for (const key of [...ctx.logs.keys()]) if (key === s.id || key.startsWith(`${s.id}[`)) ctx.logs.delete(key)
  }
  run.status = 'running'
  run.endedAt = undefined
  await pump($, ctx)
  return {}
}

// ---------------------------------------------------------------------------
// Tools

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))

function describeWorkflow(f: Found) {
  const wf = f.workflow
  return {
    id: f.id,
    ...(f.source ? { source: f.source } : {}),
    title: wf?.title ?? f.id,
    description: clip(wf?.description ?? '', 400),
    owner: wf?.owner ?? '',
    tags: wf?.tags ?? [],
    env: wf?.env ?? [],
    inputs: (wf?.inputs ?? []).map(i => ({
      id: i.id,
      label: i.label,
      type: i.type,
      required: i.required,
      ...(i.options.length ? { options: i.options } : {}),
      default: i.default,
    })),
    steps: (wf?.steps ?? []).map(s => ({ id: s.id, kind: s.kind, title: s.title, isAI: isAIStep(s) })),
    aiSteps: (wf?.steps ?? []).filter(isAIStep).length,
    fixedSteps: (wf?.steps ?? []).filter(s => !isAIStep(s)).length,
    errors: f.errors,
  }
}

async function runStatusText($: $, runId: string): Promise<string> {
  await hydrate($)
  const run = live.get(runId)?.run ?? (await read($, runsAtom)).find(r => r.id === runId)
  if (!run) return `error: no run ${runId}`
  const lines = [`Run ${run.id} of "${run.title}" (${run.workflowId}): ${run.status}`, `Run folder: ${run.dir}`]
  if (run.parent) lines.push(`Started by run ${run.parent.run}, step ${run.parent.step}`)
  for (const s of run.steps) {
    const extra = [
      s.reason === 'condition' ? 'its if: was false' : '',
      s.attempt !== undefined && s.attempt > 1 ? `attempt ${s.attempt}` : '',
      s.exitCode !== undefined && s.exitCode !== 0 ? `exit ${s.exitCode}` : '',
      s.childRun ? `child run ${s.childRun}` : '',
      s.error ?? '',
    ]
      .filter(Boolean)
      .join(', ')
    lines.push(`- ${s.id}: ${s.status}${extra ? ` (${extra})` : ''}`)
    for (const [i, item] of (s.items ?? []).slice(0, 20).entries()) {
      const more = [item.attempt !== undefined && item.attempt > 1 ? `attempt ${item.attempt}` : '', item.error ?? ''].filter(Boolean).join(', ')
      lines.push(`  [${i}] ${clip(item.value, 80)}: ${item.status}${more ? ` (${more})` : ''}`)
    }
    if ((s.items?.length ?? 0) > 20) lines.push(`  … and ${(s.items?.length ?? 0) - 20} more items`)
    if (s.output) lines.push(`  output: ${clip(s.output, 500).replace(/\n/g, '\n  ')}${s.output.length > 500 ? ' …' : ''}`)
  }
  return lines.join('\n')
}

/** A step's (or an item's) full log, its output and, for an agent, what its transcript shows; at most 200k characters. */
async function stepLogText($: $, runId: string, stepId: string, rawItem: unknown): Promise<string> {
  await hydrate($)
  const ctx = live.get(runId)
  const run = ctx?.run ?? (await read($, runsAtom)).find(r => r.id === runId)
  if (!run) return `error: no run ${runId}`
  const step = stepOf(run, stepId)
  if (!step) return `error: run ${runId} has no step "${stepId}" (steps: ${run.steps.map(s => s.id).join(', ')})`
  let rec: StepRun | ItemRun = step
  let key = step.id
  if (rawItem !== undefined && rawItem !== null && rawItem !== '') {
    const index = Number(rawItem)
    const item = Number.isInteger(index) ? step.items?.[index] : undefined
    if (!item) return `error: step "${stepId}" has no item ${str(rawItem)}${step.items ? ` (items 0 to ${step.items.length - 1})` : ' (it is not a for_each step)'}`
    rec = item
    key = `${step.id}[${index}]`
  }
  const wf = ctx?.wf ?? (await readWorkflowSnapshot($, run))
  const spec = wf && specOf(wf, stepId)
  const file = `${run.dir}/${key}.log`
  let log = ctx?.logs.get(key)?.text
  if (log === undefined) log = (await $.fs.exists(file).catch(() => false)) ? await $.fs.read(file).catch(() => '') : ''

  const kind = spec ? `${spec.kind}, ${isAIStep(spec) ? 'AI' : 'fixed'}` : 'unknown kind'
  const extra = [rec.attempt !== undefined && rec.attempt > 1 ? `attempt ${rec.attempt}` : '', rec.exitCode !== undefined ? `exit ${rec.exitCode}` : '', rec.error ?? ''].filter(Boolean).join(', ')
  const head = [
    `Step ${stepId}${key !== stepId ? ` item ${key.slice(stepId.length)} (${clip((rec as ItemRun).value ?? '', 200)})` : ''} of run ${runId} (${kind}): ${rec.status}${extra ? ` (${extra})` : ''}`,
    `Log file: ${file}`,
    '--- output ---',
    rec.output || '(none)',
  ]
  // An agent step's log holds its prompt and answer; its transcript shows the work between.
  const transcript: string[] = []
  if (spec?.kind === 'agent' && rec.agentId) {
    try {
      const found = await $.session.messages({ agentId: rec.agentId })
      if (Array.isArray(found))
        for (const m of found) {
          if (m.text.trim()) transcript.push(`${m.role}: ${clip(m.text.trim(), 2_000)}`)
          for (const t of m.toolUses ?? [])
            transcript.push(`tool ${t.tool} ${clip(JSON.stringify(t.input ?? {}), 600)}${t.text !== undefined ? `\n  → ${t.isError ? 'error: ' : ''}${clip(t.text.replace(/\n/g, '\n    '), 1_200)}` : ''}`)
        }
    } catch {
      // Not readable here (another session's agent): the log is what there is.
    }
  }
  let shown = transcript.join('\n')
  if (shown.length > STEP_LOG_MAX / 2) shown = `${shown.slice(0, STEP_LOG_MAX / 2)}\n[flow: the transcript is cut here]`
  const before = [...head, ...(shown ? [`--- agent transcript (${transcript.length} entries) ---`, shown] : [])].join('\n')
  const room = Math.max(0, STEP_LOG_MAX - before.length)
  const isCut = log.length > room
  return [before, `--- log${isCut ? ` (the last ${room} of ${log.length} characters)` : ''} ---`, isCut ? log.slice(log.length - room) : log || '(empty)'].join('\n')
}

async function validateText($: $, rawPath: string): Promise<string> {
  const path = expand(rawPath.trim(), await home($)).replace(/\/+$/, '')
  if (!path) return 'error: give the path of a flow.yaml or of its folder'
  const isFile = /\.ya?ml$/i.test(path)
  const file = isFile ? path : `${path}/flow.yaml`
  const dir = isFile ? path.replace(/\/[^/]*$/, '') || '.' : path
  if (!(await $.fs.exists(file).catch(() => false))) return `error: no file at ${file}`
  let text: string
  try {
    text = await $.fs.read(file)
  } catch (err) {
    return `error: cannot read ${file}: ${errText(err)}`
  }
  const found = parseWorkflow(text, dir, file)
  await refreshWorkflows($).catch(() => undefined)
  // A python step's script, when its path has no template, must be there.
  for (const [i, s] of (found.workflow?.steps ?? []).entries()) {
    const script = s.python?.file
    if (!script || script.includes('{{')) continue
    const path = expand(script, await home($))
    const abs = path.startsWith('/') ? path : `${dir}/${path.replace(/^\.\/+/, '')}`
    if (!(await $.fs.exists(abs).catch(() => false))) found.errors.push(`steps[${i}].python.file: no script at ${abs}`)
  }
  if (found.errors.length || !found.workflow) return found.errors.join('\n') || 'error: the workflow did not load'
  const order = stepLevels(found.workflow.steps).map((group, i) => `${i + 1}. ${group.map(s => s.id).join(', ')}`)
  return ['valid', ...order].join('\n')
}

async function registerTools($: $): Promise<void> {
  const where = `Workflows are saved flow.yaml files, one folder each, in the flows folder (${workflowsDir}), in the sources its flows.yaml lists (teams' shared git repos, cloned under ~/.flow/sources), and in .flows/ of the current project.`
  const prefer =
    'Prefer fixed steps (run, python, mcp, http, wait, approve, uses), which run the same way every time; use agent or claude steps only where judgment is needed (summarising, writing prose, deciding).'
  await $.tool.register({
    name: 'list_workflows',
    description:
      `List the saved flow workflows the user can run. A workflow is a flow.yaml (a form of inputs and a list of steps: shell commands, python scripts, MCP tool calls, HTTP requests, flow agents, approval gates, prompts to this session, waits for a file, URL or time, and other workflows run as child runs; steps can have if: conditions, retries, for_each items and required output files). ${where} ` +
      'Returns JSON: id, source (the source it came from, when not the flows folder), title, description, owner, tags, env (variables that must be set), inputs (id, label, type, required, options, default), steps (id, kind, title, isAI: true for agent and claude steps), aiSteps and fixedSteps (counts) and errors. ' +
      `Use it when the user asks which workflows exist or wants to run one, before run_workflow. ${prefer}`,
    inputSchema: { type: 'object', properties: {} },
  })
  await $.tool.register({
    name: 'run_workflow',
    description:
      `Start a run of a saved flow workflow by its id (from list_workflows). ${where} ` +
      'Inputs are strings keyed by input id; inputs left out take their defaults. Returns the run id, or the problems (missing required inputs, unset env variables, missing files) and nothing starts. ' +
      'The run goes on in the background; the user watches it in /workflow and you can check it with run_status.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The workflow id.' },
        inputs: { type: 'object', additionalProperties: { type: 'string' }, description: 'Input values by input id, as strings (true/false for booleans, YYYY-MM-DD for dates, absolute paths for files and folders).' },
      },
      required: ['id'],
    },
  })
  await $.tool.register({
    name: 'run_status',
    description:
      'The status of a flow workflow run (by the run id run_workflow returned): the run, then each step with its status (with the attempt, a false if:, a child run or the error when there is one), each for_each item, and the start of its output.',
    inputSchema: { type: 'object', properties: { run: { type: 'string', description: 'The run id.' } }, required: ['run'] },
  })
  await $.tool.register({
    name: 'complete_step',
    description:
      'Report back on a step a flow workflow handed to you (a message starting "[flow] Workflow ..."): call it once the step\'s work is done, with the run and step ids from that message, ok true or false, and a one-paragraph output. Only for a step waiting on you.',
    inputSchema: {
      type: 'object',
      properties: {
        run: { type: 'string', description: 'The run id from the [flow] message.' },
        step: { type: 'string', description: 'The step id from the [flow] message.' },
        ok: { type: 'boolean', description: 'true when the step succeeded.' },
        output: { type: 'string', description: 'One paragraph: what was done, or why it failed. It becomes the step\'s output.' },
      },
      required: ['run', 'step', 'ok', 'output'],
    },
  })
  await $.tool.register({
    name: 'decide_step',
    description:
      'Approve or reject a flow workflow approve step that is waiting (run_status shows it as waiting). Only when the user says so, e.g. "approve it" or "reject the report": ok true approves and the run goes on; ok false rejects, the step fails and the steps after it are skipped. Not for steps handed to you (use complete_step).',
    inputSchema: {
      type: 'object',
      properties: {
        run: { type: 'string', description: 'The run id.' },
        step: { type: 'string', description: 'The approve step id.' },
        ok: { type: 'boolean', description: 'true to approve, false to reject.' },
        output: { type: 'string', description: 'Optional note; it becomes the step\'s output (default "approved" or "rejected").' },
      },
      required: ['run', 'step', 'ok'],
    },
  })
  await $.tool.register({
    name: 'validate_workflow',
    description:
      `Check a flow workflow file (flow.yaml) after writing or editing one. ${where} ` +
      'Give the path of the flow.yaml or of its folder. Returns "valid" and the order the steps run in (steps on one line run in parallel), or the problems, one per line. ' +
      `Step kinds: run, python (a script file or inline code, argv with no shell), mcp (a tool on a connected MCP server), http (one request), agent, claude, approve, wait, uses. ${prefer}`,
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to a flow.yaml, or to the folder holding it.' } }, required: ['path'] },
  })
  await $.tool.register({
    name: 'list_views',
    description:
      `List the flow views the user can open on the /workflow Views tab. A view (view.yaml, beside workflows in ${workflowsDir} and its sources) is a search, a list and a detail page over MCP tool calls, such as a team's listener or customer lookup. ` +
      'Returns JSON: id, source, title, description, whether it has a search, its filters, its detail sections, and errors. Use it before open_view.',
    inputSchema: { type: 'object', properties: {} },
  })
  await $.tool.register({
    name: 'open_view',
    description:
      'Open a flow view on the /workflow Views tab for the user. With query (and optionally filter), it runs the view\'s search and returns the rows it found with their keys. ' +
      'With key, it opens that item\'s detail page and returns what the page shows as text (each section\'s numbers and lines), so you can answer questions about it too. ' +
      'Use it when the user asks to look someone or something up in a view, e.g. "show me listener 4004" or "find listeners named Sam".',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The view id (from list_views).' },
        query: { type: 'string', description: 'Search text for the view\'s list.' },
        filter: { type: 'string', description: 'A filter id from list_views; default the view\'s first.' },
        key: { type: 'string', description: 'An item\'s key, to open its detail page.' },
        tab: { type: 'string', description: 'With key: the detail tab to open (its id or title).' },
        page: { type: 'number', description: 'With query: the page of results, from 1 (views with paged lists).' },
      },
      required: ['id'],
    },
  })
  await $.tool.register({
    name: 'pull_sources',
    description:
      `Fetch the latest flow workflows from every source listed under sources: in ${workflowsDir}/flows.yaml (a team's shared git repo of workflows): clones the ones not on this Mac yet and fast-forwards the rest, then reloads the workflow list. ` +
      'Returns one line per source: cloned, pulled, or why it failed (no access, a diverged branch). Use it when the user asks to update, pull or sync their workflows, or when a workflow they name is in a source but not found yet.',
    inputSchema: { type: 'object', properties: {} },
  })
  await $.tool.register({
    name: 'cancel_run',
    description:
      'Cancel a flow workflow run that is running or waiting (by the run id): running and waiting steps are stopped and cancelled, pending ones skipped, no retry starts, and child runs its uses steps started are cancelled too. Only when the user asks to stop or cancel a run.',
    inputSchema: { type: 'object', properties: { run: { type: 'string', description: 'The run id.' } }, required: ['run'] },
  })
  await $.tool.register({
    name: 'step_log',
    description:
      "One step's full log (the last 200000 characters at most) and its output, from a flow workflow run; for an agent step, also the tools its agent used when this session can read them. " +
      'Use it to see what a step actually did: why it failed, or, to harden a workflow, the mechanical work an agent step did that a python, mcp or http step could do instead. Give item for one item of a for_each step.',
    inputSchema: {
      type: 'object',
      properties: {
        run: { type: 'string', description: 'The run id.' },
        step: { type: 'string', description: 'The step id.' },
        item: { type: 'number', description: 'A for_each step: the item index, from 0.' },
      },
      required: ['run', 'step'],
    },
  })
}

// ---------------------------------------------------------------------------

export function registerRunner(on: Parameters<Register>[0], options: Record<string, unknown>): void {
  live.clear()
  agentSteps.clear()
  cloneTried.clear()
  pulls.clear()
  queuedPrompts.length = 0
  isHydrated = false
  sessionCwd = undefined
  workflowsDir = typeof options.workflowsDir === 'string' && options.workflowsDir.trim() ? options.workflowsDir.trim() : '~/Documents/flows'

  // progress.tsx hooks session.start and turn.complete without a matcher, and a
  // plugin may do that once per event: these matchers name every case, so the
  // runner's hooks still see every session and every turn end.
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const started = await next(e)
    sessionCwd = e.cwd
    await registerTools($)
    await refreshWorkflows($).catch(() => undefined)
    // A new session: nothing of the last one is still going.
    isHydrated = true
    await loadRuns($).catch(() => undefined)
    // The hub pane's command and env check: a second matched session.start
    // would have to name every case again.
    await hubSessionStart($, await read($, workflowsAtom)).catch(() => undefined)
    try {
      $.clock.every(250, () => void read($, runsAtom).then(runs => hubTick($, runs)).catch(() => undefined))
    } catch {
      // No timer here (a test kit): the hub's shimmer stands still.
    }
    return started
  })

  on('turn.complete', { reason: ['answer', 'aborted', 'refusal', 'error'] }, async ($, e, next) => {
    const hit = e.agentId ? agentSteps.get(e.agentId) : undefined
    if (hit && e.agentId) {
      agentSteps.delete(e.agentId)
      await agentDone($, hit, e).catch(() => undefined)
    }
    if (!e.agentId && queuedPrompts.length) sendQueuedPrompts($)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__flow__list_workflows' }, async $ => {
    const found = await refreshWorkflows($)
    return { result: JSON.stringify(found.map(describeWorkflow), null, 2) }
  })

  on('tool.call', { tool: 'mcp__flow__run_workflow' }, async ($, e) => {
    const input = e as unknown as { id?: unknown; inputs?: unknown }
    const raw = input.inputs && typeof input.inputs === 'object' && !Array.isArray(input.inputs) ? (input.inputs as Record<string, unknown>) : {}
    const { run, problems } = await startRun($, str(input.id), raw)
    if (!run) return { result: `Not started:\n${problems.map(p => `- ${p}`).join('\n')}` }
    return { result: `Started run ${run}. Watch it in /workflow, or check it with run_status.\n\n${await runStatusText($, run)}` }
  })

  on('tool.call', { tool: 'mcp__flow__run_status' }, async ($, e) => ({ result: await runStatusText($, str((e as unknown as { run?: unknown }).run)) }))

  on('tool.call', { tool: 'mcp__flow__complete_step' }, async ($, e) => {
    const input = e as unknown as { run?: unknown; step?: unknown; ok?: unknown; output?: unknown }
    const runId = str(input.run)
    const stepId = str(input.step)
    const ctx = await liveCtx($, runId)
    if (!ctx) return { result: `error: no run ${runId}` }
    const spec = specOf(ctx.wf, stepId)
    const step = stepOf(ctx.run, stepId)
    if (!spec || !step) return { result: `error: run ${runId} has no step "${stepId}"` }
    if (spec.kind !== 'claude') return { result: `error: step "${stepId}" is ${/^[aeiou]/.test(spec.kind) && spec.kind !== 'uses' ? 'an' : 'a'} ${spec.kind} step, not one handed to you` }
    if (step.status !== 'waiting') return { result: `error: step "${stepId}" is ${step.status}, not waiting` }
    const ok = input.ok === true || input.ok === 'true'
    const { error } = await decideStep($, runId, stepId, ok, str(input.output))
    if (error) return { result: `error: ${error}` }
    return { result: `Recorded: step "${stepId}" ${ok ? 'done' : 'failed'}. Run ${runId} is now ${ctx.run.status}.` }
  })

  on('tool.call', { tool: 'mcp__flow__decide_step' }, async ($, e) => {
    const input = e as unknown as { run?: unknown; step?: unknown; ok?: unknown; output?: unknown }
    const runId = str(input.run)
    const stepId = str(input.step)
    const ctx = await liveCtx($, runId)
    if (!ctx) return { result: `error: no run ${runId}` }
    const spec = specOf(ctx.wf, stepId)
    const step = stepOf(ctx.run, stepId)
    if (!spec || !step) return { result: `error: run ${runId} has no step "${stepId}"` }
    if (spec.kind !== 'approve')
      return { result: `error: step "${stepId}" is ${/^[aeiou]/.test(spec.kind) && spec.kind !== 'uses' ? 'an' : 'a'} ${spec.kind} step, not an approval${spec.kind === 'claude' ? ' (use complete_step)' : ''}` }
    if (step.status !== 'waiting') return { result: `error: step "${stepId}" is ${step.status}, not waiting` }
    const ok = input.ok === true || input.ok === 'true'
    const { error } = await decideStep($, runId, stepId, ok, str(input.output))
    if (error) return { result: `error: ${error}` }
    return { result: `Recorded: step "${stepId}" ${ok ? 'approved' : 'rejected'}. Run ${runId} is now ${ctx.run.status}.` }
  })

  on('tool.call', { tool: 'mcp__flow__pull_sources' }, async $ => ({ result: (await pullSources($)).join('\n') }))

  on('tool.call', { tool: 'mcp__flow__list_views' }, async $ => {
    await refreshWorkflows($)
    const views = await read($, viewsAtom)
    return {
      result: JSON.stringify(
        views.map(v => ({
          id: v.id,
          ...(v.source ? { source: v.source } : {}),
          title: v.view?.title ?? v.id,
          description: v.view?.description ?? '',
          hasSearch: Boolean(v.view?.search),
          filters: (v.view?.filters ?? []).map(f => ({ id: f.id, label: f.label })),
          sections: (v.view?.detail?.sections ?? []).map(s => s.title),
          errors: v.errors,
        })),
        null,
        2,
      ),
    }
  })

  on('tool.call', { tool: 'mcp__flow__open_view' }, async ($, e) => {
    const input = e as unknown as { id?: unknown; query?: unknown; filter?: unknown; key?: unknown; tab?: unknown; page?: unknown }
    const id = str(input.id)
    const view = await viewOf($, id)
    if (!view) return { result: `error: no view "${id}" (list_views lists them)` }
    await showView($, id)
    const key = str(input.key)
    if (key) {
      if (!view.detail) return { result: `error: view "${id}" has no detail page` }
      const want = str(input.tab).toLowerCase()
      const tab = want ? view.detail.tabs.find(t => t.id === want || t.title.toLowerCase() === want) : undefined
      if (want && !tab) return { result: `error: view "${id}" has no tab "${want}" (${view.detail.tabs.map(t => t.id).join(', ') || 'none'})` }
      const state = await viewOpen($, id, key, tab?.id)
      return { result: state ? viewDetailText(view, state) : 'error: the view did not open' }
    }
    const filter = str(input.filter) || undefined
    if (filter && filter.split(',').some(x => !view.filters.some(f => f.id === x.trim()))) return { result: `error: view "${id}" has no filter "${filter}" (${view.filters.map(f => f.id).join(', ') || 'none'})` }
    const state = await viewSearch($, id, str(input.query), filter, Number(input.page) || 1)
    const list = state?.list
    if (!list || list.state !== 'ok') return { result: `error: ${list?.state === 'error' ? list.message : 'the search did not run'}` }
    const { items, total } = list.value as { items: unknown[]; total: number }
    const rows = items.map(item => `- ${getPath(item, view.list.key)}: ${fillView(view.list.rows.text, { item })}${view.list.rows.subtitle ? ` (${fillView(view.list.rows.subtitle, { item })})` : ''}`)
    return { result: [`${total} found${total > items.length ? `, showing ${items.length}` : ''}. Opened in /workflow. Keys first; open_view with key opens one.`, ...rows].join('\n') }
  })

  on('tool.call', { tool: 'mcp__flow__validate_workflow' }, async ($, e) => ({ result: await validateText($, str((e as unknown as { path?: unknown }).path)) }))

  on('tool.call', { tool: 'mcp__flow__cancel_run' }, async ($, e) => {
    const runId = str((e as unknown as { run?: unknown }).run)
    const { error } = await cancelRun($, runId)
    if (error) return { result: `error: ${error}` }
    return { result: `Cancelled run ${runId}.\n\n${await runStatusText($, runId)}` }
  })

  on('tool.call', { tool: 'mcp__flow__step_log' }, async ($, e) => {
    const input = e as unknown as { run?: unknown; step?: unknown; item?: unknown }
    return { result: await stepLogText($, str(input.run), str(input.step), input.item) }
  })
}
