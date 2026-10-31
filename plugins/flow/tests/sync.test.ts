import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PERSONAL_PATH_PROBLEM, SECRET_PROBLEM, nameSlug, parsePorcelain, scanText } from '../hooks/sync'

const HOME = '/home/u'
const FLOWS = `${HOME}/Documents/flows`
const TEAM = `${HOME}/.flow/sources/team`
const NOW = new Date(2026, 9, 28, 12, 0, 0).getTime()

const GOOD_FLOW = 'title: Report\nsteps:\n  - id: a\n    run: echo a\n'
const SOURCES = 'sources:\n  - name: team\n    title: Team\n    git: git@gitlab.com:org/team-flows.git\n'

/** One repo's git, as the mock answers it. */
type Repo = {
  status: string
  branch: string
  defaultBranch: string
  ahead: number
  behind: number
  remote: string
  pull: { exitCode: number; stderr?: string }
  push: { exitCode: number; stderr?: string }
  /** commits merge-base --is-ancestor finds upstream */
  merged: string[]
  /** whether refs/remotes/origin/HEAD is set (to defaultBranch) */
  hasOriginHead: boolean
  /** the origin/<name> branches rev-parse --verify finds */
  remoteBranches: string[]
  /** what remote set-head origin --auto sets origin/HEAD to; it fails when not given */
  setHeadTo?: string
  /** the git dir, when not <repo>/.git (a worktree) */
  gitDir?: string
}

const repoOf = (over: Partial<Repo> = {}): Repo => ({
  status: '',
  branch: 'main',
  defaultBranch: 'main',
  ahead: 0,
  behind: 0,
  remote: 'git@gitlab.com:org/flows.git',
  pull: { exitCode: 0 },
  push: { exitCode: 0 },
  merged: [],
  hasOriginHead: true,
  remoteBranches: ['main'],
  ...over,
})

const MR_STDERR = [
  'remote: ',
  'remote: View merge request for flow-share/ethan-bettenga/20261028-120000:',
  'remote:   https://gitlab.com/org/flows/-/merge_requests/42',
  'remote: ',
  'To gitlab.com:org/flows.git',
  ' * [new branch]      HEAD -> flow-share/ethan-bettenga/20261028-120000',
].join('\n')

/** Files in memory, git answered per repo folder, the plugin's store in a map. */
function world(on: On, setup: { files?: Record<string, string>; repos?: Record<string, Repo>; store?: Record<string, unknown> } = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME, LANG: 'en_US.UTF-8' })
  const files = new Map(Object.entries(setup.files ?? {}))
  const repos = setup.repos ?? {}
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path.replace(/\/+$/, '')}/`))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.stat', (_, e) => {
    if (files.has(e.path)) return { value: { kind: 'file', size: (files.get(e.path) ?? '').length, mtimeMs: 0, isLink: false } } as never
    if (isDir(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } as never
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const base = `${e.path.replace(/\/+$/, '')}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const k of files.keys()) {
      if (!k.startsWith(base)) continue
      const rest = k.slice(base.length)
      names.set(rest.split('/')[0] ?? '', rest.includes('/') ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  const git: { argv: string[]; cwd?: string }[] = []
  on('process.run', (_, e) => {
    const done = (exitCode: number, stdout = '', stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] !== 'git') return done(1)
    const argv = e.argv.slice(1)
    const cwd = e.init?.cwd
    git.push({ argv, cwd })
    const r = repos[cwd ?? '']
    if (!r) return done(128, '', 'fatal: not a git repository')
    switch (argv[0]) {
      case 'status':
        return done(0, r.status)
      case 'branch':
        return done(0, `${r.branch}\n`)
      case 'symbolic-ref':
        return r.hasOriginHead ? done(0, `refs/remotes/origin/${r.defaultBranch}\n`) : done(128, '', 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref')
      case 'rev-list':
        return done(0, `${r.ahead}\t${r.behind}\n`)
      case 'config':
        return done(0, 'Ethan Bettenga\n')
      case 'rev-parse':
        if (argv[1] === '--verify') return done(r.remoteBranches.some(b => argv[3] === `refs/remotes/origin/${b}`) ? 0 : 1)
        if (argv[1] === '--git-path') return done(0, `${r.gitDir ?? '.git'}/${argv[2]}\n`)
        return done(0, 'c0ffee1\n')
      case 'remote':
        if (argv[1] !== 'set-head') return done(0, `${r.remote}\n`)
        if (!r.setHeadTo) return done(1, '', 'error: Cannot determine remote HEAD')
        r.hasOriginHead = true
        r.defaultBranch = r.setHeadTo
        return done(0)
      case 'pull':
        return done(r.pull.exitCode, '', r.pull.stderr ?? '')
      case 'push':
        return done(r.push.exitCode, '', r.push.stderr ?? '')
      case 'merge-base':
        return done(r.merged.includes(argv[2] ?? '') ? 0 : 1)
      case 'cherry':
        return done(0, `+ ${argv[2]}\n`)
      default:
        return done(0)
    }
  })
  const store = new Map<string, unknown>(Object.entries(setup.store ?? {}))
  on('store.get', (_, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__flow__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  /** The git argv run in a folder since the mark, without the leading "git". */
  const ran = (cwd: string, from = 0) => git.slice(from).filter(g => g.cwd === cwd).map(g => g.argv)
  return { clock, files, git, ran, store }
}

async function begin($: Engine) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
}

const call = async ($: Engine, tool: string, input: Record<string, unknown> = {}) => ((await $.tool.call({ tool: `mcp__flow__${tool}`, ...input } as never)) as { result: string }).result

// ---------------------------------------------------------------------------
// Status

test('porcelain -z: modified, renamed (old path skipped), untracked, deleted and added, each with its item', () => {
  const z = ' M report/flow.yaml\0R  digest/flow.yaml\0old-digest/flow.yaml\0?? report/run.py\0 D gone/view.yaml\0A  flows.yaml\0MM listeners/view.yaml\0'
  expect(parsePorcelain(z)).toEqual([
    { path: 'report/flow.yaml', kind: 'modified', item: 'report' },
    { path: 'digest/flow.yaml', kind: 'renamed', item: 'digest' },
    { path: 'report/run.py', kind: 'untracked', item: 'report' },
    { path: 'gone/view.yaml', kind: 'deleted', item: 'gone' },
    { path: 'flows.yaml', kind: 'added', item: 'flows.yaml' },
    { path: 'listeners/view.yaml', kind: 'modified', item: 'listeners' },
  ])
  expect(parsePorcelain('')).toEqual([])
})

test('sync_status: the flows folder and a source, behind and ahead, changes grouped by item', async ($, on) => {
  const w = world(on, {
    files: { [`${FLOWS}/.git/HEAD`]: 'x', [`${FLOWS}/flows.yaml`]: SOURCES, [`${TEAM}/.git/HEAD`]: 'x' },
    repos: {
      [FLOWS]: repoOf({ status: ' M report/flow.yaml\0?? report/run.py\0 M flows.yaml\0', ahead: 1, behind: 2 }),
      [TEAM]: repoOf({ branch: 'feature', defaultBranch: 'master' }),
    },
  })
  await begin($)
  const status = JSON.parse(await call($, 'sync_status')) as Record<string, unknown>[]
  expect(status).toEqual([
    {
      repo: 'local',
      title: 'flows',
      path: FLOWS,
      branch: 'main',
      defaultBranch: 'main',
      behind: 2,
      ahead: 1,
      changes: { report: ['modified report/flow.yaml', 'untracked report/run.py'], 'flows.yaml': ['modified flows.yaml'] },
      pending: [],
    },
    { repo: 'team', title: 'Team', path: TEAM, branch: 'feature', defaultBranch: 'master', behind: 0, ahead: 0, changes: {}, pending: [] },
  ])
  expect(w.ran(FLOWS)).toContainEqual(['status', '--porcelain=v1', '-uall', '-z'])
  expect(w.ran(FLOWS)).toContainEqual(['rev-list', '--left-right', '--count', 'HEAD...@{u}'])
  expect(w.ran(FLOWS)).toContainEqual(['symbolic-ref', 'refs/remotes/origin/HEAD'])
})

// ---------------------------------------------------------------------------
// Guardrails

test('guardrails: personal paths and secrets are found, comments and templates are not', () => {
  const text = [
    'steps:',
    '  - id: a',
    '    run: python /Users/ethan/Documents/repos/kh/run.py', // 3: personal path
    '    # was /Users/ethan/Documents/old.py', // a comment: fine
    '  - id: b',
    '    run: ls {{local.repo}}/src', // a local: fine
    '    env: { TOKEN: "{{env.GITLAB_TOKEN}}" }', // an env template: fine
    '    cwd: /home/sam/work', // 8: personal path
    'aws: AKIAABCDEFGHIJKLMNOP', // 9: secret
    'api_key: "abcd1234efgh5678"', // 10: secret
    'password = \'{{env.DB_PASSWORD}}\'', // a template: fine
    'slack: xoxb-1234567890-abcdef', // 12: secret
    '# token: glpat-abcdefghijklmnopqrst', // 13: a secret even in a comment
    'note: /Users/Shared is not under a person', // no trailing name and slash: fine
  ].join('\n')
  expect(scanText('report/flow.yaml', text)).toEqual([
    { path: 'report/flow.yaml', line: 3, problem: PERSONAL_PATH_PROBLEM },
    { path: 'report/flow.yaml', line: 8, problem: PERSONAL_PATH_PROBLEM },
    { path: 'report/flow.yaml', line: 9, problem: SECRET_PROBLEM },
    { path: 'report/flow.yaml', line: 10, problem: SECRET_PROBLEM },
    { path: 'report/flow.yaml', line: 12, problem: SECRET_PROBLEM },
    { path: 'report/flow.yaml', line: 13, problem: SECRET_PROBLEM },
  ])
  expect(PERSONAL_PATH_PROBLEM).toBe('hard-coded personal path: use a local ({{local.<id>}}) instead')
  expect(SECRET_PROBLEM).toBe('looks like a secret: list it under env: and use {{env.NAME}}')
  expect(scanText('a.py', 'key = "sk-ant-api03-abcdefghijklmnopqrstuv"\ngh = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"\n-----BEGIN RSA PRIVATE KEY-----')).toHaveLength(3)
  expect(nameSlug('Ethan Bettenga')).toBe('ethan-bettenga')
  expect(nameSlug('  José  Núñez ')).toBe('jose-nunez')
  expect(nameSlug('')).toBe('someone')
})

test('share_changes: a flow.yaml that does not parse and a personal path stop the Share before any commit', async ($, on) => {
  const w = world(on, {
    files: {
      [`${FLOWS}/.git/HEAD`]: 'x',
      [`${FLOWS}/report/flow.yaml`]: 'title: Report\nsteps: nope\n',
      [`${FLOWS}/report/run.py`]: 'import os\n\nopen("/Users/ethan/data.csv")\n',
      [`${FLOWS}/flows.yaml`]: 'groups: 3\n',
    },
    repos: { [FLOWS]: repoOf({ status: ' M report/flow.yaml\0?? report/run.py\0 M flows.yaml\0' }) },
  })
  await begin($)
  const mark = w.git.length
  const result = await call($, 'share_changes', { message: 'New report' })
  expect(result).toContain('Not shared: fix these first, then share again:')
  expect(result).toContain('- report/flow.yaml: steps')
  expect(result).toContain(`- report/run.py:3: ${PERSONAL_PATH_PROBLEM}`)
  expect(result).toContain('- flows.yaml: ')
  const after = w.ran(FLOWS, mark).map(a => a[0])
  expect(after).not.toContain('pull')
  expect(after).not.toContain('commit')
  expect(after).not.toContain('push')
})

// ---------------------------------------------------------------------------
// Share

test('share_changes: pulls, commits, pushes a flow-share branch with GitLab push options and records the pending MR', async ($, on) => {
  const w = world(on, {
    files: { [`${FLOWS}/.git/HEAD`]: 'x', [`${FLOWS}/report/flow.yaml`]: GOOD_FLOW, [`${FLOWS}/report/run.py`]: 'print("hi")\n' },
    repos: { [FLOWS]: repoOf({ status: ' M report/flow.yaml\0?? report/run.py\0', push: { exitCode: 0, stderr: MR_STDERR } }) },
  })
  await begin($)
  const mark = w.git.length
  const result = await call($, 'share_changes', { message: 'Weekly report: add the run script\nwith more detail below' })
  expect(result).toBe('Shared flows to branch flow-share/ethan-bettenga/20261028-120000.\nMerge request: https://gitlab.com/org/flows/-/merge_requests/42')
  const argv = w.ran(FLOWS, mark)
  const pushAt = argv.findIndex(a => a[0] === 'push')
  expect(argv.slice(0, pushAt + 1)).toEqual([
    ['status', '--porcelain=v1', '-uall', '-z'],
    ['branch', '--show-current'],
    ['symbolic-ref', 'refs/remotes/origin/HEAD'],
    ['rev-list', '--left-right', '--count', 'HEAD...@{u}'],
    ['remote', 'get-url', 'origin'],
    ['pull', '--rebase', '--autostash', '--quiet'],
    ['add', '-A'],
    ['commit', '--quiet', '-m', 'Weekly report: add the run script\nwith more detail below\n\nShared from the flow hub.'],
    ['rev-parse', 'HEAD'],
    ['config', 'user.name'],
    [
      'push',
      '-o', 'merge_request.create',
      '-o', 'merge_request.target=main',
      '-o', 'merge_request.merge_when_pipeline_succeeds',
      '-o', 'merge_request.remove_source_branch',
      '-o', 'merge_request.title=Weekly report: add the run script',
      'origin',
      'HEAD:refs/heads/flow-share/ethan-bettenga/20261028-120000',
    ],
  ])
  // Never the default branch.
  expect(argv.some(a => a[0] === 'push' && a.some(x => /refs\/heads\/main$/.test(x)))).toBe(false)
  expect(w.store.get('pendingShares:local')).toEqual([
    {
      branch: 'flow-share/ethan-bettenga/20261028-120000',
      commit: 'c0ffee1',
      url: 'https://gitlab.com/org/flows/-/merge_requests/42',
      message: 'Weekly report: add the run script\nwith more detail below',
      at: NOW,
    },
  ])
  const status = JSON.parse(await call($, 'sync_status')) as { pending: { url?: string }[] }[]
  expect(status[0]?.pending.map(p => p.url)).toEqual(['https://gitlab.com/org/flows/-/merge_requests/42'])
})

test('share_changes: a long title is cut to 200 characters; a refused auto-merge is still a Share, with a note', async ($, on) => {
  const w = world(on, {
    files: { [`${FLOWS}/.git/HEAD`]: 'x', [`${FLOWS}/report/flow.yaml`]: GOOD_FLOW },
    repos: {
      [FLOWS]: repoOf({
        status: ' M report/flow.yaml\0',
        push: { exitCode: 0, stderr: `${MR_STDERR}\nremote: WARNINGS:\nremote: Could not set merge when pipeline succeeds: no pipeline` },
      }),
    },
  })
  await begin($)
  const mark = w.git.length
  const result = await call($, 'share_changes', { message: 'x'.repeat(250) })
  expect(result).toContain('Merge request: https://gitlab.com/org/flows/-/merge_requests/42')
  expect(result).toContain('Note: the merge request is open, but GitLab did not set it to merge on its own')
  const push = w.ran(FLOWS, mark).find(a => a[0] === 'push') ?? []
  expect(push).toContain(`merge_request.title=${'x'.repeat(200)}`)
})

test('share_changes: refuses a blank message, no changes, another branch, a remote that is not GitLab', async ($, on) => {
  const repo = repoOf({ status: ' M report/flow.yaml\0' })
  const w = world(on, { files: { [`${FLOWS}/.git/HEAD`]: 'x', [`${FLOWS}/report/flow.yaml`]: GOOD_FLOW }, repos: { [FLOWS]: repo } })
  await begin($)
  const mark = w.git.length
  expect(await call($, 'share_changes', { message: '   ' })).toBe('Not shared: write a message saying what changed')

  repo.branch = 'my-experiment'
  expect(await call($, 'share_changes', { message: 'x' })).toBe(
    'Not shared: Share works from main, and flows is on my-experiment: switch back to main first',
  )

  repo.branch = 'main'
  repo.remote = 'git@github.com:org/flows.git'
  expect(await call($, 'share_changes', { message: 'x' })).toBe('Not shared: Share needs a GitLab remote: origin is git@github.com:org/flows.git')

  repo.status = ''
  expect(await call($, 'share_changes', { message: 'x' })).toBe('Not shared: nothing to share, no repo has changes')
  expect(await call($, 'share_changes', { repo: 'local', message: 'x' })).toBe('Not shared: nothing to share: flows has no changes')
  expect(await call($, 'share_changes', { repo: 'nope', message: 'x' })).toBe('Not shared: no repo "nope" (local)')

  const ran = w.ran(FLOWS, mark).map(a => a[0])
  for (const verb of ['pull', 'add', 'commit', 'push']) expect(ran).not.toContain(verb)
})

test('share_changes: a failed push undoes the local commit with reset --soft and records nothing', async ($, on) => {
  const w = world(on, {
    files: { [`${FLOWS}/.git/HEAD`]: 'x', [`${FLOWS}/report/flow.yaml`]: GOOD_FLOW },
    repos: { [FLOWS]: repoOf({ status: ' M report/flow.yaml\0', push: { exitCode: 1, stderr: 'remote: You are not allowed to push code to this project.\nfatal: Could not read from remote repository.' } }) },
  })
  await begin($)
  const mark = w.git.length
  expect(await call($, 'share_changes', { message: 'Fix the report' })).toBe(
    'Not shared: push failed: fatal: Could not read from remote repository.; your changes are back as they were',
  )
  const argv = w.ran(FLOWS, mark)
  const pushAt = argv.findIndex(a => a[0] === 'push')
  expect(argv[pushAt + 1]).toEqual(['reset', '--soft', 'HEAD~1'])
  expect(w.store.get('pendingShares:local')).toBeUndefined()
})

test('share_changes: a pull that conflicts first aborts the rebase and shares nothing', async ($, on) => {
  const w = world(on, {
    files: { [`${FLOWS}/.git/HEAD`]: 'x', [`${FLOWS}/.git/rebase-merge/head-name`]: 'refs/heads/main', [`${FLOWS}/report/flow.yaml`]: GOOD_FLOW },
    repos: { [FLOWS]: repoOf({ status: ' M report/flow.yaml\0', pull: { exitCode: 1, stderr: 'error: could not apply 1a2b3c... mine\nhint: Resolve all conflicts manually\nCould not apply 1a2b3c... mine' } }) },
  })
  await begin($)
  const mark = w.git.length
  expect(await call($, 'share_changes', { message: 'Mine' })).toBe("Not shared: could not pull the team's changes first: Could not apply 1a2b3c... mine")
  const argv = w.ran(FLOWS, mark).map(a => a.join(' '))
  expect(argv).toContain('rebase --abort')
  expect(argv.some(a => a.startsWith('commit') || a.startsWith('push'))).toBe(false)
})

// ---------------------------------------------------------------------------
// Pull

test('pull_changes: rebases the flows folder and each source; a conflict aborts the rebase and is named', async ($, on) => {
  const flows = repoOf()
  const w = world(on, {
    files: { [`${FLOWS}/.git/HEAD`]: 'x', [`${FLOWS}/flows.yaml`]: SOURCES, [`${TEAM}/.git/HEAD`]: 'x', [`${TEAM}/.git/rebase-merge/head-name`]: 'x' },
    repos: {
      [FLOWS]: flows,
      [TEAM]: repoOf({ pull: { exitCode: 1, stderr: 'error: could not apply 9f8e7d... theirs\nhint: fix it\nCould not apply 9f8e7d... theirs' } }),
    },
  })
  await begin($)
  const mark = w.git.length
  expect(await call($, 'pull_changes')).toBe([`flows: pulled (${FLOWS})`, `Team: failed: Could not apply 9f8e7d... theirs (${TEAM})`].join('\n'))
  expect(w.ran(FLOWS, mark)).toContainEqual(['pull', '--rebase', '--autostash', '--quiet'])
  expect(w.ran(FLOWS, mark)).not.toContainEqual(['rebase', '--abort'])
  const team = w.ran(TEAM, mark)
  expect(team).toContainEqual(['rev-parse', '--git-path', 'rebase-merge'])
  expect(team.findIndex(a => a[0] === 'rebase')).toBeGreaterThan(team.findIndex(a => a[0] === 'pull'))
  expect(team).toContainEqual(['rebase', '--abort'])
  // The error stays in the status until a pull works.
  const status = JSON.parse(await call($, 'sync_status')) as { repo: string; error?: string }[]
  expect(status.find(s => s.repo === 'team')?.error).toBe('Could not apply 9f8e7d... theirs')
})

test('a pending Share is pruned once its commit is upstream', async ($, on) => {
  const flows = repoOf({ ahead: 1 })
  const pending = { branch: 'flow-share/ethan-bettenga/20261027-090000', commit: 'abc1234', url: 'https://gitlab.com/org/flows/-/merge_requests/7', message: 'Old', at: NOW - 86_400_000 }
  const w = world(on, { files: { [`${FLOWS}/.git/HEAD`]: 'x' }, repos: { [FLOWS]: flows }, store: { 'pendingShares:local': [pending] } })
  await begin($)
  let status = JSON.parse(await call($, 'sync_status')) as { pending: unknown[] }[]
  expect(status[0]?.pending).toHaveLength(1)
  expect(w.ran(FLOWS)).toContainEqual(['merge-base', '--is-ancestor', 'abc1234', 'refs/remotes/origin/main'])
  expect(w.ran(FLOWS)).toContainEqual(['cherry', 'refs/remotes/origin/main', 'abc1234', 'abc1234~1'])

  flows.merged = ['abc1234']
  expect(await call($, 'pull_changes')).toBe(`flows: pulled (${FLOWS})`)
  status = JSON.parse(await call($, 'sync_status')) as { pending: unknown[] }[]
  expect(status[0]?.pending).toEqual([])
  expect(w.store.get('pendingShares:local')).toEqual([])
})

// ---------------------------------------------------------------------------
// The background fetch

test('background fetch: one timer however many session starts; the first auto-pulls only a repo on its default branch', async ($, on) => {
  const w = world(on, {
    files: { [`${FLOWS}/.git/HEAD`]: 'x', [`${FLOWS}/flows.yaml`]: SOURCES, [`${TEAM}/.git/HEAD`]: 'x' },
    repos: { [FLOWS]: repoOf({ behind: 2 }), [TEAM]: repoOf({ branch: 'feature', behind: 3 }) },
  })
  await begin($)
  await begin($)
  await w.clock.settle()
  // Nothing at session start itself: the fetch waits a second.
  expect(w.git.filter(g => g.argv[0] === 'fetch')).toHaveLength(0)

  await w.clock.advance(1_000)
  const fetches = () => w.git.filter(g => g.argv[0] === 'fetch')
  expect(fetches().map(g => [g.cwd, ...g.argv])).toEqual([
    [FLOWS, 'fetch', '--quiet', '--prune'],
    [TEAM, 'fetch', '--quiet', '--prune'],
  ])
  const pulls = () => w.git.filter(g => g.argv[0] === 'pull')
  expect(pulls().map(g => g.cwd)).toEqual([FLOWS])

  await w.clock.advance(5 * 60_000)
  expect(fetches()).toHaveLength(4)
  // Later fetches never pull.
  expect(pulls()).toHaveLength(1)
})

// ---------------------------------------------------------------------------
// Default branch, worktrees, conflicts, old pending Shares

test('default branch: no origin/HEAD falls back to origin/main or origin/master; with neither, status says so and Share refuses', async ($, on) => {
  const flows = repoOf({ hasOriginHead: false, remoteBranches: ['master'], branch: 'master', status: ' M report/flow.yaml\0' })
  const w = world(on, { files: { [`${FLOWS}/.git/HEAD`]: 'x', [`${FLOWS}/report/flow.yaml`]: GOOD_FLOW }, repos: { [FLOWS]: flows } })
  await begin($)
  let status = JSON.parse(await call($, 'sync_status')) as { defaultBranch: string; error?: string }[]
  expect(status[0]).toMatchObject({ defaultBranch: 'master' })
  expect(status[0]?.error).toBeUndefined()
  expect(w.ran(FLOWS)).toContainEqual(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'])
  expect(w.ran(FLOWS)).toContainEqual(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master'])

  flows.remoteBranches = []
  status = JSON.parse(await call($, 'sync_status')) as { defaultBranch: string; error?: string }[]
  expect(status[0]?.error).toContain('cannot tell the default branch')
  const mark = w.git.length
  expect(await call($, 'share_changes', { message: 'x' })).toContain('Not shared: cannot tell the default branch')
  expect(w.ran(FLOWS, mark).map(a => a[0])).not.toContain('push')
})

test('default branch: the fetch runs remote set-head origin --auto once per repo when origin/HEAD is unset', async ($, on) => {
  const flows = repoOf({ hasOriginHead: false, remoteBranches: [], setHeadTo: 'develop', branch: 'develop', behind: 1 })
  const team = repoOf({ hasOriginHead: false, remoteBranches: ['main'] })
  const w = world(on, { files: { [`${FLOWS}/.git/HEAD`]: 'x', [`${FLOWS}/flows.yaml`]: SOURCES, [`${TEAM}/.git/HEAD`]: 'x' }, repos: { [FLOWS]: flows, [TEAM]: team } })
  await begin($)
  await w.clock.advance(1_000)
  const setHeads = (cwd: string) => w.ran(cwd).filter(a => a[0] === 'remote' && a[1] === 'set-head')
  expect(setHeads(FLOWS)).toEqual([['remote', 'set-head', 'origin', '--auto']])
  expect(setHeads(TEAM)).toHaveLength(1)
  // Re-read after: develop is the default, and the repo on it that is behind was pulled.
  const status = JSON.parse(await call($, 'sync_status')) as { repo: string; defaultBranch: string; error?: string }[]
  expect(status.find(s => s.repo === 'local')).toMatchObject({ defaultBranch: 'develop' })
  expect(status.find(s => s.repo === 'local')?.error).toBeUndefined()
  expect(w.ran(FLOWS).filter(a => a[0] === 'pull')).toHaveLength(1)
  // A failed set-head is not tried again; the next fetches do not repeat it.
  await w.clock.advance(5 * 60_000)
  expect(setHeads(FLOWS)).toHaveLength(1)
  expect(setHeads(TEAM)).toHaveLength(1)
})

test('pull: a rebase in a worktree (git dir elsewhere) is found through rev-parse --git-path and aborted', async ($, on) => {
  const gitDir = `${HOME}/main-clone/.git/worktrees/flows`
  const w = world(on, {
    files: { [`${FLOWS}/.git`]: `gitdir: ${gitDir}`, [`${gitDir}/rebase-merge/head-name`]: 'x' },
    repos: { [FLOWS]: repoOf({ gitDir, pull: { exitCode: 1, stderr: 'Could not apply 1a2b3c... mine' } }) },
  })
  await begin($)
  expect(await call($, 'pull_changes')).toBe(`flows: failed: Could not apply 1a2b3c... mine (${FLOWS})`)
  expect(w.ran(FLOWS)).toContainEqual(['rebase', '--abort'])
})

test('pull: files left in conflict by the autostash are named in the error', async ($, on) => {
  const w = world(on, {
    files: { [`${FLOWS}/.git/HEAD`]: 'x' },
    repos: {
      [FLOWS]: repoOf({
        status: 'UU report/flow.yaml\0AA digest/view.yaml\0 M notes.md\0',
        pull: { exitCode: 0, stderr: 'Applying autostash resulted in conflicts.\nYour changes are safe in the stash.' },
      }),
    },
  })
  await begin($)
  expect(await call($, 'pull_changes')).toBe(`flows: failed: conflicts in report/flow.yaml, digest/view.yaml: resolve them or ask Claude (${FLOWS})`)
  expect(w.ran(FLOWS)).toContainEqual(['status', '--porcelain=v1', '-z'])
})

test('a pending Share older than 14 days is dropped without asking git', async ($, on) => {
  const old = { branch: 'flow-share/a/20261001-090000', commit: 'old1', message: 'Old', at: NOW - 15 * 86_400_000 }
  const recent = { branch: 'flow-share/a/20261020-090000', commit: 'new1', message: 'Recent', at: NOW - 8 * 86_400_000 }
  const w = world(on, { files: { [`${FLOWS}/.git/HEAD`]: 'x' }, repos: { [FLOWS]: repoOf() }, store: { 'pendingShares:local': [old, recent] } })
  await begin($)
  const status = JSON.parse(await call($, 'sync_status')) as { pending: { message: string }[] }[]
  expect(status[0]?.pending.map(p => p.message)).toEqual(['Recent'])
  expect(w.store.get('pendingShares:local')).toEqual([recent])
  expect(w.ran(FLOWS).some(a => a.includes('old1'))).toBe(false)
})
