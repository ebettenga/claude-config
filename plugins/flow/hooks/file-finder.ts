// Files to suggest for a file input, so nobody has to click through folders:
// what earlier runs produced, what Spotlight finds on this Mac, and what was
// picked for the same input before.

import type { EngineInterface } from 'claude-code'

export type SuggestedFile = {
  path: string
  /** A folder (a folder input's suggestion), not a file. */
  isDir?: boolean
  mtimeMs: number
  /** Where it came from: an earlier run's output, a Spotlight hit, a past pick. */
  source: 'run' | 'mac' | 'picked'
  /** For a run's output: the workflow and run it came from. */
  label?: string
}

// Folders whose files are rarely what a person means: package caches,
// virtual environments, build output, test fixtures, app support data.
const NOISE =
  /\/(Library|node_modules|site-packages|dist-packages|\.?venv|myenv|env|\.git|\.cache|build|dist|\.Trash|__pycache__|tests?\/data|fixtures)\//i
const HIDDEN = /\/\.[^/]+\//
const CACHE_MS = 30_000
const MAX_STAT = 300

const cache = new Map<string, { at: number; files: SuggestedFile[] }>()

const matches = (path: string, accept: string[], query: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (accept.length && !accept.some(a => name.endsWith(a.toLowerCase()))) return false
  return !query || name.includes(query.toLowerCase())
}

// A Spotlight query value can't hold quotes, backslashes or wildcards of its own.
const safe = (s: string) => s.replace(/["\\*]/g, '').trim()

/** Spotlight hits under home for the accepted extensions (and the search text), newest first. */
export async function findOnMac($: EngineInterface, home: string, accept: string[], query: string, limit = 25): Promise<SuggestedFile[]> {
  const q = safe(query)
  const exts = accept.map(a => safe(a).replace(/^\./, '')).filter(Boolean)
  if (!home || (!exts.length && !q)) return []
  const key = `${home}|${exts.join(',')}|${q}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.files.slice(0, limit)

  const byExt = exts.map(e => `kMDItemFSName == "*.${e}"c`).join(' || ')
  const byName = q ? `kMDItemFSName == "*${q}*"c` : ''
  const expr = [byExt && `(${byExt})`, byName].filter(Boolean).join(' && ')
  const found = await $.process.run(['mdfind', '-onlyin', home, expr], { timeoutMs: 8000 }).catch(() => undefined)
  const paths = (found?.exitCode === 0 ? found.stdout.split('\n') : [])
    .map(p => p.trim())
    .filter(p => p && !NOISE.test(p) && !HIDDEN.test(p.slice(home.length)))
    .slice(0, MAX_STAT)

  const stats = await Promise.all(paths.map(p => $.fs.stat(p).catch(() => undefined)))
  const files = paths
    .map((path, i) => ({ path, mtimeMs: stats[i]?.kind === 'file' ? stats[i]?.mtimeMs ?? 0 : -1, source: 'mac' as const }))
    .filter(f => f.mtimeMs >= 0)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  cache.set(key, { at: Date.now(), files })
  return files.slice(0, limit)
}

/** Files the newest runs left in their folders that fit the input, newest first. */
export async function recentRunFiles($: EngineInterface, home: string, accept: string[], query: string, limit = 15): Promise<SuggestedFile[]> {
  if (!home) return []
  const root = `${home}/.flow/runs`
  const workflows = (await $.fs.list(root).catch(() => [])).filter(e => e.kind === 'dir')
  const runs: { workflow: string; id: string; dir: string; mtimeMs: number }[] = []
  for (const wf of workflows) {
    const dir = `${root}/${wf.name}`
    for (const run of (await $.fs.list(dir).catch(() => [])).filter(e => e.kind === 'dir'))
      runs.push({ workflow: wf.name, id: run.name, dir: `${dir}/${run.name}`, mtimeMs: run.mtimeMs })
  }
  runs.sort((a, b) => b.id.localeCompare(a.id))
  const files: SuggestedFile[] = []
  for (const run of runs.slice(0, 30)) {
    for (const e of await $.fs.list(run.dir).catch(() => [])) {
      if (e.kind !== 'file' || e.name.startsWith('.') || e.name === 'run.json' || e.name === 'workflow.json' || e.name.endsWith('.log')) continue
      const path = `${run.dir}/${e.name}`
      if (matches(path, accept, query)) files.push({ path, mtimeMs: e.mtimeMs, source: 'run', label: `${run.workflow} · ${run.id}` })
    }
    if (files.length >= limit) break
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
}

/**
 * Folders under home that hold every `contains` path (package.json, server/package.json…),
 * found by Spotlight from the first one, newest first. A project is named by its folder.
 */
export async function findFolders($: EngineInterface, home: string, contains: string[], query: string, limit = 25): Promise<SuggestedFile[]> {
  const [first, ...rest] = contains
  if (!home || !first) return []
  const leaf = safe(first.slice(first.lastIndexOf('/') + 1))
  const q = safe(query).toLowerCase()
  const key = `dirs|${home}|${contains.join(',')}|${q}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.files.slice(0, limit)

  const found = await $.process.run(['mdfind', '-onlyin', home, `kMDItemFSName == "${leaf}"`], { timeoutMs: 8000 }).catch(() => undefined)
  const suffix = `/${first}`
  const dirs = [...new Set((found?.exitCode === 0 ? found.stdout.split('\n') : [])
    .map(p => p.trim())
    .filter(p => p.endsWith(suffix) && !NOISE.test(p) && !HIDDEN.test(p.slice(home.length)))
    .map(p => p.slice(0, -suffix.length)))]
    .filter(d => !q || d.slice(d.lastIndexOf('/') + 1).toLowerCase().includes(q) || d.toLowerCase().includes(q))
    .slice(0, MAX_STAT)

  const checked = await Promise.all(dirs.map(async dir => {
    for (const rel of rest) if (!(await $.fs.exists(`${dir}/${rel}`).catch(() => false))) return undefined
    const st = await $.fs.stat(`${dir}/${first}`).catch(() => undefined)
    return st ? { path: dir, isDir: true, mtimeMs: st.mtimeMs, source: 'mac' as const } : undefined
  }))
  const files = checked.filter((x): x is NonNullable<typeof x> => Boolean(x)).sort((a, b) => b.mtimeMs - a.mtimeMs)
  cache.set(key, { at: Date.now(), files })
  return files.slice(0, limit)
}

const picksKey = (workflowId: string, inputId: string) => `picks:${workflowId}:${inputId}`

/** What was picked for this input before, most recent first, still on disk. */
export async function pastPicks($: EngineInterface, workflowId: string, inputId: string, accept: string[], query: string, isDir = false): Promise<SuggestedFile[]> {
  const stored = await $.store.get(picksKey(workflowId, inputId)).catch(() => undefined)
  const paths = Array.isArray(stored) ? stored.filter((p): p is string => typeof p === 'string') : []
  const stats = await Promise.all(paths.map(p => $.fs.stat(p).catch(() => undefined)))
  return paths
    .map((path, i) => ({ path, isDir, mtimeMs: stats[i]?.mtimeMs ?? 0, source: 'picked' as const, isThere: stats[i]?.kind === (isDir ? 'dir' : 'file') }))
    .filter(f => f.isThere && (isDir ? !query || f.path.toLowerCase().includes(query.toLowerCase()) : matches(f.path, accept, query)))
    .map(({ isThere: _, ...f }) => f)
}

/** Remembers a pick for next time (8 per input, newest first). */
export async function rememberPick($: EngineInterface, workflowId: string, inputId: string, path: string): Promise<void> {
  const key = picksKey(workflowId, inputId)
  const stored = await $.store.get(key).catch(() => undefined)
  const prior = Array.isArray(stored) ? stored.filter((p): p is string => typeof p === 'string' && p !== path) : []
  await $.store.set(key, [path, ...prior].slice(0, 8)).catch(() => undefined)
}
