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

import { dump, load } from './vendor/js-yaml.mjs'
import type { Found, Layout, LayoutGroup } from '../types'

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
  for (const k of Object.keys(raw)) if (k !== 'groups') errors.push(`${LAYOUT_FILE}.${k}: is not a field (use groups)`)
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

/** The file's text for these groups. */
export function layoutYaml(groups: LayoutGroup[]): string {
  const head = '# How /flow-chart groups and orders the workflows. Workflows no group lists come last, under Other.\n'
  return head + dump({ groups: groups.map(g => ({ title: g.title, workflows: g.workflows })) }, { flowLevel: 3, lineWidth: 120 })
}

export type Section<F> = { title: string; isOther: boolean; items: F[] }

/** The page's sections: each group with the workflows it lists that exist, in order, then Other. */
export function arrange<F extends Pick<Found, 'id'>>(found: F[], groups: LayoutGroup[]): Section<F>[] {
  const byId = new Map(found.map(f => [f.id, f]))
  const placed = new Set<string>()
  const sections: Section<F>[] = groups.map(g => {
    const items = g.workflows.map(id => byId.get(id)).filter((f): f is F => Boolean(f) && !placed.has(f!.id))
    for (const f of items) placed.add(f.id)
    return { title: g.title, isOther: false, items }
  })
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
