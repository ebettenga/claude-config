// Team sync: the flows folder and each git source, kept in step with GitLab.
// A background fetch every 5 minutes keeps each repo's status current; Pull
// rebases onto the team's work; Share commits the person's changes, pushes them
// to a new branch and opens a merge request that merges on its own, so nobody
// handles branches by hand. Nothing here imports the runner, so the runner can
// import this: it hands over its flows folder, and reloads the workflows after
// a pull (pullSources, the tools' hooks, startSync's onPulled).

import { atom, update } from 'claude-code'
import type { EngineInterface, Timer } from 'claude-code'

import type { PendingShare, RepoSync, ShareProblem, SyncChange, SyncRepo } from '../types'
import { LAYOUT_FILE, parseLayout, parseSources } from './layout'
import { parseWorkflow } from './spec'
import { VIEW_FILE, parseView } from './views'

type $ = EngineInterface

/** Each synced repo's last status, by repo name: what the hub draws without running git. */
export const syncAtom = atom({ plugin: 'flow', key: 'sync' } as const, {} as Record<string, RepoSync>, { shape: 'sync-1' })

const FETCH_MS = 5 * 60_000
/** The first fetch waits this long after a session starts, so the start is not held up. */
const FIRST_FETCH_MS = 1_000
const FETCH_TIMEOUT_MS = 30_000
const PUSH_TIMEOUT_MS = 120_000
/** Files bigger than this are not scanned for paths and secrets. */
const SCAN_MAX = 1_000_000
const TITLE_MAX = 200
const SHARE_FOOTER = 'Shared from the flow hub.'
const PENDING_KEY = (name: string) => `pendingShares:${name}`
/** A pending Share older than this is dropped: without GitLab credentials a closed merge request cannot be told apart. */
const PENDING_MAX_MS = 14 * 86_400_000
/** status --porcelain codes of a file with unresolved conflicts. */
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])
const NO_DEFAULT_BRANCH = 'cannot tell the default branch: origin/HEAD is not set and there is no origin/main or origin/master (git remote set-head origin --auto sets it)'

const PERSONAL_PATH_RE = /\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\//
const SECRET_RES = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /xox[baprs]-[0-9A-Za-z-]{10,}/,
  /glpat-[0-9A-Za-z_-]{20}/,
  /sk-ant-[0-9A-Za-z_-]{20,}/,
  /gh[pousr]_[0-9A-Za-z]{30,}/,
  /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"{}$\s]{12,}['"]/i,
]
export const PERSONAL_PATH_PROBLEM = 'hard-coded personal path: use a local ({{local.<id>}}) instead'
export const SECRET_PROBLEM = 'looks like a secret: list it under env: and use {{env.NAME}}'

// Module state. configureSync clears it on every (re)load.
let flowsDir = '~/Documents/flows'
/** The 5-minute fetch: one at a time, or each session.start (a /clear, a resume) would add another. */
let fetchTimer: Timer | undefined
let firstTimer: Timer | undefined
let isCycling = false
/** The last failed fetch and pull of each repo, by name; cleared when one works. */
const fetchErrors = new Map<string, string>()
const pullErrors = new Map<string, string>()
/** Repos `git remote set-head origin --auto` already ran in this load. */
const headTried = new Set<string>()

const errText = (err: unknown) => String((err as Error)?.message ?? err).split('\n')[0] ?? 'error'
const pad2 = (n: number) => String(n).padStart(2, '0')

async function home($: $): Promise<string> {
  return ((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
}

const expand = (path: string, homeDir: string) => (path === '~' ? homeDir : path.startsWith('~/') ? `${homeDir}${path.slice(1)}` : path)

type GitResult = { ok: boolean; stdout: string; stderr: string; error?: string }

/** The last line of git's output that says something (hints left out). */
function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^hint:/i.test(l))
  return lines.at(-1) ?? ''
}

/** git in a repo, never prompting; a failure's error is its last stderr line. */
async function gitRun($: $, cwd: string, argv: string[], timeoutMs = 60_000): Promise<GitResult> {
  try {
    const r = await $.process.run(['git', ...argv], { cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: '0' } })
    if (r.exitCode === 0) return { ok: true, stdout: r.stdout, stderr: r.stderr }
    return { ok: false, stdout: r.stdout, stderr: r.stderr, error: lastLine(r.stderr) || lastLine(r.stdout) || `git ${argv[0]} exited ${r.exitCode}` }
  } catch (err) {
    return { ok: false, stdout: '', stderr: '', error: errText(err) }
  }
}

// ---------------------------------------------------------------------------
// The repos and their status

/** The repos to sync: the flows folder when it is a git work tree's root, then each source that is a git repo. */
export async function syncRepos($: $): Promise<SyncRepo[]> {
  const homeDir = await home($)
  const base = expand(flowsDir, homeDir).replace(/\/+$/, '')
  const repos: SyncRepo[] = []
  const isRepo = (path: string) => $.fs.exists(`${path}/.git`).catch(() => false)
  if (base && (await isRepo(base))) repos.push({ name: 'local', title: base.split('/').pop() || base, path: base, isSource: false })
  const layoutFile = `${base}/${LAYOUT_FILE}`
  const text = (await $.fs.exists(layoutFile).catch(() => false)) ? await $.fs.read(layoutFile).catch(() => '') : ''
  for (const src of parseSources(text, homeDir).sources) {
    if (repos.some(r => r.path === src.path)) continue
    if (await isRepo(src.path)) repos.push({ name: src.name, title: src.title, path: src.path, isSource: true })
  }
  return repos
}

/** `git status --porcelain=v1 -z` read into changes; a rename's old path is skipped. */
export function parsePorcelain(z: string): SyncChange[] {
  const parts = z.split('\0')
  const changes: SyncChange[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? ''
    if (entry.length < 4) continue
    const [x, y] = [entry[0], entry[1]]
    const path = entry.slice(3)
    let kind: SyncChange['kind']
    if (x === '!') continue
    if (x === '?') kind = 'untracked'
    else if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      kind = x === 'C' || y === 'C' ? 'added' : 'renamed'
      i++ // the path it came from
    } else if (x === 'D' || y === 'D') kind = 'deleted'
    else if (x === 'A') kind = 'added'
    else kind = 'modified'
    changes.push({ path, kind, item: path.split('/')[0] ?? path })
  }
  return changes
}

/** The files `git status --porcelain=v1 -z` shows with unresolved conflicts. */
export function unmergedPaths(z: string): string[] {
  const parts = z.split('\0')
  const paths: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? ''
    if (entry.length < 4) continue
    if (/[RC]/.test(entry.slice(0, 2))) i++
    if (UNMERGED.has(entry.slice(0, 2))) paths.push(entry.slice(3))
  }
  return paths
}

async function pendingOf($: $, name: string): Promise<PendingShare[]> {
  const raw = await $.store.get(PENDING_KEY(name)).catch(() => undefined)
  return Array.isArray(raw) ? (raw as PendingShare[]) : []
}

/** Whether a shared commit has reached the default branch: merged, fast-forwarded, or the same patch squashed. */
async function isMerged($: $, repo: SyncRepo, commit: string, defaultBranch: string): Promise<boolean> {
  const upstream = `refs/remotes/origin/${defaultBranch}`
  if ((await gitRun($, repo.path, ['merge-base', '--is-ancestor', commit, upstream])).ok) return true
  const cherry = await gitRun($, repo.path, ['cherry', upstream, commit, `${commit}~1`])
  return cherry.ok && cherry.stdout.trim().startsWith('-')
}

/**
 * The repo's pending Shares, less those whose commit is now upstream and those
 * older than 14 days (the store is updated). Without a known default branch
 * only the age counts.
 */
async function prunePending($: $, repo: SyncRepo, defaultBranch: string | undefined): Promise<PendingShare[]> {
  const pending = await pendingOf($, repo.name)
  if (!pending.length) return pending
  const now = await $.clock.now()
  const kept: PendingShare[] = []
  for (const p of pending) {
    if (!(now - p.at <= PENDING_MAX_MS)) continue
    if (defaultBranch && (await isMerged($, repo, p.commit, defaultBranch))) continue
    kept.push(p)
  }
  if (kept.length !== pending.length) await $.store.set(PENDING_KEY(repo.name), kept).catch(() => undefined)
  return kept
}

/** The branch origin/HEAD points at, or '' when it is unset. */
async function originHead($: $, repo: SyncRepo): Promise<string> {
  const r = await gitRun($, repo.path, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
  return r.ok ? r.stdout.trim().replace(/^refs\/remotes\/origin\//, '') : ''
}

/** origin/HEAD's branch; else origin/main, else origin/master; else none (undefined). */
async function defaultBranchOf($: $, repo: SyncRepo): Promise<string | undefined> {
  const head = await originHead($, repo)
  if (head) return head
  for (const name of ['main', 'master']) if ((await gitRun($, repo.path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`])).ok) return name
  return undefined
}

/** A repo's branch, its default branch, how far behind and ahead it is, its changes and pending Shares. */
export async function repoStatus($: $, repo: SyncRepo): Promise<RepoSync> {
  const checkedAt = await $.clock.now()
  const status = await gitRun($, repo.path, ['status', '--porcelain=v1', '-uall', '-z'])
  const head = await gitRun($, repo.path, ['branch', '--show-current'])
  const defaultBranch = await defaultBranchOf($, repo)
  const counts = await gitRun($, repo.path, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])
  const [ahead = 0, behind = 0] = counts.ok ? counts.stdout.trim().split(/\s+/).map(n => Number(n) || 0) : []
  const pending = await prunePending($, repo, defaultBranch)
  const error = !status.ok ? status.error : !defaultBranch ? NO_DEFAULT_BRANCH : (pullErrors.get(repo.name) ?? fetchErrors.get(repo.name))
  return {
    repo,
    branch: head.ok ? head.stdout.trim() : '',
    defaultBranch: defaultBranch ?? 'main',
    isDefaultBranchKnown: Boolean(defaultBranch),
    behind,
    ahead,
    changes: status.ok ? parsePorcelain(status.stdout) : [],
    pending,
    ...(error ? { error } : {}),
    checkedAt,
  }
}

/** Checks one repo again and keeps its status in `sync`. */
async function refreshRepo($: $, repo: SyncRepo): Promise<RepoSync> {
  const s = await repoStatus($, repo)
  await update($, syncAtom, all => ({ ...all, [repo.name]: s }))
  return s
}

/** Checks every repo again (no fetch) and keeps their status in `sync`. */
export async function refreshSync($: $): Promise<Record<string, RepoSync>> {
  const all: Record<string, RepoSync> = {}
  for (const repo of await syncRepos($)) all[repo.name] = await repoStatus($, repo)
  await update($, syncAtom, () => all)
  return all
}

// ---------------------------------------------------------------------------
// Pull

/** Whether a rebase is under way, wherever the git dir is (a worktree's is not <repo>/.git). */
async function isRebasing($: $, path: string): Promise<boolean> {
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    const r = await gitRun($, path, ['rev-parse', '--git-path', dir])
    const at = r.ok ? r.stdout.trim() : ''
    if (at && (await $.fs.exists(at.startsWith('/') ? at : `${path}/${at}`).catch(() => false))) return true
  }
  return false
}

/** The files left with conflicts, said as an error; undefined when there are none. */
async function conflictsOf($: $, path: string): Promise<string | undefined> {
  const r = await gitRun($, path, ['status', '--porcelain=v1', '-z'])
  const files = r.ok ? unmergedPaths(r.stdout) : []
  return files.length ? `conflicts in ${files.join(', ')}: resolve them or ask Claude` : undefined
}

/**
 * `git pull --rebase --autostash`; on a conflict the rebase is aborted and the
 * repo left as it was. Files still in conflict after (the autostash put back
 * onto the team's changes) are named in the error.
 */
async function pullOnly($: $, repo: SyncRepo): Promise<string | undefined> {
  const r = await gitRun($, repo.path, ['pull', '--rebase', '--autostash', '--quiet'])
  if (!r.ok) {
    if (await isRebasing($, repo.path)) await gitRun($, repo.path, ['rebase', '--abort'])
    return (await conflictsOf($, repo.path)) ?? r.error
  }
  const said = `${r.stderr}\n${r.stdout}`
  if (!/conflict/i.test(said)) return undefined
  return (await conflictsOf($, repo.path)) ?? (/autostash resulted in conflicts/i.test(said) ? 'pulled, but your own changes conflict with it: they are kept in git stash' : undefined)
}

/**
 * Pulls a repo onto the team's work (rebasing, so a Share's commit drops away
 * once its merge request merged), then checks its status again unless
 * `refresh` is false. Returns the error when it failed. The caller reloads
 * the workflows after (runner's pullSources does).
 */
export async function pullRepo($: $, repo: SyncRepo, options: { refresh?: boolean } = {}): Promise<{ error?: string }> {
  const error = await pullOnly($, repo)
  if (error) pullErrors.set(repo.name, error)
  else pullErrors.delete(repo.name)
  if (options.refresh !== false) await refreshRepo($, repo).catch(() => undefined)
  return error ? { error } : {}
}

// ---------------------------------------------------------------------------
// Guardrails

/** Personal paths and secrets in one file's text, by line. */
export function scanText(path: string, text: string): ShareProblem[] {
  const problems: ShareProblem[] = []
  text.split('\n').forEach((line, i) => {
    const isComment = /^\s*#/.test(line)
    if (!isComment && PERSONAL_PATH_RE.test(line)) problems.push({ path, line: i + 1, problem: PERSONAL_PATH_PROBLEM })
    if (SECRET_RES.some(re => re.test(line))) problems.push({ path, line: i + 1, problem: SECRET_PROBLEM })
  })
  return problems
}

/**
 * What would stop a Share: a changed workflow's flow.yaml, a view.yaml or
 * flows.yaml that does not parse, and hard-coded personal paths or secrets in
 * the changed text files (over 1 MB skipped).
 */
export async function shareProblems($: $, repo: SyncRepo, status: Pick<RepoSync, 'changes'>): Promise<ShareProblem[]> {
  const problems: ShareProblem[] = []
  const read = async (rel: string): Promise<string | undefined> => {
    const file = `${repo.path}/${rel}`
    if (!(await $.fs.exists(file).catch(() => false))) return undefined
    const stat = await $.fs.stat(file).catch(() => undefined)
    if (stat && (stat.kind !== 'file' || stat.size > SCAN_MAX)) return undefined
    const text = await $.fs.read(file).catch(() => undefined)
    return text === undefined || text.includes('\0') ? undefined : text
  }
  const folders = new Set<string>()
  let isLayoutChanged = false
  for (const c of status.changes) {
    if (c.path.includes('/')) folders.add(c.item)
    else if (c.path === LAYOUT_FILE && c.kind !== 'deleted') isLayoutChanged = true
  }
  for (const item of [...folders].sort()) {
    const dir = `${repo.path}/${item}`
    for (const [name, parse] of [
      ['flow.yaml', parseWorkflow],
      [VIEW_FILE, parseView],
    ] as const) {
      const text = await read(`${item}/${name}`)
      if (text === undefined) continue
      let errors: string[]
      try {
        errors = parse(text, dir, `${dir}/${name}`).errors
      } catch (err) {
        errors = [errText(err)]
      }
      for (const problem of errors) problems.push({ path: `${item}/${name}`, problem })
    }
  }
  if (isLayoutChanged) {
    const text = (await read(LAYOUT_FILE)) ?? ''
    for (const problem of [...parseLayout(text).errors, ...parseSources(text, await home($)).errors]) problems.push({ path: LAYOUT_FILE, problem })
  }
  for (const c of status.changes) {
    if (c.kind === 'deleted') continue
    const text = await read(c.path)
    if (text !== undefined) problems.push(...scanText(c.path, text))
  }
  return problems
}

// ---------------------------------------------------------------------------
// Share

/** user.name as a branch-safe slug. */
export function nameSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'someone'
}

const stamp = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

/** The merge request title: the message's first line, one line, at most 200 characters. */
const titleOf = (message: string) => (message.split('\n').find(l => l.trim()) ?? '').trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX)

export type ShareResult = { url?: string; branch: string; error?: string; note?: string; problems?: ShareProblem[] }

/**
 * Shares a repo's changes: commits them on the default branch here, pushes
 * that commit to a new flow-share/<name>/<time> branch and has GitLab open a
 * merge request that merges itself once its pipeline passes. Never pushes to
 * the default branch. A failed push puts the changes back as uncommitted.
 * `checked` is a status just taken, so git status is not run twice.
 */
export async function shareRepo($: $, repo: SyncRepo, message: string, checked?: RepoSync): Promise<ShareResult> {
  const text = message.trim()
  if (!text) return { branch: '', error: 'write a message saying what changed' }
  const status = checked ?? (await repoStatus($, repo))
  if (status.error && !status.branch) return { branch: '', error: status.error }
  if (!status.isDefaultBranchKnown) return { branch: '', error: NO_DEFAULT_BRANCH }
  if (!status.changes.length) return { branch: '', error: `nothing to share: ${repo.title} has no changes` }
  if (status.branch !== status.defaultBranch)
    return { branch: '', error: `Share works from ${status.defaultBranch}, and ${repo.title} is on ${status.branch || 'a detached HEAD'}: switch back to ${status.defaultBranch} first` }
  const remote = await gitRun($, repo.path, ['remote', 'get-url', 'origin'])
  if (!remote.ok || !/gitlab/i.test(remote.stdout))
    return { branch: '', error: `Share needs a GitLab remote: origin is ${remote.ok ? remote.stdout.trim() || 'not set' : 'not set'}` }
  const problems = await shareProblems($, repo, status)
  if (problems.length) return { branch: '', error: `${problems.length} problem${problems.length === 1 ? '' : 's'} to fix first`, problems }

  const pulled = await pullOnly($, repo)
  if (pulled) {
    pullErrors.set(repo.name, pulled)
    await refreshRepo($, repo).catch(() => undefined)
    return { branch: '', error: `could not pull the team's changes first: ${pulled}` }
  }
  pullErrors.delete(repo.name)
  const added = await gitRun($, repo.path, ['add', '-A'])
  if (!added.ok) return { branch: '', error: `git add failed: ${added.error}` }
  const committed = await gitRun($, repo.path, ['commit', '--quiet', '-m', `${text}\n\n${SHARE_FOOTER}`])
  if (!committed.ok) return { branch: '', error: `git commit failed: ${committed.error}` }
  const commit = (await gitRun($, repo.path, ['rev-parse', 'HEAD'])).stdout.trim()
  const user = (await gitRun($, repo.path, ['config', 'user.name'])).stdout.trim()
  const branch = `flow-share/${nameSlug(user)}/${stamp(await $.clock.now())}`
  const push = await gitRun(
    $,
    repo.path,
    [
      'push',
      '-o', 'merge_request.create',
      '-o', `merge_request.target=${status.defaultBranch}`,
      '-o', 'merge_request.merge_when_pipeline_succeeds',
      '-o', 'merge_request.remove_source_branch',
      '-o', `merge_request.title=${titleOf(text)}`,
      'origin',
      `HEAD:refs/heads/${branch}`,
    ],
    PUSH_TIMEOUT_MS,
  )
  if (!push.ok) {
    const undo = await gitRun($, repo.path, ['reset', '--soft', 'HEAD~1'])
    await refreshRepo($, repo).catch(() => undefined)
    const back = undo.ok ? 'your changes are back as they were' : `and undoing the local commit failed too (${undo.error}): run git reset --soft HEAD~1`
    return { branch, error: `push failed: ${push.error}; ${back}` }
  }
  const out = `${push.stderr}\n${push.stdout}`
  const url = /https?:\/\/\S+\/merge_requests\/\d+/.exec(out)?.[0]
  const isAutoMergeRefused = out.split('\n').some(l => /merge.when.pipeline|auto.?merge/i.test(l) && /could not|couldn't|unable|cannot|can't|not allowed|failed|error|invalid/i.test(l))
  const note = !url
    ? 'pushed, but GitLab did not answer with a merge request link: open the branch on GitLab to check it'
    : isAutoMergeRefused
      ? 'the merge request is open, but GitLab did not set it to merge on its own: open it and merge it there'
      : undefined
  const pending: PendingShare = { branch, commit, ...(url ? { url } : {}), message: text, at: await $.clock.now() }
  await $.store.set(PENDING_KEY(repo.name), [...(await pendingOf($, repo.name)), pending]).catch(() => undefined)
  await refreshRepo($, repo).catch(() => undefined)
  return { branch, ...(url ? { url } : {}), ...(note ? { note } : {}) }
}

// ---------------------------------------------------------------------------
// The background fetch

/**
 * Fetches every repo, then checks them again; the first one after a session
 * starts also pulls what is behind. True when it pulled something.
 */
export async function syncCycle($: $, isFirst: boolean): Promise<boolean> {
  if (isCycling) return false
  isCycling = true
  try {
    const repos = await syncRepos($)
    for (const repo of repos) {
      const r = await gitRun($, repo.path, ['fetch', '--quiet', '--prune'], FETCH_TIMEOUT_MS)
      if (r.ok) fetchErrors.delete(repo.name)
      else fetchErrors.set(repo.name, `could not fetch: ${r.error}`)
      // Many clones have no origin/HEAD: ask the remote once, after a fetch that worked.
      if (r.ok && !headTried.has(repo.path) && !(await originHead($, repo))) {
        headTried.add(repo.path)
        await gitRun($, repo.path, ['remote', 'set-head', 'origin', '--auto'], FETCH_TIMEOUT_MS)
      }
    }
    const all = await refreshSync($)
    if (!isFirst) return false
    let isPulled = false
    for (const repo of repos) {
      const s = all[repo.name]
      // Never on another branch: that one is the person's to handle.
      if (!s || s.error || !s.branch || s.branch !== s.defaultBranch || s.behind <= 0) continue
      await pullRepo($, repo, { refresh: false })
      isPulled = true
    }
    if (isPulled) await refreshSync($)
    return isPulled
  } finally {
    isCycling = false
  }
}

/**
 * Starts the background fetch: once shortly after the session starts (with an
 * auto-pull, then `onPulled` when it pulled), then every 5 minutes. The last
 * start's timers are cancelled first.
 */
export function startSync($: $, onPulled: () => Promise<unknown>): void {
  firstTimer?.cancel()
  fetchTimer?.cancel()
  const first = () => syncCycle($, true).then(isPulled => (isPulled ? onPulled() : undefined))
  try {
    firstTimer = $.clock.after(FIRST_FETCH_MS, () => void first().catch(() => undefined))
    fetchTimer = $.clock.every(FETCH_MS, () => void syncCycle($, false).catch(() => undefined))
  } catch {
    // No timer here (a test kit): status is checked when asked.
  }
}

// ---------------------------------------------------------------------------
// Tools

/** sync_status's answer, JSON: each repo checked now, its changes grouped by workflow or view. */
export async function syncStatusText($: $): Promise<string> {
  const all = await refreshSync($)
  const repos = Object.values(all).map(s => {
    const changes: Record<string, string[]> = {}
    for (const c of s.changes) (changes[c.item] ??= []).push(`${c.kind} ${c.path}`)
    return {
      repo: s.repo.name,
      title: s.repo.title,
      path: s.repo.path,
      branch: s.branch,
      defaultBranch: s.defaultBranch,
      behind: s.behind,
      ahead: s.ahead,
      changes,
      pending: s.pending.map(p => ({ message: p.message, branch: p.branch, ...(p.url ? { url: p.url } : {}), at: new Date(p.at).toISOString() })),
      ...(s.error ? { error: s.error } : {}),
    }
  })
  return repos.length ? JSON.stringify(repos, null, 2) : `no git repos to sync: ${flowsDir} is not a git repo and no source in its flows.yaml is one`
}

/** Registers sync_status, pull_changes and share_changes (each session start, beside the runner's tools). */
export async function registerSyncTools($: $): Promise<void> {
  await $.tool.register({
    name: 'sync_status',
    description:
      'The team sync state of the flow workflows: the flows folder (when it is a git repo) and each git source in flows.yaml. For each repo: its branch and default branch, how many commits it is behind and ahead of GitLab (as of the last background fetch, every 5 minutes), ' +
      'its uncommitted changes grouped by workflow or view, its Shares whose merge requests have not merged yet, and the last error. Returns JSON. Use it when the user asks what changed, what is not shared yet, or whether they are up to date.',
    inputSchema: { type: 'object', properties: {} },
  })
  await $.tool.register({
    name: 'pull_changes',
    description:
      "Pull the team's latest workflows into the flows folder and every git source (git pull --rebase --autostash, so the user's own edits are kept; missing sources are cloned), then reload the workflow list. " +
      'Returns one line per repo: pulled, cloned, or why it failed (a conflict leaves the repo as it was). Use it when the user asks to update, pull or sync their workflows.',
    inputSchema: { type: 'object', properties: {} },
  })
  await $.tool.register({
    name: 'share_changes',
    description:
      "Share the user's workflow changes with the team: commits everything changed in one repo (the flows folder, repo \"local\", or a source by name), pushes it to a new flow-share/<name>/<time> branch and opens a GitLab merge request that merges on its own once its pipeline passes. " +
      'It never pushes to the default branch directly. It first checks the changes: every changed flow.yaml, view.yaml and flows.yaml must parse, and no file may hold a hard-coded /Users/<name>/ path or a secret; when one does it returns those problems and shares nothing. ' +
      'Returns the merge request URL. Only when the user asks to share, publish or send their workflow changes.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'The repo to share (sync_status names them); default the one repo with changes.' },
        message: { type: 'string', description: 'What changed, in one line: the commit message and the merge request title.' },
      },
      required: ['message'],
    },
  })
}

/** share_changes's answer: the repo named, or the one repo with changes, shared; or why not. */
export async function shareText($: $, name: string, message: string): Promise<string> {
  const repos = await syncRepos($)
  let repo = name ? repos.find(r => r.name === name || r.title === name) : undefined
  if (name && !repo) return `Not shared: no repo "${name}" (${repos.map(r => r.name).join(', ') || 'no git repos found'})`
  let checked: RepoSync | undefined
  if (!repo) {
    const all = await refreshSync($)
    const changed = repos.filter(r => all[r.name]?.changes.length)
    if (!changed.length) return 'Not shared: nothing to share, no repo has changes'
    if (changed.length > 1) return `Not shared: ${changed.length} repos have changes: name one with repo (${changed.map(r => r.name).join(', ')})`
    repo = changed[0]
    checked = repo ? all[repo.name] : undefined
  }
  if (!repo) return 'Not shared: no repo'
  const r = await shareRepo($, repo, message, checked)
  if (r.problems?.length) return [`Not shared: fix these first, then share again:`, ...r.problems.map(p => `- ${p.path}${p.line ? `:${p.line}` : ''}: ${p.problem}`)].join('\n')
  if (r.error) return `Not shared: ${r.error}`
  return [`Shared ${repo.title} to branch ${r.branch}.`, r.url ? `Merge request: ${r.url}` : '', r.note ? `Note: ${r.note}` : ''].filter(Boolean).join('\n')
}

/** Takes the runner's flows folder and clears what the last load kept (its timers included). */
export function configureSync(workflowsDir: string): void {
  firstTimer?.cancel()
  fetchTimer?.cancel()
  firstTimer = undefined
  fetchTimer = undefined
  isCycling = false
  fetchErrors.clear()
  pullErrors.clear()
  headTried.clear()
  flowsDir = workflowsDir
}
