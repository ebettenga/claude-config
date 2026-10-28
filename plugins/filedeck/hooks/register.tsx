import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register, RenderChildren } from 'claude-code'

import type { GitFile, GitSnap, PreviewMode, SelectionSite, Tab, Touch } from '../types'
import { BY_EXTENSION, BY_FILE_NAME, BY_FOLDER_NAME, ICON_FILE, ICON_FOLDER, SVG } from './icons'

const PANE = 'filedeck'
const MAX_ROWS = 400
const MAX_MATCHES = 60

const EMPTY_GIT: GitSnap = { isRepo: false, root: '', branch: '', upstream: '', ahead: 0, behind: 0, files: [], ignored: [], at: 0 }

// Expanded folders are absolute paths; the tag moved when they stopped being relative.
const expanded = atom({ plugin: 'filedeck', key: 'expanded' } as const, [] as string[], { shape: 'expanded-2' })
const touched = atom({ plugin: 'filedeck', key: 'touched' } as const, [] as Touch[], { shape: 'touched-1' })
const git = atom({ plugin: 'filedeck', key: 'git' } as const, EMPTY_GIT, { shape: 'git-1' })
const busy = atom({ plugin: 'filedeck', key: 'busy' } as const, '', { shape: 'busy-1' })
const note = atom({ plugin: 'filedeck', key: 'note' } as const, '', { shape: 'note-1' })
const showHidden = atom({ plugin: 'filedeck', key: 'showHidden' } as const, false, { shape: 'hidden-1' })
const showSizes = atom({ plugin: 'filedeck', key: 'showSizes' } as const, false, { shape: 'sizes-1' })
const tab = atom({ plugin: 'filedeck', key: 'tab' } as const, 'files' as Tab, { shape: 'tab-1' })
const tick = atom({ plugin: 'filedeck', key: 'tick' } as const, 0, { shape: 'tick-1' })
const query = atom({ plugin: 'filedeck', key: 'query' } as const, '', { shape: 'query-1' })
const selection = atom({ plugin: 'filedeck', key: 'selection' } as const, '', { shape: 'selection-1' })
// Where the open file's viewer sits: under its row in the tree, or in the Claude touched card.
const selectionSite = atom({ plugin: 'filedeck', key: 'selectionSite' } as const, 'tree' as SelectionSite, { shape: 'site-1' })
const previewMode = atom({ plugin: 'filedeck', key: 'previewMode' } as const, 'diff' as PreviewMode, { shape: 'mode-1' })
const viewRoot = atom({ plugin: 'filedeck', key: 'viewRoot' } as const, '', { shape: 'view-1' })
// Steps an animation while Claude reads or edits; still otherwise.
const frame = atom({ plugin: 'filedeck', key: 'frame' } as const, 0, { shape: 'frame-1' })
const follow = atom({ plugin: 'filedeck', key: 'follow' } as const, true, { shape: 'follow-1' })

// Every file git knows of (tracked and untracked, ignores applied), for search.
let allFiles: string[] = []

// Folder listings, kept briefly so an animation frame doesn't list the tree again.
const listings = new Map<string, { at: number; entries: FsEntry[] }>()
async function listDir($: EngineInterface, dir: string): Promise<FsEntry[]> {
  const hit = listings.get(dir)
  if (hit && Date.now() - hit.at < 3000) return hit.entries
  const entries = await $.fs.list(dir).catch(() => [])
  listings.set(dir, { at: Date.now(), entries })
  return entries
}

// ── look ─────────────────────────────────────────────────────────────────
// Hues as in the reference: soft, slightly desaturated, readable on the dark
// pane. A tint is the hue at low alpha, drawn behind text of the same hue.

const C = {
  read: '#b794f6',
  edit: '#f6a05a',
  dirty: '#e8c468',
  add: '#8fd18b',
  del: '#f07a7a',
  folder: '#6ea8e8',
  folderDim: '#9a9a9a',
  caret: '#8a8a8a',
  tile: '#ffffff0f',
  tileHover: '#ffffff1c',
  border: '#ffffff1f',
}
const tint = (hex: string, alpha = '2b') => `${hex}${alpha}`

type Badge = { label: string; color: string }
const BADGES: Array<[RegExp, Badge]> = [
  [/\.(js|mjs|cjs|jsx)$/i, { label: 'JS', color: '#e8c468' }],
  [/\.(ts|tsx|mts|cts)$/i, { label: 'TS', color: '#6ea8e8' }],
  [/\.json$/i, { label: '{}', color: '#8fd18b' }],
  [/\.(md|mdx)$/i, { label: 'MD', color: '#7fb0ee' }],
  [/\.(css|scss|sass|less)$/i, { label: 'CSS', color: '#b794f6' }],
  [/\.html?$/i, { label: 'HTML', color: '#f6a05a' }],
  [/\.pdf$/i, { label: 'PDF', color: '#f07a7a' }],
  [/\.(csv|tsv)$/i, { label: 'CSV', color: '#a6d98a' }],
  [/\.(xlsx?|numbers)$/i, { label: 'XLS', color: '#8fd18b' }],
  [/\.(docx?|rtf|pages)$/i, { label: 'DOC', color: '#7fa6f0' }],
  [/\.(png|jpe?g|gif|webp|svg|ico|avif|heic)$/i, { label: 'IMG', color: '#e48ad8' }],
  [/\.(mp4|mov|webm)$/i, { label: 'VID', color: '#e48ad8' }],
  [/\.(ya?ml|toml|ini|conf)$/i, { label: 'CFG', color: '#c9a66b' }],
  [/\.(sh|zsh|bash)$/i, { label: 'SH', color: '#a6d98a' }],
  [/\.py$/i, { label: 'PY', color: '#7fb0ee' }],
  [/\.sql$/i, { label: 'SQL', color: '#e8c468' }],
  [/\.lock$|lockb?$/i, { label: 'LOCK', color: '#9a9a9a' }],
  [/^\.env/i, { label: 'ENV', color: '#9a9a9a' }],
  [/^\.git/i, { label: 'GIT', color: '#9a9a9a' }],
  [/^(license|licence)/i, { label: 'TXT', color: '#9a9a9a' }],
  [/\.txt$/i, { label: 'TXT', color: '#9a9a9a' }],
]

// Material Icon Theme's icon for a file: by its whole name, then its longest
// known extension (test.ts before ts), then the plain file.
function fileIconOf(name: string): string {
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
const folderIconOf = (name: string, isOpen: boolean) => (BY_FOLDER_NAME[name.toLowerCase()] ?? ICON_FOLDER)[isOpen ? 1 : 0]

function badgeOf(name: string): Badge {
  for (const [re, b] of BADGES) if (re.test(name)) return b
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : ''
  return { label: ext ? ext.slice(0, 4).toUpperCase() : '—', color: '#9a9a9a' }
}

// Lucide icons (ISC), drawn as outline strokes like the reference.
const ICON = {
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  caretRight: '<path d="M8 5v14l11-7z"/>',
  caretDown: '<path d="M5 8h14l-7 11z"/>',
}

const stroke = (body: string, color: string, size = 24) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const solid = (body: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="${color}">${body}</svg>`
const disc = (body: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><circle cx="24" cy="24" r="24" fill="${color}" fill-opacity="0.2"/><g transform="translate(12 12)" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`

// An icon that breathes while Claude is on a file (SMIL, drawn by the surface).
const pulse = (body: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><g>${body}<animate attributeName="opacity" values="1;0.3;1" dur="1.1s" repeatCount="indefinite"/></g></svg>`

// ── formatting ───────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function when(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}
function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

const baseName = (p: string) => p.replace(/\/$/, '').split('/').pop() || p
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const joinAbs = (a: string, b: string) => (a.endsWith('/') ? a + b : `${a}/${b}`)
// A folder to show beside a name: the path inside the project, or the last
// folder of one outside it, which would otherwise run off the card.
const shortDir = (rel: string) => (rel.startsWith('/') ? `…/${baseName(dirName(rel))}` : dirName(rel))
const BINARY = /\.(pdf|png|jpe?g|gif|webp|ico|avif|heic|mp4|mov|webm|zip|gz|tgz|woff2?|ttf|otf|xlsx?|docx?|pptx?|numbers|pages|key|sqlite|db)$/i
// Keep a preview to its first lines; past them it says how many are left out.
function cap(text: string, lines: number): string {
  const all = text.split('\n')
  return all.length <= lines ? text : `${all.slice(0, lines).join('\n')}\n… ${all.length - lines} more lines`
}
// A diff cut mid-hunk no longer reads as one, so cut at the last whole hunk.
function capDiff(text: string, lines: number): { text: string; left: number } {
  const all = text.replace(/\n$/, '').split('\n')
  if (all.length <= lines) return { text, left: 0 }
  let end = lines
  while (end > 0 && !(all[end] ?? '').startsWith('@@')) end--
  if (end === 0) end = lines
  return { text: all.slice(0, end).join('\n'), left: all.length - end }
}
const relTo = (root: string, path: string) => (path === root ? '' : path.startsWith(root + '/') ? path.slice(root.length + 1) : path)

// ── git ──────────────────────────────────────────────────────────────────

async function runGit($: EngineInterface, cwd: string, args: string[], timeoutMs = 30_000) {
  return $.process.run(['git', ...args], { cwd, timeoutMs })
}

function parseStatus(out: string): Pick<GitSnap, 'branch' | 'upstream' | 'ahead' | 'behind'> & { files: GitFile[] } {
  const parts = out.split('\0')
  let branch = ''
  let upstream = ''
  let ahead = 0
  let behind = 0
  const files: GitFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? ''
    if (!entry) continue
    if (entry.startsWith('## ')) {
      const head = entry.slice(3).replace(/^No commits yet on /, '')
      const [names = '', counts = ''] = head.split(' [')
      const [b = names, u = ''] = names.split('...')
      branch = b
      upstream = u
      ahead = Number(/ahead (\d+)/.exec(counts)?.[1] ?? 0)
      behind = Number(/behind (\d+)/.exec(counts)?.[1] ?? 0)
      continue
    }
    const x = entry[0] ?? ' '
    const y = entry[1] ?? ' '
    if (x === 'R' || x === 'C') i++ // the original path follows a rename
    files.push({ path: entry.slice(3), x, y, add: 0, del: 0 })
  }
  return { branch, upstream, ahead, behind, files }
}

async function refreshGit($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const top = await runGit($, cwd, ['rev-parse', '--show-toplevel']).catch(() => undefined)
  if (!top || top.exitCode !== 0) {
    allFiles = []
    await update($, git, () => ({ ...EMPTY_GIT, root: cwd, at: Date.now() }))
    return
  }
  const root = top.stdout.trim()
  const [status, numstat, ignored, listed] = await Promise.all([
    runGit($, root, ['status', '--porcelain=v1', '-b', '-z', '-uall']),
    runGit($, root, ['diff', '--numstat', 'HEAD', '--']).catch(() => undefined),
    runGit($, root, ['ls-files', '-oi', '--exclude-standard', '--directory']).catch(() => undefined),
    runGit($, root, ['ls-files', '-co', '--exclude-standard']).catch(() => undefined),
  ])
  const parsed = parseStatus(status.stdout)
  const counts = new Map<string, [number, number]>()
  for (const line of numstat?.exitCode === 0 ? numstat.stdout.split('\n') : []) {
    const [a, d, ...rest] = line.split('\t')
    if (rest.length) counts.set(rest.join('\t'), [Number(a) || 0, Number(d) || 0])
  }
  const files = parsed.files.slice(0, 500).map(f => {
    const c = counts.get(f.path)
    return c ? { ...f, add: c[0], del: c[1] } : f
  })
  allFiles = (listed?.stdout ?? '').split('\n').filter(Boolean).slice(0, 20_000)
  listings.clear()
  const ignoredList = (ignored?.stdout ?? '').split('\n').filter(Boolean).slice(0, 2000)
  await update($, git, () => ({ isRepo: true, root, ...parsed, files, ignored: ignoredList, at: Date.now() }))
}

const DONE: Record<string, string> = {
  'Committing…': 'Committed',
  'Pushing…': 'Pushed',
  'Pulling…': 'Pulled',
  'Staging…': 'Staged',
  'Unstaging…': 'Unstaged',
}

async function gitAction($: EngineInterface, label: string, args: string[][], timeoutMs = 60_000): Promise<void> {
  if (await read($, busy)) return
  await update($, busy, () => label)
  await update($, note, () => '')
  try {
    const { root } = await read($, git)
    for (const a of args) {
      const r = await runGit($, root || (await $.session.cwd()), a, timeoutMs)
      if (r.exitCode !== 0) {
        const msg = (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')
        await update($, note, () => `✗ git ${a[0]}: ${msg || `exit ${r.exitCode}`}`)
        return
      }
    }
    await update($, note, () => `✓ ${DONE[label] ?? 'Done'}`)
  } catch (err) {
    await update($, note, () => `✗ ${String(err).slice(0, 160)}`)
  } finally {
    await update($, busy, () => '')
    await refreshGit($)
  }
}

const isStaged = (f: GitFile) => f.x !== ' ' && f.x !== '?'

async function commit($: EngineInterface, message: string): Promise<void> {
  const msg = message.trim()
  if (!msg) {
    await update($, note, () => '✗ Write a commit message first')
    return
  }
  const g = await read($, git)
  const stageFirst = !g.files.some(isStaged)
  await gitAction($, 'Committing…', [...(stageFirst ? [['add', '-A']] : []), ['commit', '-m', msg]])
}

async function push($: EngineInterface): Promise<void> {
  const g = await read($, git)
  await gitAction($, 'Pushing…', [g.upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD']], 120_000)
}

async function openPane($: EngineInterface) {
  const cwd = await $.session.cwd()
  return $.ui.open({ id: PANE, title: `Files: ${baseName(cwd)}` })
}

// ── activity ─────────────────────────────────────────────────────────────

async function markTouch($: EngineInterface, path: string, kind: Touch['kind'], isActive: boolean): Promise<void> {
  await update($, touched, list => {
    const rest = list.filter(t => t.path !== path)
    const prev = list.find(t => t.path === path)
    // An edit outranks a read: a file Claude edited stays "edited".
    const k: Touch['kind'] = prev?.kind === 'edit' && !isActive ? 'edit' : kind
    return [{ path, kind: k, isActive, at: Date.now() }, ...rest].slice(0, 50)
  })
}

// Open the tree to the file Claude is on: expand its folders, show the Files
// tab, and scroll its row into view once it's drawn.
async function followTo($: EngineInterface, path: string): Promise<void> {
  if (!(await read($, follow))) return
  const { root } = await read($, git)
  const base = (await read($, viewRoot)) || root || (await $.session.cwd())
  if (!path.startsWith(base + '/')) return
  const dirs: string[] = []
  for (let d = dirName(path); d.length > base.length; d = dirName(d)) dirs.push(d)
  await update($, expanded, xs => (dirs.every(d => xs.includes(d)) ? xs : [...new Set([...xs, ...dirs])]))
  if (!(await read($, query))) await update($, tab, t => (t === 'files' ? t : 'files'))
  try {
    $.clock.after(150, () => void $.ui.scroll({ to: { key: `row:${path}` }, in: PANE, block: 'center' }).catch(() => undefined))
  } catch {
    // No timer here (a test kit): the tree still opened.
  }
}

// The shimmer a name runs through while Claude is on it.
const SHIMMER: Record<Touch['kind'], string[]> = {
  read: ['#b794f6', '#cdb4fa', '#e4d6fd', '#cdb4fa'],
  edit: ['#f6a05a', '#f9bb85', '#fcd7b5', '#f9bb85'],
}

const GIT_VERB: Array<[RegExp, string]> = [
  [/\bgit\b[^|;&]*\bcommit\b/, 'Committing…'],
  [/\bgit\b[^|;&]*\bpush\b/, 'Pushing…'],
  [/\bgit\b[^|;&]*\bpull\b/, 'Pulling…'],
  [/\bgit\b[^|;&]*\b(checkout|switch)\b/, 'Switching branch…'],
  [/\bgit\b[^|;&]*\b(merge|rebase)\b/, 'Merging…'],
  [/\bgit\b[^|;&]*\b(add|reset|restore|stash)\b/, 'Updating index…'],
]

// ── register ─────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'filedeck', description: 'Open the Filedeck pane: files, what Claude touched, and git' })
    void refreshGit($)
    $.clock.every(15_000, () => void refreshGit($))
    $.clock.every(250, () => void read($, touched).then(list => (list.some(t => t.isActive) ? update($, frame, n => (n + 1) % 1200) : undefined)))
    void openPane($)
    return next(e)
  })

  on('command.run', { command: 'filedeck' }, async $ => {
    await refreshGit($)
    await openPane($)
    return { text: 'Filedeck opened.' }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
    const kind: Touch['kind'] | undefined =
      tool === 'Read' ? 'read' : tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit' ? 'edit' : undefined

    if (file && kind) {
      await markTouch($, file, kind, true)
      await followTo($, file).catch(() => undefined)
      try {
        return await next(e)
      } finally {
        await markTouch($, file, kind, false)
        if (kind === 'edit') {
          listings.delete(dirName(file))
          void refreshGit($)
        }
      }
    }

    if (tool === 'Bash' && typeof input.command === 'string') {
      const verb = GIT_VERB.find(([re]) => re.test(input.command as string))?.[1]
      const was = verb ? await read($, busy) : ''
      if (verb && !was) await update($, busy, () => verb)
      try {
        return await next(e)
      } finally {
        if (verb && !was) await update($, busy, () => '')
        void refreshGit($)
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Code, Markdown } = els
    const Input = 'Input' in els ? els.Input : undefined
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const isDesktop = e.surface !== 'terminal'
    const width = Math.max(30, e.props.bodyColumns ?? 60)
    const [g, list, open, hidden, sizes, current, working, message, q, view, selected, mode, step, following, site] = await Promise.all([
      read($, git),
      read($, touched),
      read($, expanded),
      read($, showHidden),
      read($, showSizes),
      read($, tab),
      read($, busy),
      read($, note),
      read($, query),
      read($, viewRoot),
      read($, selection),
      read($, previewMode),
      read($, frame),
      read($, follow),
      read($, selectionSite),
      read($, tick),
    ])
    const projectRoot = g.root || (await $.session.cwd())
    const root = view || projectRoot
    const changed = new Map(g.files.map(f => [f.path, f]))
    const activeByAbs = new Map(list.filter(t => t.isActive).map(t => [t.path, t]))
    const touchedByAbs = new Map(list.map(t => [t.path, t.kind]))
    // A folder's mark: edited if Claude edited anything under it, else read.
    const touchedUnder = (abs: string): Touch['kind'] | undefined => {
      let kind: Touch['kind'] | undefined
      for (const t of list) if (t.path.startsWith(abs + '/')) kind = kind === 'edit' || t.kind === 'edit' ? 'edit' : 'read'
      return kind
    }
    const activeUnder = (abs: string) => list.some(t => t.isActive && t.path.startsWith(abs + '/'))
    const now = list.find(t => t.isActive)
    const dirty = g.files.length

    // ── atoms of the look ──
    const icon = (body: string, color: string, px = 16, alt = '') =>
      Svg ? <Svg source={stroke(body, color)} alt={alt} width={px} height={px} /> : null

    const card = (key: string, children: RenderChildren[]) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor={isDesktop ? C.border : 'gray'} paddingX={isDesktop ? 2 : 1} paddingY={isDesktop ? 1 : 0} gap={isDesktop ? 'sm' : 0}>
        {children}
      </Box>
    )
    const heading = (left: string, right?: string) => (
      <Box flexDirection="row" justifyContent="space-between" paddingX={isDesktop ? 1 : 0}>
        <Text size="footnote" weight="bold" dimColor>{left.toUpperCase()}</Text>
        {right ? <Text size="footnote" weight="bold" dimColor>{right.toUpperCase()}</Text> : null}
      </Box>
    )
    const pill = (text: string, color: string) =>
      isDesktop
        ? <Text color={color} backgroundColor={tint(color, '33')} weight="semibold" size="footnote">{` ${text} `}</Text>
        : <Text color={color} bold>{text}</Text>
    const badge = (name: string) => {
      const b = badgeOf(name)
      const svg = SVG[fileIconOf(name)]
      if (Svg && svg) return <Box width={2} flexShrink={0} justifyContent="center" alignItems="center"><Svg source={svg} alt={b.label} width={18} height={18} /></Box>
      return isDesktop
        ? (
            <Box width={5} flexShrink={0} justifyContent="center" alignItems="center" backgroundColor={tint(b.color, '26')}>
              <Text size="caption" weight="bold" color={b.color}>{b.label}</Text>
            </Box>
          )
        : <Text color={b.color} bold>{b.label.padEnd(4)}</Text>
    }
    const caret = (isOpen: boolean) =>
      Svg ? <Svg source={solid(isOpen ? ICON.caretDown : ICON.caretRight, C.caret)} alt={isOpen ? 'open' : 'closed'} width={8} height={8} /> : <Text dimColor>{isOpen ? '▾' : '▸'}</Text>
    const spacer = (cols: number) => <Text>{' '.repeat(cols)}</Text>

    // ── status card ──
    const sync = [g.ahead ? `↑${g.ahead}` : '', g.behind ? `↓${g.behind}` : ''].filter(Boolean).join(' ')
    const nowColor = now ? (now.kind === 'read' ? C.read : C.edit) : C.caret
    const nowRel = now ? relTo(projectRoot, now.path) : ''
    const statusCard = card('status', [
      <Box flexDirection="row" gap={isDesktop ? 2 : 1} alignItems="center">
        {Svg ? <Svg source={disc(now ? (now.kind === 'read' ? ICON.eye : ICON.pencil) : ICON.moon, nowColor)} alt="" width={44} height={44} /> : null}
        <Box flexDirection="column" flexShrink={1}>
          <Text size="footnote" weight="bold" color={nowColor}>{now ? 'RIGHT NOW' : 'IDLE'}</Text>
          <Text size="heading" weight="semibold" wrap="truncate-middle">
            {now
              ? `Claude is ${now.kind === 'read' ? 'reading' : 'editing'} ${baseName(now.path)}`
              : list[0] ? `Last touched ${baseName(list[0].path)}` : 'Waiting for Claude'}
          </Text>
          <Text dimColor wrap="truncate-start">{now ? `in ${dirName(nowRel) || baseName(projectRoot)}` : baseName(projectRoot)}</Text>
        </Box>
      </Box>,
      g.isRepo ? (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" gap={1} alignItems="center">
            {icon(ICON.branch, C.folder, 16, 'branch')}
            <Text weight="semibold">{`${Svg ? '' : '⎇ '}${g.branch}${sync ? `  ${sync}` : ''}`}</Text>
          </Box>
          {working
            ? <Text color={C.add} weight="semibold">{`● ${working.toLowerCase()}`}</Text>
            : <Text dimColor>{dirty ? `${dirty} changed, not committed` : 'clean, nothing changed'}</Text>}
        </Box>
      ) : (
        <Text dimColor>Not a git repository</Text>
      ),
      <Box flexDirection="row" gap={isDesktop ? 3 : 2} flexWrap="wrap">
        <Text><Text color={C.read}>●</Text> Claude read</Text>
        <Text><Text color={C.edit}>●</Text> Claude edited</Text>
        <Text><Text color={C.dirty}>●</Text> Not committed</Text>
      </Box>,
    ])

    // ── tabs ──
    const tabs = (
      <Box flexDirection="row" gap={1}>
        <Button key="tab:files" variant={current === 'files' ? 'primary' : 'secondary'} onPress={() => void update($, tab, () => 'files')}>Files</Button>
        <Button key="tab:changes" variant={current === 'changes' ? 'primary' : 'secondary'} onPress={() => void update($, tab, () => 'changes')}>
          {`Changes${dirty ? ` (${dirty})` : ''}`}
        </Button>
      </Box>
    )

    const body = current === 'changes' ? await changesView() : await filesView()

    return (
      <Box flexDirection="column" gap={isDesktop ? 'md' : 1} width={width}>
        {statusCard}
        {tabs}
        {body}
      </Box>
    )

    // ── one tree / list row ──
    function row(o: {
      abs: string
      name: string
      depth: number
      isDir: boolean
      isOpen?: boolean
      right: RenderChildren
      sub?: string
      onPress: () => void
    }) {
      const rel = relTo(projectRoot, o.abs)
      const act = activeByAbs.get(o.abs)
      const actColor = act ? (act.kind === 'read' ? C.read : C.edit) : undefined
      const gf = changed.get(rel)
      const shade = act ? (SHIMMER[act.kind][step % 4] ?? actColor) : undefined
      const nameColor = shade ?? (gf ? C.dirty : undefined)
      const mark = o.isDir ? touchedUnder(o.abs) : touchedByAbs.get(o.abs)
      const busyInside = o.isDir && !o.isOpen && activeUnder(o.abs)
      const dimDir = o.isDir && o.name.startsWith('.')
      const lead = (
        <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0} overflow="hidden">
          {o.depth ? <Box width={o.depth * 2} flexShrink={0} /> : null}
          <Box width={1} flexShrink={0} justifyContent="center">{o.isDir ? caret(Boolean(o.isOpen)) : spacer(1)}</Box>
          <Box flexShrink={0}>{o.isDir ? (Svg ? <Box width={2} justifyContent="center" alignItems="center"><Svg source={SVG[folderIconOf(o.name, Boolean(o.isOpen))] ?? stroke(ICON.folder, C.folder)} alt="folder" width={18} height={18} /></Box> : <Text color={C.folder}>{o.isOpen ? '▣' : '▢'}</Text>) : badge(o.name)}</Box>
          <Box flexShrink={1} minWidth={0} overflow="hidden">
            <Button key={`f:${o.abs}`} plain onPress={o.onPress}>
              <Text color={nameColor} weight={act || selected === o.abs ? 'semibold' : 'regular'} dimColor={dimDir} wrap="truncate-end">{o.name}</Text>
              {mark && !act ? <Text color={mark === 'read' ? C.read : C.edit} dimColor={busyInside ? step % 2 === 0 : false}>{busyInside ? '  ●' : '  •'}</Text> : ''}
              {o.sub ? <Text dimColor wrap="truncate-end">{`  ${o.sub}`}</Text> : ''}
            </Button>
          </Box>
        </Box>
      )
      return (
        <Box
          key={`row:${o.abs}`}
          flexDirection="row"
          justifyContent="space-between"
          alignItems="center"
          paddingX={isDesktop ? 1 : 0}
          backgroundColor={act ? tint(actColor ?? C.read, step % 4 < 2 ? '2b' : '3d') : selected === o.abs ? C.tileHover : isDesktop ? C.tile : undefined}
          hover={{ backgroundColor: act ? tint(actColor ?? C.read, '3d') : C.tileHover }}
        >
          {lead}
          <Box flexShrink={0} marginLeft={1} flexDirection="row" alignItems="center" gap={1}>
            {act && Svg ? <Svg source={pulse(act.kind === 'read' ? ICON.eye : ICON.pencil, actColor ?? C.read)} alt="" width={14} height={14} isInteractive /> : null}
            {act ? pill(`${act.kind === 'read' ? 'reading' : 'editing'}${'.'.repeat(1 + (Math.floor(step / 2) % 3)).padEnd(3, ' ')}`, actColor ?? C.read) : o.right}
          </Box>
        </Box>
      )
    }

    function fileRight(abs: string, mtimeMs: number, size: number) {
      const gf = changed.get(relTo(projectRoot, abs))
      if (gf) {
        if (gf.x === '?') return <Text color={C.add} weight="semibold" size="footnote">new</Text>
        return (
          <Text weight="semibold" size="footnote" tabular>
            <Text color={C.add}>{`+${gf.add}`}</Text>{'  '}<Text color={C.del}>{`−${gf.del}`}</Text>
          </Text>
        )
      }
      return <Text dimColor tabular>{sizes ? bytes(size) : when(mtimeMs)}</Text>
    }
    function choose(abs: string, where: SelectionSite = 'tree') {
      return () => {
        const again = selected === abs && site === where
        void update($, selectionSite, () => where).then(() => update($, selection, () => (again ? '' : abs)))
      }
    }
    // The viewer opens in one place only: where the file was clicked.
    function openHere(abs: string, where: SelectionSite) {
      return selected === abs && site === where
    }

    // The selected file, opened under its row: its diff when git has one,
    // else its text, with buttons to switch, open it in its app or mention it.
    async function preview(abs: string, depth: number) {
      const rel = relTo(projectRoot, abs)
      const gf = changed.get(rel)
      const isBinary = BINARY.test(abs)
      const view: PreviewMode = gf && mode === 'diff' ? 'diff' : 'file'
      let body: RenderChildren
      if (view === 'diff' && gf) {
        const args = gf.x === '?' ? ['diff', '--no-index', '--', '/dev/null', rel] : ['diff', 'HEAD', '--', rel]
        const r = await runGit($, projectRoot, args).catch(() => undefined)
        const raw = r?.stdout ?? ''
        const at = raw.indexOf('\n@@')
        const hunks = raw.startsWith('@@') ? raw : at >= 0 ? raw.slice(at + 1) : ''
        body = /^Binary files/m.test(raw) || isBinary
          ? <Text dimColor>Binary file changed. Use View to see it.</Text>
          : hunks
            ? (() => {
                const { text, left } = capDiff(hunks, 1500)
                return (
                  <Box flexDirection="column">
                    <Code source={text} format="diff" path={rel} wrap="truncate-end" />
                    {left ? <Text dimColor size="footnote">{`… ${left} more lines`}</Text> : null}
                  </Box>
                )
              })()
            : <Text dimColor>No line changes to show.</Text>
      } else if (isBinary) {
        body = <Text dimColor>{`${badgeOf(baseName(abs)).label} file. Use View to see it.`}</Text>
      } else {
        const text = await $.fs.read(abs).catch(() => undefined)
        body = typeof text !== 'string'
          ? <Text dimColor>This file can't be read.</Text>
          : text.includes('\0')
            ? <Text dimColor>Binary file. Use View to see it.</Text>
            : text.trim()
              ? <Code source={cap(text, 400)} path={rel} startLine={1} wrap="truncate-end" />
              : <Text dimColor>Empty file.</Text>
      }
      return (
        <Box key={`pv:${abs}`} flexDirection="column" marginLeft={depth * 2} borderStyle="round" borderColor={isDesktop ? C.border : 'gray'} paddingX={1} gap={isDesktop ? 'xs' : 0}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
            <Box flexDirection="row" gap={1}>
              {gf ? <Button key={`pvd:${abs}`} variant={view === 'diff' ? 'primary' : 'secondary'} onPress={() => void update($, previewMode, () => 'diff')}>Diff</Button> : null}
              {gf ? <Button key={`pvf:${abs}`} variant={view === 'file' ? 'primary' : 'secondary'} onPress={() => void update($, previewMode, () => 'file')}>File</Button> : null}
              {isDesktop
                ? <Markdown key={`pvl:${abs}`} text={`[View](${encodeURI(rel === abs ? `file://${abs}` : rel)})`} />
                : <Button key={`pvo:${abs}`} onPress={() => void $.process.run(['open', abs]).catch(() => undefined)}>Open</Button>}
              <Button key={`pvm:${abs}`} onPress={insert(abs)}>Mention</Button>
            </Box>
            <Box flexDirection="row" gap={1} alignItems="center">
              {gf && gf.x !== '?' ? <Text size="footnote" tabular><Text color={C.add}>{`+${gf.add}`}</Text> <Text color={C.del}>{`−${gf.del}`}</Text></Text> : null}
              <Button key={`pvx:${abs}`} plain onPress={() => void update($, selection, () => '')}>✕</Button>
            </Box>
          </Box>
          {body}
        </Box>
      )
    }

    function insert(abs: string) {
      return () => void $.prompt.fill({ text: `@${relTo(projectRoot, abs)} `, mode: 'insert' })
    }

    // ── files tab ──
    async function filesView() {
      const touchedRows: RenderChildren[] = []
      for (const t of list.slice(0, 6)) {
        const rel = relTo(projectRoot, t.path)
        const color = t.kind === 'read' ? C.read : C.edit
        touchedRows.push(
          <Box key={`t:${t.path}`} flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={isDesktop ? 1 : 0} backgroundColor={openHere(t.path, 'touched') ? C.tileHover : undefined}>
            <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0} overflow="hidden">
              {badge(baseName(rel))}
              <Box flexShrink={1} minWidth={0} overflow="hidden">
                <Button key={`tb:${t.path}`} plain onPress={choose(t.path, 'touched')}>
                  <Text weight="semibold" wrap="truncate-end" color={t.isActive ? SHIMMER[t.kind][step % 4] : undefined}>{baseName(rel)}</Text>
                  <Text dimColor wrap="truncate-end">{`  ${shortDir(rel)}`}</Text>
                </Button>
              </Box>
            </Box>
            {t.isActive ? pill(t.kind === 'read' ? 'Reading' : 'Editing', color) : <Text color={color} size="footnote">{t.kind === 'read' ? 'Read' : 'Edited'}</Text>}
          </Box>,
        )
        if (openHere(t.path, 'touched')) touchedRows.push(await preview(t.path, 0))
      }
      const touchedCard = card('touched', [
        heading('Claude touched', `${list.length} file${list.length === 1 ? '' : 's'}`),
        ...(list.length
          ? touchedRows
          : [<Text dimColor>{'  Nothing yet'}</Text>]),
      ])

      const search = Input ? (
        <Box flexDirection="row" alignItems="center" gap={1} width="100%">
          {icon(ICON.search, C.caret, 18, 'search')}
          <Box flexGrow={1} width="100%">
            <Input key="find" placeholder="Find a file" value={q} onInput={(v: string) => void update($, query, () => v)} onSubmit={(v: string) => void update($, query, () => v)} />
          </Box>
          {q ? <Button key="clearq" plain onPress={() => void update($, query, () => '')}>✕</Button> : null}
        </Box>
      ) : null

      const toolbar = (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="refresh" onPress={() => void refreshGit($).then(() => update($, tick, n => n + 1))}>Refresh</Button>
          <Button key="collapse" onPress={() => void update($, expanded, () => [])}>Collapse all</Button>
          <Button key="sizes" onPress={() => void update($, showSizes, v => !v)}>{sizes ? 'Show dates' : 'Show sizes'}</Button>
          <Button key="up" onPress={() => void update($, viewRoot, () => dirName(root) || '/')}>Up a folder</Button>
          {root !== projectRoot ? <Button key="back" onPress={() => void update($, viewRoot, () => '')}>Back to project</Button> : null}
          <Button key="hidden" onPress={() => void update($, showHidden, v => !v)}>{hidden ? 'Hide hidden files' : 'Show hidden files'}</Button>
          <Button key="follow" variant={following ? 'primary' : 'secondary'} onPress={() => void update($, follow, v => !v)}>{following ? 'Following Claude' : 'Follow Claude'}</Button>
        </Box>
      )

      const rows: RenderChildren[] = []
      const needle = q.trim().toLowerCase()
      if (needle) {
        const hits = allFiles.filter(p => p.toLowerCase().includes(needle)).slice(0, MAX_MATCHES)
        for (const rel of hits) {
          const abs = joinAbs(projectRoot, rel)
          rows.push(row({ abs, name: baseName(rel), depth: 0, isDir: false, sub: dirName(rel), right: <Text> </Text>, onPress: choose(abs) }))
          if (openHere(abs, 'tree')) rows.push(await preview(abs, 0))
        }
        if (!hits.length) rows.push(<Text dimColor>{`  No file matches “${q.trim()}”`}</Text>)
      } else {
        const ignored = new Set(g.ignored.map(p => joinAbs(projectRoot, p.replace(/\/$/, ''))))
        const openSet = new Set(open)
        const changedUnder = (abs: string) => {
          const rel = relTo(projectRoot, abs)
          return rel === abs ? 0 : g.files.filter(f => f.path.startsWith(rel + '/')).length
        }
        const walk = async (dir: string, depth: number): Promise<void> => {
          const entries = await listDir($, dir)
          const visible = entries
            .filter(en => en.name !== '.DS_Store')
            .filter(en => hidden || !en.name.startsWith('.') || en.name === '.git')
            .filter(en => hidden || !ignored.has(joinAbs(dir, en.name)))
            .sort((a, b) => ((a.kind === 'dir') === (b.kind === 'dir') ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
          for (const en of visible) {
            if (rows.length >= MAX_ROWS) {
              rows.push(<Text dimColor>{'  … more files not shown'}</Text>)
              return
            }
            const abs = joinAbs(dir, en.name)
            if (en.kind === 'dir') {
              const isOpen = openSet.has(abs)
              const n = changedUnder(abs)
              rows.push(row({
                abs,
                name: en.name,
                depth,
                isDir: true,
                isOpen,
                right: n ? <Text color={C.dirty} weight="semibold" size="footnote">{`${n} changed`}</Text> : <Text> </Text>,
                onPress: () => void update($, expanded, xs => (xs.includes(abs) ? xs.filter(x => x !== abs) : [...xs, abs])),
              }))
              if (isOpen) await walk(abs, depth + 1)
            } else {
              rows.push(row({ abs, name: en.name, depth, isDir: false, right: fileRight(abs, en.mtimeMs, en.size), onPress: choose(abs) }))
              if (openHere(abs, 'tree')) rows.push(await preview(abs, depth))
            }
          }
        }
        await walk(root, 0)
        if (!rows.length) rows.push(<Text dimColor>{'  This folder is empty'}</Text>)
      }

      return (
        <Box flexDirection="column" gap={isDesktop ? 'md' : 1}>
          {search}
          {toolbar}
          {touchedCard}
          <Box flexDirection="column" gap={isDesktop ? 'xs' : 0}>
            {heading(needle ? 'Matches' : 'All files', needle ? String(rows.length) : baseName(root))}
            {rows}
          </Box>
        </Box>
      )
    }

    // ── changes tab ──
    async function changesView() {
      if (!g.isRepo) return card('nogit', [<Text dimColor>This folder is not a git repository.</Text>])
      const staged = g.files.filter(isStaged)
      const unstaged = g.files.filter(f => !isStaged(f) || (f.y !== ' ' && f.y !== '?'))
      const letter = (f: GitFile, side: 'staged' | 'unstaged') => {
        const s = side === 'staged' ? f.x : f.y === ' ' ? f.x : f.y
        return s === '?' ? 'U' : s
      }
      const letterColor = (s: string) => (s === 'A' || s === 'U' ? C.add : s === 'D' ? C.del : s === 'R' ? C.read : C.dirty)

      const changeRow = (f: GitFile, side: 'staged' | 'unstaged') => {
        const s = letter(f, side)
        const abs = joinAbs(projectRoot, f.path)
        const toggle = side === 'staged' ? [['restore', '--staged', '--', f.path]] : [['add', '--', f.path]]
        return (
          <Box key={`g:${side}:${f.path}`} flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={isDesktop ? 1 : 0} backgroundColor={selected === abs ? C.tileHover : isDesktop ? C.tile : undefined} hover={{ backgroundColor: C.tileHover }}>
            <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0} overflow="hidden">
              {badge(baseName(f.path))}
              <Box flexShrink={1} minWidth={0} overflow="hidden">
                <Button key={`gb:${side}:${f.path}`} plain onPress={choose(abs)}>
                  <Text wrap="truncate-end">{baseName(f.path)}</Text>
                  <Text dimColor wrap="truncate-end">{`  ${dirName(f.path)}`}</Text>
                </Button>
              </Box>
            </Box>
            <Box flexDirection="row" gap={1} alignItems="center">
              {f.add || f.del ? <Text size="footnote" tabular><Text color={C.add}>{`+${f.add}`}</Text> <Text color={C.del}>{`−${f.del}`}</Text></Text> : null}
              <Text color={letterColor(s)} weight="bold" mono>{s}</Text>
              <Button key={`gs:${side}:${f.path}`} plain onPress={() => void gitAction($, side === 'staged' ? 'Unstaging…' : 'Staging…', toggle)}>
                {side === 'staged' ? ' − ' : ' + '}
              </Button>
            </Box>
          </Box>
        )
      }

      async function withPreviews(fs: GitFile[], side: 'staged' | 'unstaged') {
        const out: RenderChildren[] = []
        for (const f of fs) {
          out.push(changeRow(f, side))
          const abs = joinAbs(projectRoot, f.path)
          if (openHere(abs, 'tree') && !(side === 'unstaged' && staged.includes(f))) out.push(await preview(abs, 0))
        }
        return out
      }

      // What a commit takes: the staged files, or everything when none are.
      const willCommit = staged.length || g.files.length
      const commitLabel = willCommit ? `Commit ${willCommit} file${willCommit === 1 ? '' : 's'}` : 'Commit'
      const scope = staged.length
        ? `${staged.length} staged${unstaged.length ? ` · ${unstaged.length} left out` : ''}`
        : g.files.length ? `Nothing staged, so all ${g.files.length} changes go in` : 'Nothing to commit'
      const upstreamName = g.upstream || 'origin'
      const syncState = !g.upstream
        ? { text: 'Not published yet', color: C.dirty }
        : g.ahead && g.behind
          ? { text: `${g.ahead} to push · ${g.behind} to pull`, color: C.dirty }
          : g.ahead
            ? { text: `${g.ahead} commit${g.ahead === 1 ? '' : 's'} to push`, color: C.edit }
            : g.behind
              ? { text: `${g.behind} commit${g.behind === 1 ? '' : 's'} to pull`, color: C.folder }
              : { text: `Up to date with ${upstreamName}`, color: C.add }
      const pushFirst = Boolean(g.ahead || !g.upstream)
      const pullFirst = Boolean(g.behind) && !pushFirst

      return (
        <Box flexDirection="column" gap={isDesktop ? 'md' : 1}>
          {card('commit', [
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              <Text size="footnote" weight="bold" dimColor>COMMIT</Text>
              <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0} overflow="hidden">
                {icon(ICON.branch, C.folder, 14, 'branch')}
                <Text weight="semibold" size="footnote" wrap="truncate-end">{g.branch}</Text>
                {g.upstream ? <Text dimColor size="footnote" wrap="truncate-end">{`→ ${g.upstream}`}</Text> : null}
              </Box>
            </Box>,
            Input
              ? <Input key="msg" rows={3} placeholder="Describe what changed" submitLabel={commitLabel} onSubmit={(value: string) => void commit($, value)} />
              : <Text dimColor>Commit from the desktop app or terminal.</Text>,
            <Text dimColor size="footnote">{scope}</Text>,
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1} paddingTop={isDesktop ? 'xs' : 0}>
              <Text color={working ? C.add : syncState.color} weight="semibold" size="footnote">
                {working ? `● ${working}` : `● ${syncState.text}`}
              </Text>
              <Box flexDirection="row" gap={1}>
                <Button key="pull" variant={pullFirst ? 'primary' : 'secondary'} onPress={() => void gitAction($, 'Pulling…', [['pull', '--ff-only']], 120_000)}>
                  {`Pull${g.behind ? ` ↓${g.behind}` : ''}`}
                </Button>
                <Button key="push" variant={pushFirst ? 'primary' : 'secondary'} onPress={() => void push($)}>
                  {!g.upstream ? 'Publish' : `Push${g.ahead ? ` ↑${g.ahead}` : ''}`}
                </Button>
              </Box>
            </Box>,
            ...(message ? [<Text color={message.startsWith('✗') ? C.del : C.add} size="footnote">{message}</Text>] : []),
          ])}
          {staged.length > 0 && (
            <Box flexDirection="column" gap={isDesktop ? 'xs' : 0}>
              <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={isDesktop ? 1 : 0}>
                <Text size="footnote" weight="bold" dimColor>{`STAGED  ${staged.length}`}</Text>
                <Button key="unstageall" plain dimColor onPress={() => void gitAction($, 'Unstaging…', [['reset', '-q']])}>Unstage all</Button>
              </Box>
              {await withPreviews(staged, 'staged')}
            </Box>
          )}
          <Box flexDirection="column" gap={isDesktop ? 'xs' : 0}>
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={isDesktop ? 1 : 0}>
              <Text size="footnote" weight="bold" dimColor>{`CHANGES  ${unstaged.length}`}</Text>
              <Box flexDirection="row" gap={2}>
                {unstaged.length ? <Button key="stageall" plain dimColor onPress={() => void gitAction($, 'Staging…', [['add', '-A']])}>Stage all</Button> : null}
                <Button key="grefresh" plain dimColor onPress={() => void refreshGit($)}>Refresh</Button>
              </Box>
            </Box>
            {unstaged.length ? await withPreviews(unstaged, 'unstaged') : <Text dimColor>{'  Working tree clean'}</Text>}
          </Box>
        </Box>
      )
    }
  })
}
