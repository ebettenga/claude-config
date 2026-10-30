// How the Workflows page groups and orders workflows: flows.yaml at the root
// of the flows folder, kept in git with the workflows. No `$` here, so the
// rules can be tested on their own; runner.ts reads and writes the file.
//
//   groups:
//     - title: Reports
//       workflows: [csv-summary, orders-digest]
//     - title: Code
//       workflows: [repo-health-check]
//
// Workflows no group lists come last, under "Other", in folder order.
//
// It may also list sources: other folders of workflows, usually a team's git
// repo, cloned to ~/.flow/sources/<name> unless `path` says where.
//
//   sources:
//     - name: team
//       title: Team
//       git: git@gitlab.com:example-org/flows.git
//
// A source's own flows.yaml groups show after these groups, titled
// "<source title> · <group>", and the rest of its workflows under its title.

import { dump, load } from './vendor/js-yaml.mjs'
import type { Found, Layout, LayoutGroup, Source } from '../types'

export const LAYOUT_FILE = 'flows.yaml'
export const OTHER = 'Other'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** flows.yaml's groups, and what in it is wrong (by field); empty text is no groups. */
export function parseLayout(text: string): Layout {
  const errors: string[] = []
  let raw: unknown
  try {
    raw = text.trim() ? load(text) : {}
  } catch (err) {
    return { groups: [], errors: [`${LAYOUT_FILE}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`] }
  }
  if (raw === null || raw === undefined) raw = {}
  if (!isObj(raw)) return { groups: [], errors: [`${LAYOUT_FILE}: must be a mapping with groups:`] }
  for (const k of Object.keys(raw)) if (k !== 'groups' && k !== 'sources') errors.push(`${LAYOUT_FILE}.${k}: is not a field (use groups or sources)`)
  const list = raw.groups === undefined || raw.groups === null ? [] : raw.groups
  if (!Array.isArray(list)) return { groups: [], errors: [...errors, `${LAYOUT_FILE}.groups: must be a list`] }
  const groups: LayoutGroup[] = []
  const seen = new Map<string, string>()
  list.forEach((g, i) => {
    const at = `${LAYOUT_FILE}.groups[${i}]`
    if (!isObj(g)) return void errors.push(`${at}: must be a mapping with title and workflows`)
    const title = typeof g.title === 'string' ? g.title.trim() : ''
    if (!title) errors.push(`${at}.title: is empty`)
    else if (title === OTHER) errors.push(`${at}.title: "${OTHER}" is kept for workflows no group lists`)
    else if (groups.some(x => x.title === title)) errors.push(`${at}.title: "${title}" is used twice`)
    const ids = Array.isArray(g.workflows) ? g.workflows.filter((w): w is string => typeof w === 'string' && w.trim() !== '').map(w => w.trim()) : []
    if (g.workflows !== undefined && !Array.isArray(g.workflows)) errors.push(`${at}.workflows: must be a list of workflow ids`)
    const kept: string[] = []
    for (const id of ids) {
      const other = seen.get(id)
      if (other !== undefined) errors.push(`${at}.workflows: "${id}" is already in ${other}`)
      else {
        seen.set(id, title || `group ${i + 1}`)
        kept.push(id)
      }
    }
    if (title && title !== OTHER && !groups.some(x => x.title === title)) groups.push({ title, workflows: kept })
  })
  return { groups, errors }
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** flows.yaml's sources, with ~ expanded; each problem named by field. */
export function parseSources(text: string, homeDir: string): { sources: Source[]; errors: string[] } {
  let raw: unknown
  try {
    raw = text.trim() ? load(text) : {}
  } catch {
    return { sources: [], errors: [] } // parseLayout reports a file that does not parse
  }
  const list = isObj(raw) ? raw.sources : undefined
  if (list === undefined || list === null) return { sources: [], errors: [] }
  if (!Array.isArray(list)) return { sources: [], errors: [`${LAYOUT_FILE}.sources: must be a list`] }
  const errors: string[] = []
  const sources: Source[] = []
  const home = homeDir.replace(/\/+$/, '')
  const expand = (p: string) => (p === '~' ? home : p.startsWith('~/') ? `${home}${p.slice(1)}` : p).replace(/\/+$/, '')
  list.forEach((s, i) => {
    const at = `${LAYOUT_FILE}.sources[${i}]`
    if (!isObj(s)) return void errors.push(`${at}: must be a mapping with name and git or path`)
    const name = typeof s.name === 'string' ? s.name.trim() : ''
    if (!NAME_RE.test(name)) return void errors.push(`${at}.name: must be kebab-case, e.g. team-flows`)
    if (sources.some(x => x.name === name)) return void errors.push(`${at}.name: "${name}" is used twice`)
    const git = typeof s.git === 'string' && s.git.trim() ? s.git.trim() : undefined
    const given = typeof s.path === 'string' && s.path.trim() ? s.path.trim() : undefined
    if (!git && !given) return void errors.push(`${at}: needs git (a clone URL) or path (a folder)`)
    const path = expand(given ?? `~/.flow/sources/${name}`)
    if (!path.startsWith('/')) return void errors.push(`${at}.path: must be absolute or start with ~/`)
    for (const k of Object.keys(s)) if (!['name', 'title', 'git', 'branch', 'path'].includes(k)) errors.push(`${at}.${k}: is not a field`)
    const title = typeof s.title === 'string' && s.title.trim() ? s.title.trim() : name
    const branch = typeof s.branch === 'string' && s.branch.trim() ? s.branch.trim() : undefined
    sources.push({ name, title, path, ...(git ? { git } : {}), ...(branch ? { branch } : {}) })
  })
  return { sources, errors }
}

/** The file's text for these groups; `sources` (as the file had them) are kept as they were. */
export function layoutYaml(groups: LayoutGroup[], sources?: unknown): string {
  const head = '# How /flow groups and orders the workflows. Workflows no group lists come last, under Other.\n'
  const body: Record<string, unknown> = { groups: groups.map(g => ({ title: g.title, workflows: g.workflows })) }
  if (Array.isArray(sources) && sources.length) body.sources = sources
  return head + dump(body, { flowLevel: 3, lineWidth: 120 })
}

/** The `sources:` list as a flows.yaml's text has it, untouched, for layoutYaml. */
export function rawSources(text: string): unknown {
  try {
    const raw = text.trim() ? load(text) : undefined
    return isObj(raw) ? raw.sources : undefined
  } catch {
    return undefined
  }
}

/** A section from a source's own groups is read-only: Arrange does not offer to move or rename it. */
export type Section<F> = { title: string; isOther: boolean; isSource?: boolean; items: F[] }

/**
 * The page's sections: each group with the workflows it lists that exist, in
 * order, then each source's groups (`sourceGroups`, shown only when not empty),
 * then Other.
 */
export function arrange<F extends Pick<Found, 'id'>>(found: F[], groups: LayoutGroup[], sourceGroups: LayoutGroup[] = []): Section<F>[] {
  const byId = new Map(found.map(f => [f.id, f]))
  const placed = new Set<string>()
  const take = (g: LayoutGroup) => {
    const items = g.workflows.map(id => byId.get(id)).filter((f): f is F => Boolean(f) && !placed.has(f!.id))
    for (const f of items) placed.add(f.id)
    return items
  }
  const sections: Section<F>[] = groups.map(g => ({ title: g.title, isOther: false, items: take(g) }))
  for (const g of sourceGroups) {
    const items = take(g)
    if (items.length) sections.push({ title: g.title, isOther: false, isSource: true, items })
  }
  const rest = found.filter(f => !placed.has(f.id))
  if (rest.length || !sections.length) sections.push({ title: OTHER, isOther: true, items: rest })
  return sections
}

// ── edits: each takes the groups and gives the new groups ──

/** Keeps the ids of workflows that are gone, so a workflow missing on this machine keeps its place. */
const clone = (groups: LayoutGroup[]) => groups.map(g => ({ title: g.title, workflows: [...g.workflows] }))

/** Moves a workflow up or down among what its section shows (`shown`: that section's ids, in order). */
export function moveWorkflow(groups: LayoutGroup[], id: string, shown: string[], by: -1 | 1): LayoutGroup[] {
  const next = clone(groups)
  const g = next.find(x => x.workflows.includes(id))
  const i = shown.indexOf(id)
  const j = i + by
  if (!g || i < 0 || j < 0 || j >= shown.length) return next
  const other = shown[j] as string
  const a = g.workflows.indexOf(id)
  const b = g.workflows.indexOf(other)
  if (b < 0) return next
  g.workflows[a] = other
  g.workflows[b] = id
  return next
}

/** Puts a workflow at the end of a group, or back in Other. */
export function setGroup(groups: LayoutGroup[], id: string, title: string): LayoutGroup[] {
  const next = clone(groups).map(g => ({ ...g, workflows: g.workflows.filter(w => w !== id) }))
  const g = next.find(x => x.title === title)
  if (g) g.workflows.push(id)
  return next
}

/** A new empty group at the end; nothing changes for a title that is empty, Other or taken. */
export function addGroup(groups: LayoutGroup[], title: string): LayoutGroup[] {
  const t = title.trim()
  if (!t || t === OTHER || groups.some(g => g.title === t)) return clone(groups)
  return [...clone(groups), { title: t, workflows: [] }]
}

export function renameGroup(groups: LayoutGroup[], from: string, to: string): LayoutGroup[] {
  const t = to.trim()
  if (!t || t === OTHER || (t !== from && groups.some(g => g.title === t))) return clone(groups)
  return clone(groups).map(g => (g.title === from ? { ...g, title: t } : g))
}

export function moveGroup(groups: LayoutGroup[], title: string, by: -1 | 1): LayoutGroup[] {
  const next = clone(groups)
  const i = next.findIndex(g => g.title === title)
  const j = i + by
  if (i < 0 || j < 0 || j >= next.length) return next
  ;[next[i], next[j]] = [next[j] as LayoutGroup, next[i] as LayoutGroup]
  return next
}

/** Removes a group; its workflows go back to Other. */
export function removeGroup(groups: LayoutGroup[], title: string): LayoutGroup[] {
  return clone(groups).filter(g => g.title !== title)
}
