// The /flow-chart hub pane: the workflows (find, read, fill in and run one),
// their runs (a live step chart, logs, approvals, outputs) and everything
// Claude can use (workflows, skills, agents). Laid out after
// design/flow-chart-mockup.png; the terminal draws the same content as rows.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { ChartData, Found, HubAttempts, HubCatalog, HubEnv, HubForms, HubOpenResults, HubPicker, HubTab, InputSpec, Layout, LayoutGroup, Run, StepRun, StepSpec, Workflow } from '../types'
import { LOGO_TEXT_PARTS, logoSvg } from './brand'
import { MAX_RESULT_BYTES, SERIES, chartAlt, chartFromJson, chartFromTable, chartSvg, drawnPart, tableMarkdown, tableOf, textBars } from './charts'
import type { Table } from './charts'
import { findFolders, findOnMac, pastPicks, recentRunFiles, rememberPick, rememberedValues, type SuggestedFile } from './file-finder'
import {
  C,
  ICON,
  KIND,
  MARK,
  RUN_COLOR,
  ago,
  badgeOf,
  barSvg,
  barText,
  baseName,
  currentStep,
  dirName,
  discSvg,
  duration,
  expandHome,
  fileIconOf,
  fillOutputPath,
  firstLine,
  firstSentence,
  folderIconOf,
  itemAt,
  lastRunLine,
  linkTarget,
  loadCatalog,
  nowLine,
  outputCandidates,
  outputContext,
  outputSpecs,
  parseLogKey,
  plural,
  progressOf,
  shades,
  stepCounts,
  stepSub,
  strokeSvg,
  tildify,
  tint,
} from './hub-parts'
import { checkEnv, openHub, showRun, showWorkflow } from './hub-state'
import { SVG } from './icons'
import { agentsView } from './progress'
import { cancelRun, decideStep, refreshWorkflows, rerun, resumeRun, saveLayout, startRun } from './runner'
import { OTHER, addGroup, arrange, moveGroup, moveWorkflow, removeGroup, renameGroup, setGroup } from './layout'
import type { Section } from './layout'
import { STEP_KINDS, defaultValue, fill, inputProblems, isAIStep, stepLevels } from './spec'

type $ = EngineInterface

const PANE = 'flow-chart'
const MAX_PICKER_ROWS = 200
const LOG_LINES = 40
/** A summary shows this many lines; View opens the rest. */
const SUMMARY_LINES = 80
const SUMMARY_CHARS = 20_000

const EMPTY_CATALOG: HubCatalog = { skills: [], agents: [], mcp: [], at: 0 }

// The runner's atoms and hub-state.ts's, made again here: the scan reads an
// atom only where a const of the same file makes it (same keys, same tags).
const workflowsAtom = atom({ plugin: 'flow', key: 'workflows' } as const, [], { shape: 'workflows-1' })
const runsAtom = atom({ plugin: 'flow', key: 'runs' } as const, [], { shape: 'runs-1' })
// progress.tsx's subagent list, for the Agents tab's running count.
const agentsAtom = atom({ plugin: 'flow', key: 'progressAgents' } as const, [])
const hubTab = atom({ plugin: 'flow', key: 'hubTab' } as const, 'workflows' as HubTab, { shape: 'hub-tab-1' })
const hubWorkflow = atom({ plugin: 'flow', key: 'hubWorkflow' } as const, '', { shape: 'hub-workflow-1' })
const hubRun = atom({ plugin: 'flow', key: 'hubRun' } as const, '', { shape: 'hub-run-1' })
const hubForms = atom({ plugin: 'flow', key: 'hubForms' } as const, {} as HubForms, { shape: 'hub-forms-1' })
const hubPicker = atom({ plugin: 'flow', key: 'hubPicker' } as const, null as HubPicker | null, { shape: 'hub-picker-2' })
const hubQuery = atom({ plugin: 'flow', key: 'hubQuery' } as const, '', { shape: 'hub-query-1' })
const hubLogStep = atom({ plugin: 'flow', key: 'hubLogStep' } as const, '', { shape: 'hub-log-1' })
const hubFrame = atom({ plugin: 'flow', key: 'hubFrame' } as const, 0, { shape: 'hub-frame-1' })
const hubCatalog = atom({ plugin: 'flow', key: 'hubCatalog' } as const, EMPTY_CATALOG, { shape: 'hub-catalog-2' })
const hubEnv = atom({ plugin: 'flow', key: 'hubEnv' } as const, {} as HubEnv, { shape: 'hub-env-1' })
const hubAttempts = atom({ plugin: 'flow', key: 'hubAttempts' } as const, {} as HubAttempts, { shape: 'hub-attempts-1' })
const hubOpenResults = atom({ plugin: 'flow', key: 'hubOpenResults' } as const, {} as HubOpenResults, { shape: 'hub-open-results-1' })
const layoutAtom = atom({ plugin: 'flow', key: 'layout' } as const, { groups: [], errors: [] } as Layout, { shape: 'layout-1' })
/** The Workflows page in Arrange mode: groups and order can be changed. */
const hubArrange = atom({ plugin: 'flow', key: 'hubArrange' } as const, false, { shape: 'hub-arrange-1' })
/** Groups folded shut on the Workflows page, by title (this viewer's, not saved to flows.yaml). */
const hubFolded = atom({ plugin: 'flow', key: 'hubFolded' } as const, {} as Record<string, boolean>, { shape: 'hub-folded-1' })

// Module scope is fine here: registerHub sets these again on every (re)load.
let workflowsDir = '~/Documents/flows'
/** Each run's workflow.json, the steps it ran (a run's own copy never changes). */
const snapshots = new Map<string, Workflow>()
/** Results files read, by path, time and size: a running run draws every frame. */
const reads = new Map<string, string>()
const MAX_READS = 24

// ── actions ──────────────────────────────────────────────────────────────

async function refresh($: $): Promise<Found[]> {
  const found = await refreshWorkflows($)
  await checkEnv($, found).catch(() => undefined)
  return found
}

async function goTab($: $, tab: HubTab): Promise<void> {
  if (tab === 'workflows') await update($, hubWorkflow, () => '')
  if (tab === 'runs') await update($, hubRun, () => '')
  await update($, hubTab, () => tab)
  // The last list shows at once; the fresh one replaces it once read.
  if (tab === 'skills') await reloadCatalog($)
}

let isCatalogLoading = false

/** Reads the skills, agents and MCP servers again; an empty catalog still shows, never "Looking…" for good. */
async function reloadCatalog($: $): Promise<void> {
  if (isCatalogLoading) return
  isCatalogLoading = true
  try {
    const c = await loadCatalog($).catch(() => ({ ...EMPTY_CATALOG, at: Date.now() }))
    await update($, hubCatalog, () => c)
  } finally {
    isCatalogLoading = false
  }
}

async function workflowOfRun($: $, run: Run, found: Found[]): Promise<Workflow | undefined> {
  const hit = snapshots.get(run.id)
  if (hit) return hit
  const file = `${run.dir}/workflow.json`
  try {
    if (await $.fs.exists(file)) {
      const wf = JSON.parse(await $.fs.read(file)) as Workflow
      if (wf && Array.isArray(wf.steps) && Array.isArray(wf.inputs)) {
        snapshots.set(run.id, wf)
        return wf
      }
    }
  } catch {
    // Not readable: the workflow as it reads now.
  }
  return found.find(f => f.id === run.workflowId)?.workflow
}

/** A Results file's text, at most MAX_RESULT_BYTES, read again only once it changes. */
async function readResult($: $, abs: string): Promise<{ text?: string; problem?: string }> {
  const name = abs.split('/').pop() ?? abs
  const st = await $.fs.stat(abs).catch(() => undefined)
  if (!st || st.kind !== 'file') return { problem: `${name} is not a file` }
  if (st.size > MAX_RESULT_BYTES) return { problem: `${name} is over 2 MB` }
  const key = `${abs}\n${st.mtimeMs}\n${st.size}`
  const hit = reads.get(key)
  if (hit !== undefined) return { text: hit }
  const text = await $.fs.read(abs).catch(() => undefined)
  if (text === undefined) return { problem: `cannot read ${name}` }
  if (reads.size >= MAX_READS) reads.delete(reads.keys().next().value ?? '')
  reads.set(key, text)
  return { text }
}

// ── register ─────────────────────────────────────────────────────────────


export function registerHub(on: Parameters<Register>[0], options: Record<string, unknown>): void {
  workflowsDir = typeof options.workflowsDir === 'string' && options.workflowsDir.trim() ? options.workflowsDir.trim() : '~/Documents/flows'
  snapshots.clear()
  reads.clear()

  // The command is registered and the env checked from the runner's
  // session.start (hubSessionStart), and a run opens the pane from startRun.

  on('command.run', { command: 'flow-chart' }, async ($, e) => {
    const found = await refresh($)
    const id = (e.args ?? '').trim()
    const hit = id ? found.find(f => f.id === id && f.workflow) : undefined
    if (hit) await showWorkflow($, hit.id)
    await openHub($)
    return { text: id && !hit ? `Flow chart opened. There is no workflow "${id}".` : 'Flow chart opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Code, Markdown } = els
    const Input = 'Input' in els ? els.Input : undefined
    const Select = 'Select' in els ? els.Select : undefined
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const isDesktop = e.surface !== 'terminal'
    const width = Math.max(30, e.props.bodyColumns ?? 60)
    // The body in pixels, as progress.tsx reckons it; a card's inside is ~40 px less.
    const px = Math.max(160, Math.min(900, width * 8 - 8))
    const [agentList, found, runs, tab, wfId, runId, forms, picked, q, logKey, frame, catalog, env, attempts, openResults, layout, isArranging, folded] = await Promise.all([
      read($, agentsAtom),
      read($, workflowsAtom),
      read($, runsAtom),
      read($, hubTab),
      read($, hubWorkflow),
      read($, hubRun),
      read($, hubForms),
      read($, hubPicker),
      read($, hubQuery),
      read($, hubLogStep),
      read($, hubFrame),
      read($, hubCatalog),
      read($, hubEnv),
      read($, hubAttempts),
      read($, hubOpenResults),
      read($, layoutAtom),
      read($, hubArrange),
      read($, hubFolded),
    ])
    const now = await $.clock.now()
    const cwd = await $.session.cwd().catch(() => '')
    const home = ((await $.env.get('HOME').catch(() => undefined)) ?? '').replace(/\/+$/, '')
    const loaded = found.filter((f): f is Found & { workflow: Workflow } => Boolean(f.workflow))
    const active = runs.filter(r => r.status === 'running' || r.status === 'waiting')
    const agentsRunning = agentList.filter(a => a.status === 'running').length
    const gap = isDesktop ? 'md' : 1

    let body: RenderChildren[]
    const openWf = wfId ? loaded.find(f => f.id === wfId) : undefined
    const openRun = runId ? runs.find(r => r.id === runId) : undefined
    if (tab === 'workflows' && openWf) body = await workflowBoard(openWf)
    else if (tab === 'workflows') body = [runningCard(), tabsRow(), ...workflowsList()]
    else if (tab === 'runs' && openRun) body = [tabsRow(), ...(await runBoard(openRun))]
    else if (tab === 'runs') body = [tabsRow(), ...runsList()]
    else if (tab === 'agents') body = [tabsRow(), await agentsView($, e, true)]
    else {
      // Opened on this tab (a reload, a new session): nothing was read yet, so read it now.
      if (catalog.at === 0) void reloadCatalog($).catch(() => undefined)
      body = [tabsRow(), ...skillsList()]
    }

    const where =
      tab === 'workflows'
        ? openWf ? 'workflow' : plural(loaded.length, 'workflow')
        : tab === 'runs'
          ? openRun ? 'run' : active.length ? `${active.length} running` : plural(runs.length, 'run')
          : tab === 'agents'
            ? agentsRunning ? `${agentsRunning} running` : plural(agentList.length, 'agent')
            : 'skills'

    return (
      <Box flexDirection="column" gap={gap} width={width}>
        {brandHeader(where)}
        {body}
      </Box>
    )

    // flow's logo and name over every page, with where you are on the right.
    function brandHeader(sub: string) {
      if (!isDesktop)
        return (
          <Box flexDirection="row" gap={1}>
            <Text>{LOGO_TEXT_PARTS.map((d, i) => <Text key={`logo:${i}`} color={d.color}>{d.glyph}</Text>)}</Text>
            <Text bold>flow</Text>
            <Box flexGrow={1} />
            <Text dimColor>{sub}</Text>
          </Box>
        )
      return (
        <Box flexDirection="row" alignItems="center" gap={1} paddingBottom="xs">
          {Svg ? <Svg source={logoSvg(28, C.pane)} alt="flow logo" width={28} height={28} /> : null}
          <Text size="title" weight="bold">flow</Text>
          <Box flexGrow={1} />
          <Text dimColor size="footnote" weight="medium">{sub.toUpperCase()}</Text>
        </Box>
      )
    }

    // ── atoms of the look ──

    function card(key: string, children: RenderChildren[], look: { fill?: string; stroke?: string } = {}) {
      return (
        <Box
          key={key}
          flexDirection="column"
          borderStyle="round"
          borderColor={isDesktop ? (look.stroke ?? C.border) : 'gray'}
          backgroundColor={isDesktop ? (look.fill ?? C.card) : undefined}
          paddingX={isDesktop ? 2 : 1}
          paddingY={isDesktop ? 1 : 0}
          gap={isDesktop ? 'sm' : 0}
        >
          {children}
        </Box>
      )
    }

    function heading(left: string, right?: string) {
      return (
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Box flexShrink={1} minWidth={0} overflow="hidden">
            <Text size="footnote" weight="bold" dimColor wrap="truncate-end">{left.toUpperCase()}</Text>
          </Box>
          {right ? <Text size="footnote" weight="bold" dimColor wrap="truncate-start">{right.toUpperCase()}</Text> : null}
        </Box>
      )
    }

    function pill(text: string, color: string, bg = tint(color, '33'), size: 'caption' | 'footnote' = 'footnote') {
      return isDesktop
        ? <Text color={color} backgroundColor={bg} weight="semibold" size={size}>{` ${text} `}</Text>
        : <Text color={color} bold>{text}</Text>
    }

    /**
     * A row in the step chips' look: a coloured ● LABEL line (with whatever
     * sits right of it), a semibold title and a dim sub-line, in a rounded tile.
     */
    function tile(key: string, o: { color: string; label: string; right?: RenderChildren; title: RenderChildren; sub?: string; body?: RenderChildren; isLit?: boolean; fill?: string }) {
      if (!isDesktop)
        return (
          <Box key={key} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={o.color} bold>{`● ${o.label.toUpperCase()}`}</Text>
              <Box flexGrow={1} />
              {o.right ?? null}
            </Box>
            {o.title}
            {o.sub ? <Text dimColor wrap="truncate-end">{o.sub}</Text> : null}
            {o.body ?? null}
          </Box>
        )
      return (
        <Box
          key={key}
          flexDirection="column"
          paddingX={1}
          paddingY="xs"
          backgroundColor={o.fill ?? (o.isLit ? tint(o.color, '26') : C.chip)}
          borderStyle="round"
          borderColor={o.isLit ? o.color : C.border}
          minWidth={0}
          overflow="hidden"
          hover={{ backgroundColor: tint(o.color, '1f') }}
        >
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box flexShrink={1} minWidth={0} overflow="hidden">
              <Text color={o.color} size="caption" weight="bold" wrap="truncate-end">{`● ${o.label.toUpperCase()}`}</Text>
            </Box>
            <Box flexGrow={1} />
            {o.right ?? null}
          </Box>
          <Box minWidth={0} overflow="hidden">{o.title}</Box>
          {o.sub ? <Text dimColor size="footnote" wrap="truncate-end">{o.sub}</Text> : null}
          {o.body ?? null}
        </Box>
      )
    }

    function bar(pct: number, color: string) {
      return Svg
        ? <Svg source={barSvg(px - 40, pct, color)} alt={`${Math.round(pct * 100)}% done`} width={Math.max(1, Math.round(px - 40))} height={6} />
        : <Text color={color}>{barText(Math.max(10, width - 6), pct)}</Text>
    }

    function fileIcon(name: string, isDir: boolean) {
      const svg = SVG[isDir ? folderIconOf(name) : fileIconOf(name)]
      if (Svg && svg) return <Box width={2} flexShrink={0} justifyContent="center" alignItems="center"><Svg source={svg} alt={isDir ? 'folder' : badgeOf(name).label} width={16} height={16} /></Box>
      if (isDir) return <Text color={C.blue}>▢</Text>
      const b = badgeOf(name)
      return <Text color={b.color} bold>{b.label.padEnd(4)}</Text>
    }

    function note(key: string, glyph: string, text: string, color: string) {
      return isDesktop
        ? (
            <Box key={key} flexDirection="row" gap={1} paddingX={1} paddingY="xs" backgroundColor={tint(color, '1f')} alignItems="flex-start">
              <Text color={color} weight="bold">{glyph}</Text>
              <Box flexShrink={1} minWidth={0}><Text color={color}>{text}</Text></Box>
            </Box>
          )
        : <Text key={key} color={color}>{`${glyph} ${text}`}</Text>
    }

    function tabsRow() {
      return (
        <Box flexDirection="row" gap={1}>
          <Button key="tab:workflows" variant={tab === 'workflows' ? 'primary' : 'secondary'} onPress={() => void goTab($, 'workflows')}>Workflows</Button>
          <Button key="tab:runs" variant={tab === 'runs' ? 'primary' : 'secondary'} onPress={() => void goTab($, 'runs')}>{`Runs${active.length ? ` (${active.length})` : ''}`}</Button>
          <Button key="tab:agents" variant={tab === 'agents' ? 'primary' : 'secondary'} onPress={() => void goTab($, 'agents')}>{`Agents${agentsRunning ? ` (${agentsRunning})` : ''}`}</Button>
          <Button key="tab:skills" variant={tab === 'skills' ? 'primary' : 'secondary'} onPress={() => void goTab($, 'skills')}>Skills</Button>
        </Box>
      )
    }

    function statusPill(run: Run) {
      const color = RUN_COLOR[run.status]
      const label = run.status === 'running' ? `running${['...', '.  ', '.. ', '...'][frame % 4]}` : run.status
      return pill(label, color)
    }

    function fillPrompt(text: string) {
      void $.prompt.fill({ text, mode: 'replace' }).catch(() => undefined)
    }

    function clip(text: string, n: number) {
      const flat = text.replace(/\s+/g, ' ').trim()
      return flat.length > n ? `${flat.slice(0, Math.max(1, n - 1)).trimEnd()}…` : flat
    }

    // ── 1. Workflows ──

    function runningCard() {
      const run = active.find(r => !r.parent) ?? active[0]
      if (!run) return null
      const isWaiting = run.status === 'waiting' && !run.steps.some(s => s.status === 'running')
      const color = isWaiting ? C.dirty : C.read
      const p = progressOf(run)
      const wf = found.find(f => f.id === run.workflowId)?.workflow
      return card('now', [
        <Box flexDirection="row" gap={isDesktop ? 2 : 1} alignItems="center">
          {Svg ? <Svg source={discSvg(isWaiting ? ICON.clock : ICON.play, color)} alt="" width={40} height={40} /> : null}
          <Box flexDirection="column" flexShrink={1} minWidth={0} overflow="hidden">
            <Text size="footnote" weight="bold" color={color}>{isWaiting ? 'WAITING' : 'RUNNING NOW'}</Text>
            <Box flexShrink={1} minWidth={0} overflow="hidden">
              <Button key={`now:${run.id}`} plain onPress={() => void showRun($, run.id)}>
                <Text size="heading" weight="semibold" wrap="truncate-end">{run.title}</Text>
              </Button>
            </Box>
            <Text dimColor size="footnote" wrap="truncate-end">{nowLine(run, wf)}</Text>
          </Box>
        </Box>,
        bar(p.settled / p.total, color),
      ])
    }

    function workflowsList(): RenderChildren[] {
      const needle = q.trim().toLowerCase()
      const shown = loaded.filter(f => {
        if (!needle) return true
        const wf = f.workflow
        return [wf.title, wf.description, wf.id, ...wf.tags].some(s => s.toLowerCase().includes(needle))
      })
      const broken = found.filter(f => f.errors.length)
      const search = Input ? (
        <Box flexDirection="row" alignItems="center" gap={1} width="100%">
          {Svg ? <Svg source={strokeSvg(ICON.search, C.dim)} alt="search" width={16} height={16} /> : null}
          <Box flexGrow={1} width="100%">
            <Input key="hub-q" placeholder="Find a workflow or tag" value={q} onInput={(v: string) => void update($, hubQuery, () => v)} onSubmit={(v: string) => void update($, hubQuery, () => v)} />
          </Box>
          {q ? <Button key="hub-q-clear" plain onPress={() => void update($, hubQuery, () => '')}>✕</Button> : null}
        </Box>
      ) : null
      const arrangeButton = needle
        ? null
        : (
            isArranging
              ? <Button key="arrange" variant="primary" onPress={() => void update($, hubArrange, v => !v)}>Done</Button>
              : <Button key="arrange" plain onPress={() => void update($, hubArrange, v => !v)}>Arrange</Button>
          )
      const head = (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>{heading('Workflows', `${loaded.length} · ${workflowsDir}`)}</Box>
          {arrangeButton}
        </Box>
      )
      const problems = layout.errors.length
        ? card('layout-errors', [
            <Text size="footnote" weight="bold" color={C.del}>{`FLOWS.YAML HAS ${plural(layout.errors.length, 'PROBLEM')}`}</Text>,
            ...layout.errors.map((err, i) => <Text key={`lerr:${i}`} color={C.del} size="footnote">{err}</Text>),
          ], { fill: tint(C.del, '14'), stroke: tint(C.del, '66') })
        : null
      const sections = needle ? [{ title: '', isOther: true, items: shown }] : arrange(shown, layout.groups)
      const hasGroups = layout.groups.length > 0
      const body: RenderChildren[] = []
      for (const [si, sec] of sections.entries()) {
        // Without any groups the page is one list, as before, until a group is made.
        if (!needle && (hasGroups || isArranging)) body.push(groupHead(sec, si, sections.filter(x => !x.isOther).length))
        const isFolded = !needle && !isArranging && folded[sec.title] === true
        if (!isFolded) body.push(...sec.items.map((f, i) => workflowCard(f, isArranging && !needle ? { sec, index: i } : undefined)))
        if (!isFolded && !sec.items.length && (hasGroups || isArranging))
          body.push(<Text key={`empty:${sec.title}`} dimColor size="footnote">{sec.isOther ? 'Every workflow is in a group.' : 'No workflows yet: put one here with its group menu.'}</Text>)
      }
      return [
        search,
        head,
        problems,
        ...body,
        isArranging && !needle ? newGroupRow() : null,
        shown.length
          ? null
          : <Text dimColor>{needle ? `No workflow matches “${q.trim()}”` : `No workflows yet: add a folder with a flow.yaml to ${workflowsDir}.`}</Text>,
        broken.length
          ? card('errors', [
              <Text size="footnote" weight="bold" color={C.del}>{`${plural(broken.length, 'WORKFLOW')} DID NOT LOAD`}</Text>,
              ...broken.flatMap(f => f.errors.map((err, i) => <Text key={`err:${f.file}:${i}`} color={C.del} size="footnote">{`${tildify(f.file, home)}: ${err}`}</Text>)),
            ], { fill: tint(C.del, '14'), stroke: tint(C.del, '66') })
          : null,
      ]
    }

    // ── groups (flows.yaml) ──

    function edit(change: (groups: LayoutGroup[]) => LayoutGroup[]) {
      void saveLayout($, change(layout.groups)).catch(() => undefined)
    }

    /** A group's title line: fold it open or shut; in Arrange mode rename, move or remove it. */
    function groupHead(sec: Section<Found & { workflow: Workflow }>, index: number, groupCount: number) {
      const isFolded = folded[sec.title] === true
      const count = String(sec.items.length)
      if (!isArranging || sec.isOther)
        return (
          <Box key={`group:${sec.title}`} flexDirection="row" alignItems="center" gap={1} paddingTop={index ? 'sm' : 0}>
            <Button key={`fold:${sec.title}`} plain onPress={() => void update($, hubFolded, all => ({ ...all, [sec.title]: !isFolded }))}>
              <Text weight="bold" size={isDesktop ? 'heading' : undefined}>{`${isArranging ? '' : isFolded ? '▸ ' : '▾ '}${sec.title}`}</Text>
            </Button>
            <Text dimColor size="footnote">{count}</Text>
          </Box>
        )
      return (
        <Box key={`group:${sec.title}`} flexDirection="row" alignItems="center" gap={1} paddingTop={index ? 'sm' : 0}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            {Input
              ? <Input key={`gname:${sec.title}`} value={sec.title} placeholder="Group name" onSubmit={(v: string) => edit(g => renameGroup(g, sec.title, v))} />
              : <Text bold>{sec.title}</Text>}
          </Box>
          <Text dimColor size="footnote">{count}</Text>
          <Button key={`gup:${sec.title}`} plain onPress={() => edit(g => moveGroup(g, sec.title, -1))} disabled={index === 0}>↑</Button>
          <Button key={`gdown:${sec.title}`} plain onPress={() => edit(g => moveGroup(g, sec.title, 1))} disabled={index >= groupCount - 1}>↓</Button>
          <Button key={`gdel:${sec.title}`} plain onPress={() => edit(g => removeGroup(g, sec.title))}>Remove</Button>
        </Box>
      )
    }

    function newGroupRow() {
      if (!Input) return null
      return (
        <Box key="new-group" flexDirection="row" alignItems="center" gap={1}>
          <Text dimColor>+</Text>
          <Box flexGrow={1}>
            <Input key="new-group-name" value="" placeholder="New group: type a name, press Enter" onSubmit={(v: string) => edit(g => addGroup(g, v))} />
          </Box>
        </Box>
      )
    }

    /** A card's controls in Arrange mode: up and down within its group, and which group it is in. */
    function arrangeControls(f: Found & { workflow: Workflow }, at: { sec: Section<Found & { workflow: Workflow }>; index: number }) {
      const ids = at.sec.items.map(x => x.id)
      const titles = [...layout.groups.map(g => g.title), OTHER]
      const choose = (v: string) => edit(g => setGroup(g, f.id, v))
      return (
        <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
          {!at.sec.isOther
            ? [
                <Button key={`wup:${f.id}`} plain onPress={() => edit(g => moveWorkflow(g, f.id, ids, -1))} disabled={at.index === 0}>↑</Button>,
                <Button key={`wdown:${f.id}`} plain onPress={() => edit(g => moveWorkflow(g, f.id, ids, 1))} disabled={at.index >= ids.length - 1}>↓</Button>,
              ]
            : null}
          {Select && titles.length > 1
            ? <Select key={`grp:${f.id}`} value={at.sec.title} options={titles.map(t => ({ value: t }))} onSelect={choose} />
            : titles.filter(t => t !== at.sec.title).map(t => <Button key={`to:${f.id}:${t}`} plain onPress={() => choose(t)}>{`→ ${t}`}</Button>)}
        </Box>
      )
    }

    function kindChips(wf: Workflow) {
      if (!isDesktop)
        return (
          <Text>
            {wf.steps.map((s, i) => <Text key={`k:${i}`}>{i ? <Text dimColor>{' › '}</Text> : ''}<Text color={KIND[s.kind]}>{s.kind}</Text></Text>)}
          </Text>
        )
      return (
        <Box flexDirection="row" flexWrap="wrap" gap="xs" alignItems="center" flexShrink={1} minWidth={0}>
          {wf.steps.flatMap((s, i) => [
            i ? <Text dimColor size="caption">›</Text> : null,
            <Text color={KIND[s.kind]} backgroundColor={tint(KIND[s.kind], '26')} weight="semibold" size="caption">{` ${s.kind} `}</Text>,
          ])}
        </Box>
      )
    }

    function workflowCard(f: Found & { workflow: Workflow }, at?: { sec: Section<Found & { workflow: Workflow }>; index: number }) {
      const wf = f.workflow
      const last = lastRunLine(runs, wf.id, now)
      const { fixed, ai } = stepCounts(wf)
      const unset = wf.env.filter(n => env[n] === false)
      return card(`wf:${wf.id}`, [
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexShrink={1} minWidth={0} overflow="hidden">
            <Text size="heading" weight="semibold" wrap="truncate-end">{wf.title}</Text>
          </Box>
          {at ? arrangeControls(f, at) : <Button key={`run:${wf.id}`} variant="primary" onPress={() => void showWorkflow($, wf.id)}>Run</Button>}
        </Box>,
        wf.description ? <Text dimColor size="footnote">{clip(wf.description, Math.max(40, (width - 6) * 2))}</Text> : null,
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          {kindChips(wf)}
          <Text dimColor size="caption">{`${fixed} fixed · ${ai} AI`}</Text>
        </Box>,
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexDirection="row" gap={1} flexWrap="wrap" flexShrink={1} minWidth={0}>
            {wf.tags.map(t => (isDesktop ? pill(t, C.dim, C.tag) : <Text dimColor>{`#${t}`}</Text>))}
          </Box>
          <Text color={last.color} size="footnote" weight="medium">{last.text}</Text>
        </Box>,
        unset.length ? note(`env:${wf.id}`, '!', `Needs ${unset.join(', ')} in your environment`, C.dirty) : null,
      ])
    }

    // ── 2. Workflow board ──

    async function workflowBoard(f: Found & { workflow: Workflow }): Promise<RenderChildren[]> {
      const wf = f.workflow
      const { fixed, ai } = stepCounts(wf)
      const values = Object.fromEntries(wf.inputs.map(i => [i.id, valueOf(wf, i)]))
      const tried = attempts[wf.id]
      const problems = tried ? [...new Set([...inputProblems(wf, values), ...tried])] : []
      const doneRun = runs.find(r => r.workflowId === wf.id && r.status === 'done')
      const fields: RenderChildren[] = []
      for (const input of wf.inputs) fields.push(await field(f, input))
      return [
        <Box flexDirection="row">
          <Button key="back:workflows" plain onPress={() => void update($, hubWorkflow, () => '')}>
            <Text dimColor weight="medium">‹ Workflows</Text>
          </Button>
        </Box>,
        <Box flexDirection="column" gap="xs">
          <Text size="title" weight="semibold">{wf.title}</Text>
          <Text dimColor size="footnote">{[wf.owner, wf.tags.join(', '), `${fixed} fixed, ${ai} AI step${ai === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</Text>
          {wf.description ? <Markdown key={`desc:${wf.id}`} text={wf.description} /> : null}
        </Box>,
        chartCard(wf),
        wf.inputs.length ? card('inputs', [heading('Inputs', String(wf.inputs.length)), ...fields], {}) : null,
        problems.length ? <Box flexDirection="column" gap="xs">{problems.map((p, i) => note(`problem:${i}`, '!', p, C.dirty))}</Box> : null,
        wf.steps.some(s => s.kind === 'agent')
          ? note('agents-headless', 'i', 'Agent steps run a headless Claude with only the tools and folders the step lists: no commands, no MCP, writes only to the run folder (and its write: folders), stopped at its budget.', C.read)
          : null,
        wf.env.length
          ? (
              <Box flexDirection="column" gap="xs">
                {wf.env.map(n => (env[n] ? note(`envok:${n}`, '✓', `${n} is set`, C.add) : note(`envno:${n}`, '!', `${n} is not set`, C.dirty)))}
              </Box>
            )
          : null,
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="run-workflow" variant="primary" onPress={() => void runWorkflow(wf)}>Run workflow</Button>
          <Button key="ask-change" onPress={() => fillPrompt(`Change the flow workflow "${wf.title}" (${tildify(f.dir, home)}/flow.yaml): `)}>Ask Claude to change it</Button>
          {ai > 0 && doneRun
            ? (
                <Button
                  key="harden"
                  onPress={() => fillPrompt(`Harden the flow workflow "${wf.title}" using run ${doneRun.id}: replace AI steps that are mechanical with fixed python/mcp/http steps.`)}
                >
                  Make deterministic
                </Button>
              )
            : null}
        </Box>,
      ]
    }

    function valueOf(wf: Workflow, input: InputSpec): string {
      return forms[wf.id]?.[input.id] ?? defaultValue(input, new Date(now))
    }

    function setValue(wf: Workflow, inputId: string, value: string) {
      return update($, hubForms, all => ({ ...all, [wf.id]: { ...all[wf.id], [inputId]: value } }))
    }

    async function runWorkflow(wf: Workflow): Promise<void> {
      const values = Object.fromEntries(wf.inputs.map(i => [i.id, valueOf(wf, i)]))
      const own = inputProblems(wf, values)
      const { run, problems } = await startRun($, wf.id, values)
      if (!run) {
        await update($, hubAttempts, all => ({ ...all, [wf.id]: problems.filter(p => !own.includes(p)) }))
        return
      }
      await update($, hubAttempts, all => Object.fromEntries(Object.entries(all).filter(([k]) => k !== wf.id)))
      await showRun($, run)
    }

    function typeHint(input: InputSpec): string {
      switch (input.type) {
        case 'date':
        case 'number':
        case 'folder':
          return input.type
        case 'select':
          return input.multiple ? 'pick any' : 'pick one'
        case 'file':
          return [input.multiple ? 'files' : 'file', input.accept.join(' ')].filter(Boolean).join(' · ')
        default:
          return ''
      }
    }

    /**
     * A select that takes several values, or remembers them: a toggle per value
     * (its options, then what earlier runs used, then what is picked now) and a
     * field to add one. The value is the picked ones, one per line.
     */
    async function pickMany(wf: Workflow, input: InputSpec, value: string) {
      const picked = value.split('\n').map(v => v.trim()).filter(Boolean)
      const used = input.remember ? await rememberedValues($, wf.id, input.id) : []
      const choices = [...new Set([...input.options, ...used, ...picked])]
      const toggle = (v: string) =>
        void setValue(wf, input.id, input.multiple ? (picked.includes(v) ? picked.filter(x => x !== v) : [...picked, v]).join('\n') : picked.includes(v) ? '' : v)
      const add = (raw: string) => {
        const v = raw.trim()
        if (!v) return
        void setValue(wf, input.id, input.multiple ? [...picked.filter(x => x !== v), v].join('\n') : v)
      }
      return (
        <Box flexDirection="column" gap="xs">
          {choices.length
            ? (
                <Box flexDirection="row" gap={1} flexWrap="wrap">
                  {choices.map(v => (
                    <Button key={`opt:${wf.id}:${input.id}:${v}`} variant={picked.includes(v) ? 'primary' : 'secondary'} onPress={() => toggle(v)}>
                      {`${picked.includes(v) ? '✓ ' : ''}${v}`}
                    </Button>
                  ))}
                </Box>
              )
            : <Text dimColor size="footnote">Nothing used yet: add one below.</Text>}
          {Input
            ? <Input key={`add:${wf.id}:${input.id}`} value="" placeholder={input.multiple ? 'Add another, press Enter' : 'Or type one, press Enter'} onSubmit={add} />
            : null}
          {input.remember && used.length ? <Text dimColor size="caption">{`Remembers what each run uses · ${plural(used.length, 'saved value')}`}</Text> : null}
        </Box>
      )
    }

    async function field(f: Found & { workflow: Workflow }, input: InputSpec) {
      const wf = f.workflow
      const value = valueOf(wf, input)
      const key = `in:${wf.id}:${input.id}`
      const hint = typeHint(input)
      let control: RenderChildren
      switch (input.type) {
        case 'boolean':
          control = (
            <Box flexDirection="row" gap={1}>
              <Button key={`yes:${wf.id}:${input.id}`} variant={value === 'true' ? 'primary' : 'secondary'} onPress={() => void setValue(wf, input.id, 'true')}>Yes</Button>
              <Button key={`no:${wf.id}:${input.id}`} variant={value === 'true' ? 'secondary' : 'primary'} onPress={() => void setValue(wf, input.id, 'false')}>No</Button>
            </Box>
          )
          break
        case 'select':
          if (input.multiple || input.remember) {
            control = await pickMany(wf, input, value)
            break
          }
          if (input.options.length <= 6 || !Select)
            control = (
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                {input.options.map(o =>
                  isDesktop
                    ? (
                        <Button key={`opt:${wf.id}:${input.id}:${o}`} plain onPress={() => void setValue(wf, input.id, o)}>
                          <Text color={o === value ? C.blue : C.dim} backgroundColor={o === value ? tint(C.blue) : C.tag} weight="medium">{` ${o === value ? '✓ ' : ''}${o} `}</Text>
                        </Button>
                      )
                    : <Button key={`opt:${wf.id}:${input.id}:${o}`} variant={o === value ? 'primary' : 'secondary'} onPress={() => void setValue(wf, input.id, o)}>{o}</Button>,
                )}
              </Box>
            )
          else control = <Select key={key} value={value} options={input.options.map(o => ({ value: o }))} onSelect={(v: string) => void setValue(wf, input.id, v)} />
          break
        case 'file':
        case 'folder': {
          const isOpen = picked?.workflowId === wf.id && picked.inputId === input.id
          control = (
            <Box flexDirection="column" gap="xs">
              <Box flexDirection="row" gap={1} alignItems="center">
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  {Input
                    ? <Input key={key} value={value} placeholder={input.type === 'folder' ? 'A folder' : 'A file'} {...(input.multiple ? { rows: 3 } : {})} onInput={(v: string) => void setValue(wf, input.id, v)} onSubmit={(v: string) => void setValue(wf, input.id, v)} />
                    : <Text>{value || '—'}</Text>}
                </Box>
                <Button key={`browse:${wf.id}:${input.id}`} onPress={() => void browse(f, input, value, isOpen)}>{isOpen ? 'Done' : 'Choose…'}</Button>
              </Box>
              {isOpen && picked ? (picked.mode === 'browse' ? await picker(wf, input, value, picked.dir) : await suggestions(f, input, value, picked.query)) : null}
            </Box>
          )
          break
        }
        default:
          control = Input
            ? <Input key={key} value={value} placeholder={input.type === 'date' ? 'YYYY-MM-DD' : ''} {...(input.type === 'textarea' ? { rows: 3 } : {})} onInput={(v: string) => void setValue(wf, input.id, v)} onSubmit={(v: string) => void setValue(wf, input.id, v)} />
            : <Text>{value || '—'}</Text>
      }
      return (
        <Box key={`field:${input.id}`} flexDirection="column" gap="xs">
          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
            <Text weight="medium">{input.label}</Text>
            {hint ? <Text dimColor size="footnote">{hint}</Text> : null}
          </Box>
          {input.help ? <Text dimColor size="footnote">{input.help}</Text> : null}
          {control}
        </Box>
      )
    }

    async function browse(f: Found & { workflow: Workflow }, input: InputSpec, value: string, isOpen: boolean): Promise<void> {
      if (isOpen) {
        await update($, hubPicker, () => null)
        return
      }
      const first = expandHome(firstLine(value), home)
      let dir = f.dir
      if (first) {
        const candidate = input.type === 'folder' && !input.multiple ? first : dirName(first)
        if (candidate && (await $.fs.exists(candidate).catch(() => false))) dir = candidate
      }
      // Folders are found by browsing; files start from the suggestions.
      await update($, hubPicker, () => ({ workflowId: f.workflow.id, inputId: input.id, dir, mode: input.type === 'folder' && !input.contains?.length ? ('browse' as const) : ('suggest' as const), query: '' }))
    }

    function choose(wf: Workflow, input: InputSpec, value: string, abs: string) {
      void rememberPick($, wf.id, input.id, abs)
      if (!input.multiple) return setValue(wf, input.id, abs)
      const chosen = value.split('\n').map(v => expandHome(v.trim(), home)).filter(Boolean)
      const next = chosen.includes(abs) ? chosen.filter(c => c !== abs) : [...chosen, abs]
      return setValue(wf, input.id, next.join('\n'))
    }

    // Files that fit the input without clicking through folders: past picks,
    // what earlier runs made, then Spotlight's hits, each filtered by the search text.
    async function suggestions(f: Found & { workflow: Workflow }, input: InputSpec, value: string, query: string) {
      const wf = f.workflow
      const accept = input.accept
      const isFolder = input.type === 'folder'
      const contains = input.contains ?? []
      const [picks, fromRuns, onMac] = await Promise.all([
        pastPicks($, wf.id, input.id, accept, query, isFolder),
        isFolder ? Promise.resolve([]) : recentRunFiles($, home, accept, query),
        isFolder ? findFolders($, home, contains, query) : findOnMac($, home, accept, query),
      ])
      const seen = new Set<string>()
      const fresh = (list: SuggestedFile[]) => list.filter(x => !seen.has(x.path) && seen.add(x.path))
      const groups: Array<[string, SuggestedFile[]]> = [
        ['Picked before', fresh(picks)],
        ['From recent runs', fresh(fromRuns)],
        [isFolder ? `Folders with ${contains.join(' + ')}` : accept.length ? `On this Mac · ${accept.join(' ')}` : 'On this Mac', fresh(onMac)],
      ]
      const chosen = value.split('\n').map(v => expandHome(v.trim(), home)).filter(Boolean)
      const row = (file: SuggestedFile) => {
        const name = baseName(file.path)
        const isChosen = chosen.includes(file.path)
        const where = file.label ?? tildify(dirName(file.path), home)
        const icon = fileIcon(name, Boolean(file.isDir))
        return (
          <Box key={`sg:${file.source}:${file.path}`} flexDirection="row" alignItems="center" gap={1} paddingX={isDesktop ? 1 : 0} backgroundColor={isDesktop && isChosen ? tint(C.blue) : undefined}>
            {icon}
            <Box flexShrink={1} minWidth={0} overflow="hidden" flexGrow={1}>
              <Button key={`sp:${file.source}:${file.path}`} plain onPress={() => void choose(wf, input, value, file.path)}>
                <Text weight={isChosen ? 'semibold' : 'medium'} wrap="truncate-end">{`${isChosen && !isDesktop ? '✓ ' : ''}${name}`}</Text>
                <Text dimColor size="footnote" wrap="truncate-start">{`  ${where}`}</Text>
              </Button>
            </Box>
            <Box flexShrink={0}><Text dimColor size="footnote">{file.mtimeMs ? ago(file.mtimeMs, now) : ''}</Text></Box>
          </Box>
        )
      }
      const body: RenderChildren[] = []
      for (const [title, files] of groups) {
        if (!files.length) continue
        body.push(<Text key={`sgh:${title}`} dimColor size="caption" weight="bold">{title.toUpperCase()}</Text>)
        body.push(...files.map(row))
      }
      if (!body.length)
        body.push(<Text dimColor size="footnote">{query ? `No ${isFolder ? 'folder' : accept.join(' or ') || 'file'} matches “${query}”. Try Browse folders.` : 'Nothing found yet. Try Browse folders.'}</Text>)
      return (
        <Box key={`suggest:${input.id}`} flexDirection="column" borderStyle="round" borderColor={isDesktop ? C.border : 'gray'} backgroundColor={isDesktop ? C.field : undefined} paddingX={1} gap="xs">
          {Input
            ? <Input key={`fq:${wf.id}:${input.id}`} value={query} placeholder={isFolder ? 'Search projects by name' : `Search ${accept.join(' ') || 'files'} by name`} onInput={(v: string) => void update($, hubPicker, p => (p ? { ...p, query: v } : p))} onSubmit={(v: string) => void update($, hubPicker, p => (p ? { ...p, query: v } : p))} />
            : null}
          {body}
          <Box flexDirection="row" paddingTop="xs">
            <Button key={`tobrowse:${wf.id}:${input.id}`} onPress={() => void update($, hubPicker, p => (p ? { ...p, mode: 'browse' as const } : p))}>Browse folders</Button>
          </Box>
        </Box>
      )
    }

    async function picker(wf: Workflow, input: InputSpec, value: string, dir: string) {
      const entries = [...(await $.fs.list(dir).catch(() => []))]
        .filter(en => !en.name.startsWith('.'))
        .sort((a, b) => ((a.kind === 'dir') === (b.kind === 'dir') ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
      const chosen = value.split('\n').map(v => expandHome(v.trim(), home)).filter(Boolean)
      const join = (name: string) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`)
      const pick = (abs: string) => choose(wf, input, value, abs)
      const fits = (name: string) => input.type === 'file' && (!input.accept.length || input.accept.some(a => name.toLowerCase().endsWith(a.toLowerCase())))
      const rows: RenderChildren[] = entries.slice(0, MAX_PICKER_ROWS).map(en => {
        const abs = join(en.name)
        const isDir = en.kind === 'dir'
        const isPickable = isDir || fits(en.name)
        const isChosen = chosen.includes(abs)
        return (
          <Box key={`pr:${abs}`} flexDirection="row" alignItems="center" gap={1} paddingX={isDesktop ? 1 : 0} backgroundColor={isDesktop && isChosen ? tint(C.blue) : undefined}>
            {fileIcon(en.name, isDir)}
            <Box flexShrink={1} minWidth={0} overflow="hidden">
              {isPickable
                ? (
                    <Button key={`pick:${abs}`} plain onPress={() => void (isDir ? update($, hubPicker, p => (p ? { ...p, dir: abs } : p)) : pick(abs))}>
                      <Text wrap="truncate-end" weight={isChosen ? 'semibold' : 'regular'} color={isChosen ? C.text : undefined}>{`${isChosen && !isDesktop ? '✓ ' : ''}${en.name}${isDir ? '/' : ''}`}</Text>
                    </Button>
                  )
                : <Text color={C.faint} dimColor={!isDesktop} wrap="truncate-end">{en.name}</Text>}
            </Box>
          </Box>
        )
      })
      if (entries.length > MAX_PICKER_ROWS) rows.push(<Text dimColor size="footnote">{`… ${entries.length - MAX_PICKER_ROWS} more`}</Text>)
      if (!entries.length) rows.push(<Text dimColor size="footnote">Empty folder</Text>)
      return (
        <Box key={`picker:${input.id}`} flexDirection="column" borderStyle="round" borderColor={isDesktop ? C.border : 'gray'} backgroundColor={isDesktop ? C.field : undefined} paddingX={1} gap={0}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button key={`up:${wf.id}:${input.id}`} plain onPress={() => void update($, hubPicker, p => (p ? { ...p, dir: dirName(dir) || '/' } : p))}>
              <Text color={C.blue} weight="medium" size="footnote">‹ Up</Text>
            </Button>
            <Box flexShrink={1} minWidth={0} overflow="hidden" flexGrow={1}>
              <Text dimColor size="footnote" wrap="truncate-start">{tildify(dir, home)}</Text>
            </Box>
            {input.type === 'file' || input.contains?.length
              ? (
                  <Button key={`tosuggest:${wf.id}:${input.id}`} plain onPress={() => void update($, hubPicker, p => (p ? { ...p, mode: 'suggest' as const } : p))}>
                    <Text color={C.blue} weight="medium" size="footnote">Suggestions</Text>
                  </Button>
                )
              : null}
          </Box>
          {rows}
          {input.type === 'folder'
            ? (
                <Box flexDirection="row" paddingTop="xs">
                  <Button key={`usedir:${wf.id}:${input.id}`} variant="primary" onPress={() => void pick(dir)}>Use this folder</Button>
                </Box>
              )
            : null}
        </Box>
      )
    }

    // ── the step chart (workflow board and live run) ──

    function chartCard(wf: Workflow, run?: Run) {
      const levels = stepLevels(wf.steps)
      const kinds = STEP_KINDS.filter(k => wf.steps.some(s => s.kind === k))
      const chart = isDesktop
        ? (
            // Top to bottom, one row per level: steps that run together sit side
            // by side and wrap onto more rows rather than squeeze.
            <Box flexDirection="column" gap="xs">
              {levels.flatMap((level, i) => [
                i
                  ? (
                      <Box key={`arrow:${i}`} flexDirection="row" justifyContent="center">
                        <Text dimColor>↓</Text>
                      </Box>
                    )
                  : null,
                <Box key={`level:${i}`} flexDirection="row" flexWrap="wrap" gap="xs">
                  {level.map(s => (
                    <Box key={`cell:${s.id}`} flexGrow={1} flexShrink={0} minWidth={level.length > 1 ? 20 : 0} width={level.length > 1 ? undefined : '100%'}>
                      {chip(s, run)}
                    </Box>
                  ))}
                </Box>,
              ])}
            </Box>
          )
        : <Box flexDirection="column">{levels.flatMap((level, i) => level.map((s, j) => chipRow(s, run, j === 0 ? i + 1 : 0)))}</Box>
      return card(run ? 'run-chart' : 'chart', [
        heading('Steps', `${plural(wf.steps.length, 'step')} · ${plural(levels.length, 'level')}`),
        chart,
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          {kinds.map(k => (
            <Text key={`legend:${k}`} size="footnote" dimColor={!isDesktop}>
              <Text color={KIND[k]}>●</Text>
              <Text color={isDesktop ? C.dim : undefined}>{` ${k}`}</Text>
            </Text>
          ))}
        </Box>,
      ])
    }

    function chipState(spec: StepSpec, run?: Run) {
      const step = run?.steps.find(s => s.id === spec.id)
      const color = KIND[spec.kind]
      const status = step?.status
      const mark = status ? MARK[status] : undefined
      const sub = status === 'skipped' && step?.reason === 'condition' ? 'skipped (condition)' : stepSub(spec, step?.items?.length)
      const isSelected = run ? parseLogKey(selectedLogKey(run)).stepId === spec.id : false
      return {
        step,
        color,
        isRunning: status === 'running',
        isDim: status === 'skipped' || status === 'cancelled',
        mark: mark ? { glyph: mark.glyph, color: status === 'running' ? color : mark.color } : undefined,
        sub,
        isSelected,
        titleColor: status === 'running' ? shades(color)[frame % 4] : undefined,
      }
    }

    function chip(spec: StepSpec, run?: Run) {
      const s = chipState(spec, run)
      const kindLine = (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text color={s.color} size="caption" weight="bold">{`● ${spec.kind.toUpperCase()}`}</Text>
          {isAIStep(spec) ? pill('AI', s.color, tint(s.color, '26'), 'caption') : null}
          <Box flexGrow={1} />
          {s.mark ? <Text color={s.mark.color} weight="bold" size="footnote">{s.mark.glyph}</Text> : null}
        </Box>
      )
      // On a run, the title is a full-width press that shows that step's log,
      // live or not; the kind line keeps its colours (a Button's text is drawn
      // plain on desktop, so the coloured parts stay outside it).
      const body = (
        <Box flexDirection="column" minWidth={0} overflow="hidden">
          {kindLine}
          {run
            ? (
                <Box flexGrow={1} minWidth={0} overflow="hidden">
                  <Button key={`step:${spec.id}`} plain onPress={() => void update($, hubLogStep, () => spec.id)}>
                    <Text weight="semibold" color={s.titleColor} dimColor={s.isDim} wrap="truncate-end">{spec.title}</Text>
                  </Button>
                </Box>
              )
            : <Text weight="semibold" wrap="truncate-end">{spec.title}</Text>}
          {s.sub ? <Text dimColor size="footnote" wrap="truncate-end">{s.sub}</Text> : null}
        </Box>
      )
      return (
        <Box
          key={`chip:${spec.id}`}
          flexGrow={1}
          flexDirection="column"
          paddingX={1}
          paddingY="xs"
          backgroundColor={s.isRunning ? tint(s.color, '33') : s.isSelected ? tint(s.color, '1f') : C.chip}
          borderStyle="round"
          borderColor={s.isRunning || s.isSelected ? s.color : C.border}
          minWidth={0}
          overflow="hidden"
          hover={run ? { backgroundColor: tint(s.color, '26') } : undefined}
        >
          {body}
        </Box>
      )
    }

    function chipRow(spec: StepSpec, run: Run | undefined, level: number) {
      const s = chipState(spec, run)
      return (
        <Box key={`chip:${spec.id}`} flexDirection="row" gap={1}>
          <Text dimColor>{level ? String(level).padStart(2) : '  '}</Text>
          <Text color={s.mark?.color ?? s.color}>{s.mark?.glyph ?? '•'}</Text>
          <Text color={s.color} bold>{spec.kind.toUpperCase().padEnd(7)}</Text>
          <Box flexShrink={1} minWidth={0} overflow="hidden">
            {run
              ? (
                  <Button key={`step:${spec.id}`} plain onPress={() => void update($, hubLogStep, () => spec.id)}>
                    <Text bold={s.isSelected} color={s.titleColor} dimColor={s.isDim} wrap="truncate-end">{spec.title}</Text>
                    {isAIStep(spec) ? <Text color={s.color}>{' AI'}</Text> : ''}
                    {s.sub ? <Text dimColor wrap="truncate-end">{`  ${s.sub}`}</Text> : ''}
                  </Button>
                )
              : (
                  <Text wrap="truncate-end">
                    {spec.title}
                    {isAIStep(spec) ? <Text color={s.color}>{' AI'}</Text> : ''}
                    {s.sub ? <Text dimColor>{`  ${s.sub}`}</Text> : ''}
                  </Text>
                )}
          </Box>
        </Box>
      )
    }

    // ── 3. Runs ──

    function runsList(): RenderChildren[] {
      if (!runs.length) return [<Text dimColor>No runs yet. Open a workflow and press Run.</Text>]
      return [
        heading('Runs', String(runs.length)),
        <Box flexDirection="column" gap="xs">
          {runs.map(r => {
            const color = RUN_COLOR[r.status]
            const p = progressOf(r)
            return tile(`runrow:${r.id}`, {
              color,
              label: r.status === 'running' ? `running${['...', '.  ', '.. ', '...'][frame % 4]}` : r.status,
              isLit: r.status === 'running' || r.status === 'waiting',
              right: <Text dimColor size="footnote" tabular>{duration((r.endedAt ?? now) - r.startedAt)}</Text>,
              title: (
                <Button key={`open:${r.id}`} plain onPress={() => void showRun($, r.id)}>
                  <Text weight="semibold" wrap="truncate-end">{r.title}</Text>
                </Button>
              ),
              sub: [`started ${ago(r.startedAt, now)}`, `${p.settled} of ${p.total} steps`, r.parent ? 'child run' : ''].filter(Boolean).join(' · '),
              body: (
                <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
                  <Box flexShrink={1} minWidth={0} overflow="hidden">
                    <Text size="footnote" color={r.status === 'failed' || r.status === 'waiting' ? color : undefined} dimColor={r.status !== 'failed' && r.status !== 'waiting'} wrap="truncate-end">{runOutcome(r)}</Text>
                  </Box>
                  <Text size="footnote">
                    {r.steps.map(s => <Text key={`m:${r.id}:${s.id}`} color={s.status === 'running' ? color : MARK[s.status].color}>{MARK[s.status].glyph}</Text>)}
                  </Text>
                </Box>
              ),
            })
          })}
        </Box>,
      ]
    }

    /** One line on how a run went: where it stopped and why, or what it is doing. */
    function runOutcome(r: Run): string {
      const at = (st: StepRun) => st.id.replace(/[_-]+/g, ' ')
      const failed = r.steps.find(s => s.status === 'failed')
      if (failed) {
        const why = firstLine(failed.error ?? '') || firstLine(failed.tail.trim().split('\n').slice(-1)[0] ?? '')
        return `failed at ${at(failed)}${why ? `: ${why}` : ''}`
      }
      const waiting = r.steps.find(s => s.status === 'waiting')
      if (waiting) return `waiting at ${at(waiting)}`
      const going = r.steps.find(s => s.status === 'running')
      if (going) return `running ${at(going)}`
      if (r.status === 'done') return `${plural(r.steps.filter(s => s.status === 'done').length, 'step')} done · run ${r.id}`
      return `run ${r.id}`
    }

    /** The log shown: the chosen step or item, else what is going now, else what ended last. */
    function selectedLogKey(run: Run): string {
      if (logKey) {
        const { stepId, index } = parseLogKey(logKey)
        const step = run.steps.find(s => s.id === stepId)
        if (step && (index === undefined || step.items?.[index])) return logKey
      }
      const going = currentStep(run)
      if (going) {
        const i = going.items?.findIndex(it => it.status === 'running') ?? -1
        return i >= 0 ? `${going.id}[${i}]` : going.id
      }
      const ended = run.steps.filter(s => s.startedAt).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]
      return ended?.id ?? run.steps[0]?.id ?? ''
    }

    async function runBoard(run: Run): Promise<RenderChildren[]> {
      const wf = await workflowOfRun($, run, found)
      const p = progressOf(run)
      const isActive = run.status === 'running' || run.status === 'waiting'
      const firstInput = wf?.inputs.find(i => (run.inputs[i.id] ?? '').trim())
      const inputText = firstInput ? `${(firstInput.label.split(/\s+/)[0] ?? '').toLowerCase()} ${clip(firstLine(run.inputs[firstInput.id] ?? ''), 40)}` : ''
      const specOf = (id: string) => wf?.steps.find(s => s.id === id)
      const key = selectedLogKey(run)
      const parts: RenderChildren[] = [
        <Box flexDirection="row">
          <Button key="back:runs" plain onPress={() => void update($, hubRun, () => '')}>
            <Text dimColor weight="medium">‹ Runs</Text>
          </Button>
        </Box>,
        card('run-head', [
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Box flexShrink={1} minWidth={0} overflow="hidden">
              <Text size="heading" weight="semibold" wrap="truncate-end">{run.title}</Text>
            </Box>
            {statusPill(run)}
          </Box>,
          <Text dimColor size="footnote" wrap="truncate-end">{[`Run ${run.id}`, `started ${ago(run.startedAt, now)}`, inputText].filter(Boolean).join(' · ')}</Text>,
          bar(p.settled / p.total, RUN_COLOR[run.status]),
        ]),
      ]
      if (wf) parts.push(chartCard(wf, run))

      // for each
      const sel = parseLogKey(key).stepId
      const feSpec =
        wf?.steps.find(s => s.forEach !== undefined && s.id === sel && run.steps.find(r => r.id === s.id)?.items?.length) ??
        wf?.steps.find(s => s.forEach !== undefined && run.steps.find(r => r.id === s.id)?.status === 'running' && run.steps.find(r => r.id === s.id)?.items?.length)
      const feStep = feSpec && run.steps.find(s => s.id === feSpec.id)
      if (feSpec && feStep?.items) {
        const color = KIND[feSpec.kind]
        const done = feStep.items.filter(i => i.status === 'done').length
        parts.push(
          card('for-each', [
            heading(`${feSpec.title} · for each ${feSpec.as ?? 'item'}`, `${done} of ${feStep.items.length}`),
            ...feStep.items.map((it, i) => {
              const isRunning = it.status === 'running'
              const mark = MARK[it.status]
              const right = isRunning
                ? feSpec.kind === 'agent' || feSpec.kind === 'claude' ? 'writing…' : 'running…'
                : it.status === 'pending'
                  ? 'queued'
                  : it.startedAt && it.endedAt
                    ? duration(it.endedAt - it.startedAt)
                    : it.status
              const itemKey = `${feSpec.id}[${i}]`
              return tile(`item:${itemKey}`, {
                color,
                label: `${feSpec.as ?? 'item'} ${i + 1}`,
                isLit: isRunning || key === itemKey,
                right: (
                  <Box flexDirection="row" gap={1} alignItems="center">
                    <Text color={isRunning ? color : undefined} dimColor={!isRunning} size="footnote" weight="medium">{right}</Text>
                    <Text color={isRunning ? color : mark.color} weight="bold" size="footnote">{mark.glyph}</Text>
                  </Box>
                ),
                title: (
                  <Button key={`itm:${itemKey}`} plain onPress={() => void update($, hubLogStep, () => itemKey)}>
                    <Text weight="semibold" wrap="truncate-end">{firstLine(it.value) || `item ${i + 1}`}</Text>
                  </Button>
                ),
              })
            }),
          ]),
        )
      }

      // log
      const { stepId, index } = parseLogKey(key)
      const logStep = run.steps.find(s => s.id === stepId)
      if (logStep) {
        const item = itemAt(logStep, index)
        const rec = item ?? logStep
        const isLive = rec.status === 'running' || rec.status === 'waiting'
        const lines = rec.tail.replace(/\s+$/, '').split('\n')
        const tail = lines.slice(-LOG_LINES).join('\n')
        parts.push(
          card('log', [
            heading(`Log · ${specOf(stepId)?.title ?? stepId}${item ? ` · ${firstLine(item.value)}` : ''}`, isLive ? 'live' : ''),
            tail.trim() ? <Code key="log-tail" source={tail} wrap="truncate-end" /> : <Text dimColor size="footnote">{rec.status === 'pending' ? 'Not started yet' : 'No output yet'}</Text>,
            rec.startedAt ? <Markdown key="log-full" text={`[Full log](${linkTarget(`${run.dir}/${key}.log`, cwd)})`} /> : null,
          ], { fill: isDesktop ? C.log : undefined }),
        )
      }

      // waiting on Claude (an approval waits in Results)
      for (const s of run.steps) {
        if (s.status !== 'waiting') continue
        const spec = specOf(s.id)
        if (spec?.kind === 'claude') {
          parts.push(
            card(`claude:${s.id}`, [
              <Text size="footnote" weight="bold" color={C.edit}>WAITING FOR CLAUDE</Text>,
              <Text weight="semibold">{`Claude is working on ${spec.title}`}</Text>,
            ], { fill: tint(C.edit, '14'), stroke: tint(C.edit, '66') }),
          )
        }
      }

      if (wf) parts.push(await resultsCard(run, wf))

      // outputs
      const outs: { rel: string; abs: string }[] = []
      if (wf)
        for (const rel of outputCandidates(run, wf)) {
          const abs = `${run.dir}/${rel}`
          if (await $.fs.exists(abs).catch(() => false)) outs.push({ rel, abs })
        }
      parts.push(
        card('outputs', [
          heading('Files', isActive ? `${outs.length} so far` : String(outs.length)),
          ...outs.map(o => (
            <Box key={`out:${o.rel}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
              <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0} overflow="hidden">
                {fileIcon(baseName(o.rel), false)}
                <Text wrap="truncate-end">{o.rel}</Text>
              </Box>
              <Markdown key={`view:${o.rel}`} text={`[View](${linkTarget(o.abs, cwd)})`} />
            </Box>
          )),
          outs.length ? null : <Text dimColor size="footnote">{isActive ? 'Nothing yet' : 'No output files'}</Text>,
          <Markdown key="run-folder" text={`[Open run folder](${linkTarget(run.dir, cwd)})`} />,
        ]),
      )

      // actions
      const rerunProblems = attempts[`rerun:${run.id}`] ?? []
      parts.push(
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {isActive ? <Button key="cancel-run" onPress={() => void cancelRun($, run.id)}>Cancel run</Button> : null}
          {run.status === 'interrupted' ? <Button key="resume-run" variant="primary" onPress={() => void resumeRun($, run.id)}>Resume</Button> : null}
          <Button key="rerun" onPress={() => void again(run)}>Re-run with same inputs</Button>
        </Box>,
        ...rerunProblems.map((p, i) => note(`rerun-problem:${i}`, '!', p, C.dirty)),
      )
      return parts
    }

    // ── the run's Results: approvals, summaries, charts, tables ──

    async function resultsCard(run: Run, wf: Workflow): Promise<RenderChildren> {
      const ctx = outputContext(run)
      const specs = outputSpecs(wf)
      const declared = new Map<string, (typeof specs)[number]>()
      for (const o of specs) {
        const rel = fillOutputPath(o.file, ctx)
        if (rel && !declared.has(rel)) declared.set(rel, o)
      }
      const summaries: { rel: string; abs: string; text?: string; problem?: string }[] = []
      const tables: { rel: string; abs: string; table?: Table; problem?: string }[] = []
      const charts: { key: string; title: string; abs?: string; data?: ChartData; problem?: string }[] = []
      for (const rel of outputCandidates(run, wf)) {
        const abs = `${run.dir}/${rel}`
        const ext = (rel.split('.').pop() ?? '').toLowerCase()
        const chart = declared.get(rel)?.chart
        const isMd = ext === 'md' || ext === 'markdown'
        if (!isMd && !chart && ext !== 'csv' && ext !== 'tsv') continue
        if (!(await $.fs.exists(abs).catch(() => false))) continue
        const got = await readResult($, abs)
        if (isMd) summaries.push({ rel, abs, ...got })
        else if (chart) {
          const title = declared.get(rel)?.title || baseName(rel)
          const parsed = got.text === undefined ? { problem: got.problem } : tableOf(got.text, rel)
          const made = parsed.table ? chartFromTable(parsed.table, chart, title) : { problem: parsed.problem }
          charts.push({ key: `out:${rel}`, title, abs, ...made })
        } else {
          const parsed = got.text === undefined ? { problem: got.problem } : tableOf(got.text, rel)
          tables.push({ rel, abs, ...parsed })
        }
      }
      // `*.chart.json` files the run wrote (flow.chart), top level only.
      const listed = [...(await $.fs.list(run.dir).catch(() => []))].filter(en => en.kind === 'file' && en.name.endsWith('.chart.json')).sort((a, b) => a.name.localeCompare(b.name))
      for (const en of listed) {
        const abs = `${run.dir}/${en.name}`
        const name = en.name.replace(/\.chart\.json$/, '')
        const got = await readResult($, abs)
        charts.push({ key: `json:${en.name}`, title: name, abs, ...(got.text === undefined ? { problem: got.problem } : chartFromJson(got.text, name)) })
      }
      const approvals = wf.steps.filter(s => s.kind === 'approve')

      // Summaries and tables fold; all but the first two start folded.
      const blocks = [...summaries.map(x => x.rel), ...tables.map(x => x.rel)]
      const folded = openResults[run.id] ?? blocks.slice(2)
      const isOpen = (rel: string) => !folded.includes(rel)
      const toggle = (rel: string) =>
        void update($, hubOpenResults, all => {
          const cur = all[run.id] ?? blocks.slice(2)
          return { ...all, [run.id]: cur.includes(rel) ? cur.filter(r => r !== rel) : [...cur, rel] }
        })

      const sections: RenderChildren[] = []
      const section = (title: string, count: number) => <Text key={`rsec:${title}`} size="caption" weight="bold" dimColor>{`${title.toUpperCase()}${count > 1 ? ` · ${count}` : ''}`}</Text>
      if (approvals.length) sections.push(section('Approvals', approvals.length), ...approvals.map(spec => approvalRow(run, spec, run.steps.find(s => s.id === spec.id))))
      if (summaries.length) sections.push(section('Summaries', summaries.length), ...summaries.map(x => summaryBlock(x, isOpen(x.rel), toggle)))
      if (charts.length) sections.push(section('Charts', charts.length), ...charts.map(chartBlock))
      if (tables.length) sections.push(section('Tables', tables.length), ...tables.map(x => tableBlock(x, isOpen(x.rel), toggle)))
      if (!sections.length) return null
      return card('results', [heading('Results'), ...sections])
    }

    function viewLink(key: string, abs: string) {
      return <Markdown key={key} text={`[View](${linkTarget(abs, cwd)})`} />
    }

    /** A folding block's head: ▾/▸ and the file (one press), its View link. */
    function blockHead(rel: string, abs: string, isOpen: boolean, toggle: (rel: string) => void) {
      return (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0} overflow="hidden">
            {fileIcon(baseName(rel), false)}
            <Box flexShrink={1} minWidth={0} overflow="hidden">
              <Button key={`res:${rel}`} plain onPress={() => toggle(rel)}>
                <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
                <Text weight="semibold" wrap="truncate-end">{rel}</Text>
              </Button>
            </Box>
          </Box>
          {viewLink(`rview:${rel}`, abs)}
        </Box>
      )
    }

    function summaryBlock(x: { rel: string; abs: string; text?: string; problem?: string }, isOpen: boolean, toggle: (rel: string) => void) {
      const lines = (x.text ?? '').replace(/\s+$/, '').split('\n')
      let shown = lines.slice(0, SUMMARY_LINES).join('\n')
      if (shown.length > SUMMARY_CHARS) shown = shown.slice(0, SUMMARY_CHARS)
      const shownLines = shown.split('\n').length
      const more = lines.length - shownLines
      return (
        <Box key={`sum:${x.rel}`} flexDirection="column" gap="xs" paddingX={isDesktop ? 1 : 0} paddingY={isDesktop ? 'xs' : 0} backgroundColor={isDesktop ? C.tile : undefined}>
          {blockHead(x.rel, x.abs, isOpen, toggle)}
          {isOpen && x.problem ? <Text dimColor size="footnote">{x.problem}</Text> : null}
          {isOpen && !x.problem && !shown.trim() ? <Text dimColor size="footnote">Empty file</Text> : null}
          {isOpen && shown.trim() ? <Markdown key={`md:${x.rel}`} text={shown} /> : null}
          {isOpen && more > 0 ? <Text dimColor size="footnote">{`… ${plural(more, 'more line')}, View for all`}</Text> : null}
        </Box>
      )
    }

    function tableBlock(x: { rel: string; abs: string; table?: Table; problem?: string }, isOpen: boolean, toggle: (rel: string) => void) {
      const t = x.table
      return (
        <Box key={`tbl:${x.rel}`} flexDirection="column" gap="xs" paddingX={isDesktop ? 1 : 0} paddingY={isDesktop ? 'xs' : 0} backgroundColor={isDesktop ? C.tile : undefined}>
          {blockHead(x.rel, x.abs, isOpen, toggle)}
          {t ? <Text dimColor size="footnote">{`${plural(t.rows.length, 'row')} × ${plural(t.header.length, 'column')}`}</Text> : <Text dimColor size="footnote">{`table: ${x.problem ?? 'unreadable'}`}</Text>}
          {isOpen && t && t.header.length ? <Markdown key={`tblmd:${x.rel}`} text={tableMarkdown(t)} /> : null}
        </Box>
      )
    }

    function chartBlock(c: { key: string; title: string; abs?: string; data?: ChartData; problem?: string }) {
      const drawn = c.data ? drawnPart(c.data) : undefined
      const w = Math.max(160, Math.round(px - 40))
      let body: RenderChildren
      if (!drawn) body = <Text dimColor size="footnote">{`chart: ${c.problem ?? 'nothing to draw'}`}</Text>
      else if (Svg) body = <Svg source={chartSvg(drawn.data, w)} alt={chartAlt(drawn.data)} width={w} isInteractive />
      else {
        const { rows, left } = textBars(drawn.data, Math.max(20, width - 4))
        body = (
          <Box flexDirection="column">
            {drawn.data.series.length > 1
              ? (
                  <Text>
                    {drawn.data.series.map((s, j) => <Text key={`lg:${c.key}:${j}`}>{j ? '  ' : ''}<Text color={SERIES[j]}>■</Text>{` ${s.name}`}</Text>)}
                  </Text>
                )
              : null}
            {rows.map((r, i) => (
              <Text key={`tb:${c.key}:${i}`}>
                {`${r.label} `}
                <Text color={r.color}>{r.bar}</Text>
                {` ${r.value}`}
              </Text>
            ))}
            {left ? <Text dimColor>{`… ${left} more ${drawn.data.type === 'line' ? 'earlier' : ''}`.trimEnd()}</Text> : null}
          </Box>
        )
      }
      const sub = drawn?.data.yLabel
      return (
        <Box key={`chart:${c.key}`} flexDirection="column" gap="xs">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Box flexDirection="column" flexShrink={1} minWidth={0} overflow="hidden">
              <Text weight="semibold" wrap="truncate-end">{drawn?.data.title ?? c.title}</Text>
              {sub ? <Text dimColor size="footnote" wrap="truncate-end">{sub}</Text> : null}
            </Box>
            {c.abs ? viewLink(`cview:${c.key}`, c.abs) : null}
          </Box>
          {body}
          {drawn?.left.map((l, i) => <Text key={`left:${c.key}:${i}`} dimColor size="footnote">{l}</Text>)}
        </Box>
      )
    }

    /** One approve step: its question, the decision, when, the note, and Approve / Reject while it waits. */
    function approvalRow(run: Run, spec: StepSpec, step: StepRun | undefined) {
      const status = step?.status ?? 'pending'
      const decision =
        status === 'done' ? { label: 'approved', color: C.add }
          : status === 'failed' ? { label: 'rejected', color: C.del }
            : status === 'waiting' ? { label: 'waiting', color: C.dirty }
              : status === 'cancelled' ? { label: 'cancelled', color: C.dim }
                : { label: 'not reached', color: C.dim }
      const isWaiting = status === 'waiting'
      const filled = fill(spec.body, outputContext(run)).trim()
      const tail = (step?.tail ?? '').trim()
      const logFirst = firstLine(tail)
      const question = !step?.startedAt || !logFirst || firstLine(filled) === logFirst ? filled || logFirst : isWaiting ? tail : logFirst
      const isDecided = status === 'done' || status === 'failed'
      const output = (step?.output ?? '').trim()
      const remark = isDecided && output && output !== 'approved' && output !== 'rejected' ? output : ''
      const when = isDecided && step?.endedAt ? ago(step.endedAt, now) : isWaiting && step?.startedAt ? `asked ${ago(step.startedAt, now)}` : ''
      return tile(`appr:${spec.id}`, {
        color: decision.color,
        label: isWaiting ? `waiting for you · ${spec.title}` : `${decision.label} · ${spec.title}`,
        isLit: isWaiting,
        right: when ? <Text dimColor size="footnote">{when}</Text> : undefined,
        title: <Text weight="semibold" dimColor={status === 'pending' || status === 'skipped' || status === 'cancelled'}>{question}</Text>,
        sub: remark ? `Note: ${remark}` : undefined,
        body: isWaiting
          ? (
              <Box flexDirection="row" gap={1} paddingTop="xs">
                <Button key={`approve:${spec.id}`} variant="primary" onPress={() => void decideStep($, run.id, spec.id, true)}>Approve</Button>
                <Button key={`reject:${spec.id}`} onPress={() => void decideStep($, run.id, spec.id, false)}>Reject</Button>
              </Box>
            )
          : undefined,
      })
    }

    async function again(run: Run): Promise<void> {
      const { run: id, problems } = await rerun($, run.id)
      await update($, hubAttempts, all => {
        const next = { ...all }
        if (id) delete next[`rerun:${run.id}`]
        else next[`rerun:${run.id}`] = problems
        return next
      })
      if (id) await showRun($, id)
    }

    // ── 4. Skills ──

    function skillsList(): RenderChildren[] {
      const servers = catalog.mcp ?? []
      const total = loaded.length + catalog.skills.length + catalog.agents.length + servers.length
      const isLoading = catalog.at === 0
      const use = (text: string) => () => fillPrompt(text)
      type Row = { key: string; name: string; description: string; onPress: () => void }
      // Each section folds shut from its title line (this viewer's, kept for the session).
      const group = (title: string, color: string, kind: string, label: string, items: Row[], wait = false) => {
        const foldKey = `skills:${title}`
        const isFolded = folded[foldKey] === true
        const count = wait ? '' : String(items.length)
        const head = (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Button key={`fold:${foldKey}`} plain onPress={() => void update($, hubFolded, all => ({ ...all, [foldKey]: !isFolded }))}>
                <Text size="footnote" weight="bold" dimColor>{`${isFolded ? '▸' : '▾'} ${title.toUpperCase()}`}</Text>
              </Button>
            </Box>
            <Text size="footnote" weight="bold" dimColor>{count}</Text>
          </Box>
        )
        return card(`group:${title}`, [
          head,
          ...(isFolded
            ? []
            : items.length
              ? items.map(it =>
                  tile(`row:${it.key}`, {
                    color,
                    label: kind,
                    right: isDesktop ? <Button key={`use:${it.key}`} plain onPress={it.onPress}>{label}</Button> : <Button key={`use:${it.key}`} onPress={it.onPress}>{label}</Button>,
                    title: <Text weight="semibold" wrap="truncate-end">{it.name}</Text>,
                    sub: it.description,
                  }),
                )
              : [<Text dimColor size="footnote">{wait ? 'Looking…' : 'None found'}</Text>]),
        ])
      }
      const serverRow = (m: { name: string; tools: string[] }): Row => ({
        key: `mcp:${m.name}`,
        name: m.name,
        description: `${plural(m.tools.length, 'tool')}: ${m.tools.join(', ')}`,
        onPress: use(`Using the ${m.name} MCP server, `),
      })
      return [
        heading('Everything Claude can use', isLoading ? '' : String(total)),
        group('Workflows', C.blue, 'workflow', 'Open', loaded.map(f => ({ key: `wf:${f.id}`, name: f.workflow.title, description: firstSentence(f.workflow.description), onPress: () => void showWorkflow($, f.id) }))),
        group('Skills', C.add, 'skill', 'Use', catalog.skills.map(s => ({ key: `skill:${s.name}`, name: s.name, description: s.description, onPress: use(s.fill) })), isLoading),
        group('Agents', C.read, 'agent', 'Use', catalog.agents.map(a => ({ key: `agent:${a.name}`, name: a.name, description: a.description, onPress: use(a.fill) })), isLoading),
        group('MCP servers', C.teal, 'mcp', 'Use', servers.map(serverRow), isLoading),
      ]
    }
  })
}
