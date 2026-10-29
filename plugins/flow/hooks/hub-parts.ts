// What the /flow-chart hub draws with: its palette, the step-kind colors,
// formatting, the svg strings, a run's outputs and the skills/agents catalog.
// No elements here: hooks/hub.tsx draws.

import type { EngineInterface } from 'claude-code'

import type { CatalogItem, HubCatalog, ItemRun, Run, RunStatus, StepKind, StepRun, StepSpec, StepStatus, Workflow } from '../types'
import { fill, isAIStep } from './spec'
import type { TemplateContext } from './spec'
import { BY_EXTENSION, BY_FILE_NAME, BY_FOLDER_NAME, ICON_FILE, ICON_FOLDER } from './icons'
import { load } from './vendor/js-yaml.mjs'

// ── look (design/flow-chart-mockup.png) ──────────────────────────────────

export const C = {
  pane: '#1b1b1b',
  card: '#232323',
  tile: '#262626',
  chip: '#2a2a2a',
  tag: '#2e2e2e',
  field: '#1d1d1d',
  log: '#161616',
  track: '#2c2c2c',
  border: '#323232',
  text: '#e8e8e8',
  body: '#bdbdbd',
  dim: '#8c8c8c',
  faint: '#5f5f5f',
  logText: '#a9a9a9',
  read: '#b794f6',
  edit: '#f6a05a',
  dirty: '#e8c468',
  add: '#8fd18b',
  del: '#f07a7a',
  blue: '#6ea8e8',
  teal: '#5cc8c0',
  img: '#e48ad8',
}

export const KIND: Record<StepKind, string> = {
  run: '#6ea8e8',
  python: '#4fb3a5',
  mcp: '#c792ea',
  http: '#82aaff',
  agent: '#b794f6',
  claude: '#f6a05a',
  approve: '#e8c468',
  wait: '#5cc8c0',
  uses: '#8fd18b',
}

/** The hue at low alpha, drawn behind text of the same hue. */
export const tint = (hex: string, alpha = '2b') => `${hex}${alpha}`

const mix = (hex: string, t: number) => {
  const n = Number.parseInt(hex.slice(1, 7), 16)
  const ch = (shift: number) => Math.round(((n >> shift) & 255) + (255 - ((n >> shift) & 255)) * t)
  return `#${[16, 8, 0].map(s => ch(s).toString(16).padStart(2, '0')).join('')}`
}

/** The four shades a running step's title runs through. */
export const shades = (hex: string) => [hex, mix(hex, 0.3), mix(hex, 0.55), mix(hex, 0.3)]

export const RUN_COLOR: Record<RunStatus, string> = {
  running: C.read,
  waiting: C.dirty,
  done: C.add,
  failed: C.del,
  cancelled: C.dim,
  interrupted: C.dirty,
}

export const MARK: Record<StepStatus, { glyph: string; color: string }> = {
  done: { glyph: '✓', color: C.add },
  running: { glyph: '●', color: C.read },
  waiting: { glyph: '◷', color: C.dirty },
  failed: { glyph: '✗', color: C.del },
  skipped: { glyph: '–', color: C.dim },
  pending: { glyph: '○', color: C.dim },
  cancelled: { glyph: '✗', color: C.dim },
  interrupted: { glyph: '!', color: C.dirty },
}

// ── svg (desktop only) ───────────────────────────────────────────────────

export const ICON = {
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
}

export const strokeSvg = (body: string, color: string, size = 24) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" color="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

/** The Running now card's disc: the hue at 20% behind its icon. */
export const discSvg = (body: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="${color}" fill-opacity="0.2"/><g transform="translate(10 10) scale(0.8333)" fill="none" stroke="${color}" color="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`

/** A 6 px progress bar, `pct` from 0 to 1. */
export const barSvg = (width: number, pct: number, color: string) => {
  const w = Math.max(1, Math.round(width))
  const fillW = Math.max(0, Math.min(w, Math.round(w * pct)))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="6" viewBox="0 0 ${w} 6"><rect width="${w}" height="6" rx="3" fill="${C.track}"/>${fillW ? `<rect width="${fillW}" height="6" rx="3" fill="${color}"/>` : ''}</svg>`
}

/** The terminal's bar. */
export const barText = (cols: number, pct: number) => {
  const filled = Math.max(0, Math.min(cols, Math.round(cols * pct)))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, cols - filled))
}

// Material Icon Theme's icon for a file (as filedeck): by its whole name, then
// its longest known extension, then the plain file.
export function fileIconOf(name: string): string {
  const lower = name.toLowerCase()
  const byName = BY_FILE_NAME[lower]
  if (byName) return byName
  const parts = lower.split('.')
  for (let i = 1; i < parts.length; i++) {
    const byExt = BY_EXTENSION[parts.slice(i).join('.')]
    if (byExt) return byExt
  }
  return ICON_FILE
}
export const folderIconOf = (name: string, isOpen = false) => (BY_FOLDER_NAME[name.toLowerCase()] ?? ICON_FOLDER)[isOpen ? 1 : 0]

/** The terminal's (and a missing svg's) stand-in: a short type label and its hue. */
export function badgeOf(name: string): { label: string; color: string } {
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
  if (/^(png|jpe?g|gif|webp|svg|ico|avif|heic)$/.test(ext)) return { label: 'IMG', color: C.img }
  if (ext === 'pdf') return { label: 'PDF', color: C.del }
  if (/^(csv|tsv|xlsx?)$/.test(ext)) return { label: ext.toUpperCase(), color: C.add }
  if (/^(md|mdx|txt)$/.test(ext)) return { label: ext.toUpperCase(), color: C.blue }
  if (/^(json|ya?ml|toml)$/.test(ext)) return { label: ext === 'json' ? '{}' : 'CFG', color: C.dirty }
  return { label: ext ? ext.slice(0, 4).toUpperCase() : 'FILE', color: C.dim }
}

// ── formatting ───────────────────────────────────────────────────────────

export const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p
export const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) || '/' : '')
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  if (h < 48) return 'yesterday'
  return `${Math.floor(h / 24)} days ago`
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export const firstLine = (s: string) => (s.split('\n').find(l => l.trim()) ?? '').trim()

/** The first sentence, without its full stop. */
export function firstSentence(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  const end = /[.!?](\s|$)/.exec(flat)
  return (end ? flat.slice(0, end.index) : flat).replace(/[.:;]$/, '')
}

/** Home folder as ~. */
export const tildify = (path: string, home: string) => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path)
export const expandHome = (path: string, home: string) => (path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path)

/** A Markdown link target that opens Claude's file viewer: relative inside the session folder, else file://. */
export function linkTarget(abs: string, cwd: string): string {
  const root = cwd.replace(/\/+$/, '')
  const target = root && abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : `file://${abs}`
  return encodeURI(target).replace(/\(/g, '%28').replace(/\)/g, '%29')
}

/** Brackets and the like would end a Markdown link's label early. */
export const mdLabel = (s: string) => s.replace(/([\\[\]])/g, '\\$1')

// ── workflows and runs ───────────────────────────────────────────────────

export function stepCounts(wf: Workflow): { fixed: number; ai: number } {
  const ai = wf.steps.filter(isAIStep).length
  return { fixed: wf.steps.length - ai, ai }
}

/** The line under a step's title: what it runs, for each what, if what. */
export function stepSub(spec: StepSpec, itemCount?: number): string {
  const parts: string[] = []
  switch (spec.kind) {
    case 'run':
      parts.push(firstLine(spec.body))
      break
    case 'python':
      parts.push(spec.python?.file ?? 'inline python')
      break
    case 'mcp':
      parts.push(spec.mcp ? `${spec.mcp.server} · ${spec.mcp.tool}` : firstLine(spec.body))
      break
    case 'http':
      parts.push(spec.http ? `${spec.http.method} ${spec.http.url}` : firstLine(spec.body))
      break
    case 'agent':
      parts.push(spec.tier ?? 'agent')
      break
    case 'claude':
      parts.push('Claude, in this session')
      break
    case 'approve':
      parts.push('you approve')
      break
    case 'wait':
      parts.push(spec.wait ? `${spec.wait.kind}: ${spec.wait.target}` : '')
      break
    case 'uses':
      parts.push(spec.uses ?? firstLine(spec.body))
      break
  }
  if (spec.forEach !== undefined) parts.push(`for each ${spec.as ?? 'item'}${itemCount ? ` ×${itemCount}` : ''}`)
  if (spec.if) parts.push(`if ${spec.if}`)
  return parts.filter(Boolean).join(' · ')
}

const isSettled = (s: StepStatus) => s !== 'pending' && s !== 'running' && s !== 'waiting'

/** Units of work: a step, or each item of a for_each step. */
export function progressOf(run: Run): { settled: number; total: number } {
  let settled = 0
  let total = 0
  for (const s of run.steps) {
    if (s.items?.length && !isSettled(s.status)) {
      total += s.items.length
      settled += s.items.filter(i => isSettled(i.status)).length
    } else {
      total += s.items?.length || 1
      settled += isSettled(s.status) ? s.items?.length || 1 : 0
    }
  }
  return { settled, total: Math.max(1, total) }
}

/** The step the run is on: running first, then waiting. */
export const currentStep = (run: Run): StepRun | undefined =>
  run.steps.find(s => s.status === 'running') ?? run.steps.find(s => s.status === 'waiting')

/** "Write report · 2 of 4 clients done", or "… · 2 of 5 steps done". */
export function nowLine(run: Run, wf: Workflow | undefined): string {
  const step = currentStep(run)
  const spec = step && wf?.steps.find(s => s.id === step.id)
  const title = spec?.title ?? step?.id ?? ''
  if (step?.items?.length) {
    const done = step.items.filter(i => isSettled(i.status)).length
    return `${title} · ${done} of ${plural(step.items.length, spec?.as ?? 'item')} done`
  }
  const done = run.steps.filter(s => isSettled(s.status)).length
  return `${title ? `${title} · ` : ''}${done} of ${run.steps.length} steps done`
}

/** A workflow's last run, as its card says it. */
export function lastRunLine(runs: Run[], workflowId: string, now: number): { text: string; color: string } {
  const run = runs.find(r => r.workflowId === workflowId && !r.parent) ?? runs.find(r => r.workflowId === workflowId)
  if (!run) return { text: 'never run', color: C.dim }
  const when = ago(run.endedAt ?? run.startedAt, now)
  switch (run.status) {
    case 'running':
      return { text: '● running', color: C.read }
    case 'waiting':
      return { text: '◷ waiting', color: C.dirty }
    case 'done':
      return { text: `✓ ${when}`, color: C.add }
    case 'failed':
      return { text: `✗ ${Math.max(1, run.steps.filter(s => s.status === 'failed').length)} failed · ${when}`, color: C.del }
    case 'cancelled':
      return { text: `cancelled · ${when}`, color: C.dim }
    case 'interrupted':
      return { text: `! interrupted · ${when}`, color: C.dirty }
  }
}

/** The workflow's outputs, then each step's (per item), relative to the run folder. */
export function outputCandidates(run: Run, wf: Workflow): string[] {
  const outputs: Record<string, string> = {}
  for (const s of run.steps) if (s.status === 'done') outputs[s.id] = s.output
  const base: TemplateContext = { inputs: run.inputs, outputs, runDir: run.dir }
  const paths: string[] = []
  const add = (p: string, item?: TemplateContext['item']) => {
    const rel = fill(p, { ...base, item }).trim().replace(/^\.\/+/, '')
    if (rel && !rel.includes('{{') && !paths.includes(rel)) paths.push(rel)
  }
  for (const p of wf.outputs) add(p)
  for (const spec of wf.steps) {
    const step = run.steps.find(s => s.id === spec.id)
    if (!step || !spec.outputs?.length) continue
    if (spec.forEach === undefined) for (const p of spec.outputs) add(p)
    else for (const [index, it] of (step.items ?? []).entries()) for (const p of spec.outputs) add(p, { value: it.value, index, as: spec.as ?? 'item' })
  }
  return paths
}

/** The log key for a step or item: `id` or `id[i]`. */
export function parseLogKey(key: string): { stepId: string; index?: number } {
  const m = /^(.*)\[(\d+)\]$/.exec(key)
  return m?.[1] !== undefined ? { stepId: m[1], index: Number(m[2]) } : { stepId: key }
}

export const itemAt = (step: StepRun | undefined, index?: number): ItemRun | undefined => (index === undefined ? undefined : step?.items?.[index])

// ── the catalog: skills and agents Claude can use ────────────────────────

/** A Markdown file's YAML frontmatter, or {} without one. */
export function frontmatter(text: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text)
  if (!m?.[1]) return {}
  try {
    const doc = load(m[1]) as unknown
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const strOf = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const cap = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s)

export async function loadCatalog($: EngineInterface): Promise<HubCatalog> {
  const home = ((await $.env.get('HOME').catch(() => undefined)) ?? '').replace(/\/+$/, '')
  const config = ((await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)) || `${home}/.claude`).replace(/\/+$/, '')
  const list = async (dir: string) => [...(await $.fs.list(dir).catch(() => []))].sort((a, b) => a.name.localeCompare(b.name))
  const isDir = (e: { kind: string; isLink?: boolean }) => e.kind === 'dir' || Boolean(e.isLink)
  const meta = async (file: string) => frontmatter(await $.fs.read(file).catch(() => ''))
  const skills: CatalogItem[] = []
  const agents: CatalogItem[] = []

  async function skillsIn(dir: string, plugin?: string) {
    for (const e of await list(dir)) {
      if (!isDir(e) || e.name.startsWith('.')) continue
      const file = `${dir}/${e.name}/SKILL.md`
      if (!(await $.fs.exists(file).catch(() => false))) continue
      const m = await meta(file)
      const name = strOf(m.name) || e.name
      const shown = plugin ? `${plugin}:${name}` : name
      if (skills.some(s => s.name === `/${shown}`)) continue
      skills.push({ name: `/${shown}`, fill: `/${shown} `, description: firstSentence(strOf(m.description)), path: file })
    }
  }
  async function agentsIn(dir: string, plugin?: string) {
    for (const e of await list(dir)) {
      if (e.kind !== 'file' || !e.name.endsWith('.md')) continue
      const file = `${dir}/${e.name}`
      const m = await meta(file)
      const name = strOf(m.name) || e.name.replace(/\.md$/, '')
      const shown = plugin ? `${plugin}:${name}` : name
      if (agents.some(a => a.name === shown)) continue
      const description = [cap(strOf(m.model)), strOf(m.effort), firstSentence(strOf(m.description))].filter(Boolean).join(' · ')
      agents.push({ name: shown, fill: `Use the ${shown} agent to `, description, path: file })
    }
  }

  await skillsIn(`${config}/skills`)
  await agentsIn(`${config}/agents`)
  // plugins/cache/<marketplace>/<plugin>/<version>/: the newest version of each plugin.
  for (const market of await list(`${config}/plugins/cache`)) {
    if (!isDir(market)) continue
    for (const plugin of await list(`${config}/plugins/cache/${market.name}`)) {
      if (!isDir(plugin)) continue
      const versions = (await list(`${config}/plugins/cache/${market.name}/${plugin.name}`)).filter(isDir)
      const newest = [...versions].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) || b.name.localeCompare(a.name))[0]
      if (!newest) continue
      const root = `${config}/plugins/cache/${market.name}/${plugin.name}/${newest.name}`
      await skillsIn(`${root}/skills`, plugin.name)
      await agentsIn(`${root}/agents`, plugin.name)
    }
  }
  return { skills, agents, at: Date.now() }
}
