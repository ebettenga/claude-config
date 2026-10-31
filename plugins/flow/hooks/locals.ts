// Locals: values that differ per person (a repo folder, an AWS profile name),
// declared under a workflow's `locals:` and kept in ~/.flow/locals.yaml, a flat
// map of id to value shared by every workflow. They never go in a shared repo.
// Not for secrets: those stay in `env:`.
//
// Everything here but readLocals and setLocal is pure, so tests can use it
// without an engine.

import type { EngineInterface } from 'claude-code'

import { dump, load } from './vendor/js-yaml.mjs'
import { LOCAL_ID_RE } from './spec'
import type { Found, LocalSpec, Workflow } from '../types'

type $ = EngineInterface

export const LOCALS_FILE = '.flow/locals.yaml'
const HEAD = '# Your flow locals: values only you use. Never committed anywhere.\n'

const expand = (path: string, homeDir: string) => (path === '~' ? homeDir : path.startsWith('~/') ? `${homeDir}${path.slice(1)}` : path)

/** The values in a locals.yaml's text: string values only; anything else (or bad YAML) is left out. */
export function parseLocalsFile(text: string): Record<string, string> {
  let doc: unknown
  try {
    doc = load(text)
  } catch {
    return {}
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return {}
  const values: Record<string, string> = {}
  for (const [k, v] of Object.entries(doc)) if (typeof v === 'string') values[k] = v
  return values
}

/** A locals.yaml's text for these values, under its header line. */
export function localsYaml(values: Record<string, string>): string {
  return Object.keys(values).length ? HEAD + dump(values, { lineWidth: -1 }) : HEAD
}

/**
 * A workflow's locals for a run: the person's value, else the declared default,
 * else missing. A folder or file local's leading ~ becomes the home folder.
 */
export function resolveLocals(wf: Pick<Workflow, 'locals'>, stored: Record<string, string>, home: string): { values: Record<string, string>; missing: LocalSpec[] } {
  const values: Record<string, string> = {}
  const missing: LocalSpec[] = []
  for (const spec of wf.locals ?? []) {
    const mine = (stored[spec.id] ?? '').trim()
    const raw = mine || spec.default.trim()
    if (!raw) {
      missing.push(spec)
      continue
    }
    values[spec.id] = spec.type === 'text' ? raw : expand(raw, home)
  }
  return { values, missing }
}

/** Every local the loaded workflows declare, by id: the first declaration's label, type, help and default, and which workflows use it. */
export function declaredLocals(found: Found[]): { spec: LocalSpec; usedBy: string[] }[] {
  const byId = new Map<string, { spec: LocalSpec; usedBy: string[] }>()
  for (const f of found)
    for (const spec of f.workflow?.locals ?? []) {
      const known = byId.get(spec.id)
      if (!known) byId.set(spec.id, { spec, usedBy: [f.id] })
      else if (!known.usedBy.includes(f.id)) known.usedBy.push(f.id)
    }
  return [...byId.values()]
}

async function homeOf($: $): Promise<string> {
  return ((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
}

/** The person's locals from ~/.flow/locals.yaml; {} when the file is missing or unreadable. */
export async function readLocals($: $): Promise<Record<string, string>> {
  const file = `${await homeOf($)}/${LOCALS_FILE}`
  try {
    if (!(await $.fs.exists(file))) return {}
    return parseLocalsFile(await $.fs.read(file))
  } catch {
    return {}
  }
}

/** Sets one local in ~/.flow/locals.yaml (an empty value removes it); returns all of them after. */
export async function setLocal($: $, id: string, value: string): Promise<Record<string, string>> {
  if (!LOCAL_ID_RE.test(id)) throw new Error(`"${id}" is not a local id (snake_case: lowercase letters, digits or _, starting with a letter)`)
  const values = await readLocals($)
  const v = value.trim()
  if (v) values[id] = v
  else delete values[id]
  await $.fs.write(`${await homeOf($)}/${LOCALS_FILE}`, localsYaml(values))
  return values
}
