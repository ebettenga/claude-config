// The /flow-chart hub pane: the workflows (find, read, fill in and run one),
// their runs (a live step chart, logs, approvals, outputs) and everything
// Claude can use (workflows, skills, agents). Laid out after
// design/flow-chart-mockup.png; the terminal draws the same content as rows.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Found, HubAttempts, HubCatalog, HubEnv, HubForms, HubPicker, HubTab, InputSpec, Run, StepSpec, Workflow } from '../types'
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
  firstLine,
  firstSentence,
  folderIconOf,
  itemAt,
  lastRunLine,
  linkTarget,
  loadCatalog,
  nowLine,
  outputCandidates,
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
import { cancelRun, decideStep, refreshWorkflows, rerun, resumeRun, startRun } from './runner'
import { STEP_KINDS, defaultValue, inputProblems, isAIStep, stepLevels } from './spec'

type $ = EngineInterface

const PANE = 'flow-chart'
const MAX_PICKER_ROWS = 200
const LOG_LINES = 40

const EMPTY_CATALOG: HubCatalog = { skills: [], agents: [], at: 0 }

// The runner's atoms and hub-state.ts's, made again here: the scan reads an
// atom only where a const of the same file makes it (same keys, same tags).
const workflowsAtom = atom({ plugin: 'flow', key: 'workflows' } as const, [], { shape: 'workflows-1' })
const runsAtom = atom({ plugin: 'flow', key: 'runs' } as const, [], { shape: 'runs-1' })
const hubTab = atom({ plugin: 'flow', key: 'hubTab' } as const, 'workflows' as HubTab, { shape: 'hub-tab-1' })
const hubWorkflow = atom({ plugin: 'flow', key: 'hubWorkflow' } as const, '', { shape: 'hub-workflow-1' })
const hubRun = atom({ plugin: 'flow', key: 'hubRun' } as const, '', { shape: 'hub-run-1' })
const hubForms = atom({ plugin: 'flow', key: 'hubForms' } as const, {} as HubForms, { shape: 'hub-forms-1' })
const hubPicker = atom({ plugin: 'flow', key: 'hubPicker' } as const, null as HubPicker | null, { shape: 'hub-picker-1' })
const hubQuery = atom({ plugin: 'flow', key: 'hubQuery' } as const, '', { shape: 'hub-query-1' })
const hubLogStep = atom({ plugin: 'flow', key: 'hubLogStep' } as const, '', { shape: 'hub-log-1' })
const hubFrame = atom({ plugin: 'flow', key: 'hubFrame' } as const, 0, { shape: 'hub-frame-1' })
const hubCatalog = atom({ plugin: 'flow', key: 'hubCatalog' } as const, EMPTY_CATALOG, { shape: 'hub-catalog-1' })
const hubEnv = atom({ plugin: 'flow', key: 'hubEnv' } as const, {} as HubEnv, { shape: 'hub-env-1' })
const hubAttempts = atom({ plugin: 'flow', key: 'hubAttempts' } as const, {} as HubAttempts, { shape: 'hub-attempts-1' })

// Module scope is fine here: registerHub sets these again on every (re)load.
let workflowsDir = '~/Documents/flows'
/** Each run's workflow.json, the steps it ran (a run's own copy never changes). */
const snapshots = new Map<string, Workflow>()

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
  if (tab === 'skills') await loadCatalog($).then(c => update($, hubCatalog, () => c)).catch(() => undefined)
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

// ── register ─────────────────────────────────────────────────────────────

export function registerHub(on: Parameters<Register>[0], options: Record<string, unknown>): void {
  workflowsDir = typeof options.workflowsDir === 'string' && options.workflowsDir.trim() ? options.workflowsDir.trim() : '~/Documents/flows'
  snapshots.clear()

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
    const [found, runs, tab, wfId, runId, forms, picked, q, logKey, frame, catalog, env, attempts] = await Promise.all([
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
    ])
    const now = await $.clock.now()
    const cwd = await $.session.cwd().catch(() => '')
    const home = ((await $.env.get('HOME').catch(() => undefined)) ?? '').replace(/\/+$/, '')
    const loaded = found.filter((f): f is Found & { workflow: Workflow } => Boolean(f.workflow))
    const active = runs.filter(r => r.status === 'running' || r.status === 'waiting')
    const gap = isDesktop ? 'md' : 1

    let body: RenderChildren[]
    const openWf = wfId ? loaded.find(f => f.id === wfId) : undefined
    const openRun = runId ? runs.find(r => r.id === runId) : undefined
    if (tab === 'workflows' && openWf) body = await workflowBoard(openWf)
    else if (tab === 'workflows') body = [runningCard(), tabsRow(), ...workflowsList()]
    else if (tab === 'runs' && openRun) body = [tabsRow(), ...(await runBoard(openRun))]
    else if (tab === 'runs') body = [tabsRow(), ...runsList()]
    else body = [tabsRow(), ...skillsList()]

    return (
      <Box flexDirection="column" gap={gap} width={width}>
        {body}
      </Box>
    )

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
      return [
        search,
        heading('Workflows', `${loaded.length} · ${workflowsDir}`),
        ...shown.map(workflowCard),
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

    function workflowCard(f: Found & { workflow: Workflow }) {
      const wf = f.workflow
      const last = lastRunLine(runs, wf.id, now)
      const { fixed, ai } = stepCounts(wf)
      const unset = wf.env.filter(n => env[n] === false)
      return card(`wf:${wf.id}`, [
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexShrink={1} minWidth={0} overflow="hidden">
            <Text size="heading" weight="semibold" wrap="truncate-end">{wf.title}</Text>
          </Box>
          <Button key={`run:${wf.id}`} variant="primary" onPress={() => void showWorkflow($, wf.id)}>Run</Button>
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
          return 'pick one'
        case 'file':
          return [input.multiple ? 'files' : 'file', input.accept.join(' ')].filter(Boolean).join(' · ')
        default:
          return ''
      }
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
                <Button key={`browse:${wf.id}:${input.id}`} onPress={() => void browse(f, input, value, isOpen)}>{isOpen ? 'Done' : 'Browse'}</Button>
              </Box>
              {isOpen && picked ? await picker(wf, input, value, picked.dir) : null}
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
      await update($, hubPicker, () => ({ workflowId: f.workflow.id, inputId: input.id, dir }))
    }

    async function picker(wf: Workflow, input: InputSpec, value: string, dir: string) {
      const entries = [...(await $.fs.list(dir).catch(() => []))]
        .filter(en => !en.name.startsWith('.'))
        .sort((a, b) => ((a.kind === 'dir') === (b.kind === 'dir') ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
      const chosen = value.split('\n').map(v => expandHome(v.trim(), home)).filter(Boolean)
      const join = (name: string) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`)
      const pick = (abs: string) => {
        if (!input.multiple) return setValue(wf, input.id, abs)
        const next = chosen.includes(abs) ? chosen.filter(c => c !== abs) : [...chosen, abs]
        return setValue(wf, input.id, next.join('\n'))
      }
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
            <Box flexShrink={1} minWidth={0} overflow="hidden">
              <Text dimColor size="footnote" wrap="truncate-start">{tildify(dir, home)}</Text>
            </Box>
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
            <Box flexDirection="row" gap="xs" alignItems="stretch">
              {levels.flatMap((level, i) => [
                i
                  ? (
                      <Box key={`arrow:${i}`} flexShrink={0} justifyContent="center">
                        <Text dimColor>→</Text>
                      </Box>
                    )
                  : null,
                <Box key={`level:${i}`} flexDirection="column" gap="xs" flexGrow={1} flexShrink={1} minWidth={0}>
                  {level.map(s => chip(s, run))}
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
      return (
        <Box
          key={`chip:${spec.id}`}
          flexDirection="column"
          paddingX={1}
          paddingY="xs"
          backgroundColor={s.isRunning ? tint(s.color, '33') : C.chip}
          borderStyle="round"
          borderColor={s.isRunning || s.isSelected ? s.color : C.border}
          minWidth={0}
          overflow="hidden"
        >
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text color={s.color} size="caption" weight="bold">{`● ${spec.kind.toUpperCase()}`}</Text>
            {isAIStep(spec) ? pill('AI', s.color, tint(s.color, '26'), 'caption') : null}
            <Box flexGrow={1} />
            {s.mark ? <Text color={s.mark.color} weight="bold" size="footnote">{s.mark.glyph}</Text> : null}
          </Box>
          <Box minWidth={0} overflow="hidden">
            {run
              ? (
                  <Button key={`step:${spec.id}`} plain onPress={() => void update($, hubLogStep, () => spec.id)}>
                    <Text weight="semibold" color={s.titleColor} dimColor={s.isDim} wrap="truncate-end">{spec.title}</Text>
                  </Button>
                )
              : <Text weight="semibold" wrap="truncate-end">{spec.title}</Text>}
          </Box>
          {s.sub ? <Text dimColor size="footnote" wrap="truncate-end">{s.sub}</Text> : null}
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
          {runs.map(r => (
            <Box key={`runrow:${r.id}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} paddingX={isDesktop ? 1 : 0} paddingY={isDesktop ? 'xs' : 0} backgroundColor={isDesktop ? C.tile : undefined}>
              <Box flexShrink={1} minWidth={0} overflow="hidden">
                <Button key={`open:${r.id}`} plain onPress={() => void showRun($, r.id)}>
                  <Text weight="semibold" wrap="truncate-end">{r.title}</Text>
                  <Text dimColor wrap="truncate-end">{`  ${ago(r.startedAt, now)}`}</Text>
                </Button>
              </Box>
              <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
                {statusPill(r)}
                <Text dimColor size="footnote" tabular>{duration((r.endedAt ?? now) - r.startedAt)}</Text>
              </Box>
            </Box>
          ))}
        </Box>,
      ]
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
              return (
                <Box key={`item:${itemKey}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} paddingX={isDesktop ? 1 : 0} paddingY={isDesktop ? 'xs' : 0} backgroundColor={isDesktop ? (isRunning ? tint(color) : C.tile) : undefined}>
                  <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0} overflow="hidden">
                    <Text color={isRunning ? color : mark.color} weight="bold">{mark.glyph}</Text>
                    <Box flexShrink={1} minWidth={0} overflow="hidden">
                      <Button key={`itm:${itemKey}`} plain onPress={() => void update($, hubLogStep, () => itemKey)}>
                        <Text color={isRunning ? shades(color)[2] : undefined} weight={isRunning || key === itemKey ? 'semibold' : 'regular'} wrap="truncate-end">{firstLine(it.value) || `item ${i + 1}`}</Text>
                      </Button>
                    </Box>
                  </Box>
                  <Text color={isRunning ? color : undefined} dimColor={!isRunning} size="footnote" weight="medium">{right}</Text>
                </Box>
              )
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

      // waiting on you, waiting on Claude
      for (const s of run.steps) {
        if (s.status !== 'waiting') continue
        const spec = specOf(s.id)
        if (spec?.kind === 'approve') {
          const question = s.tail.trim() || spec.body.trim()
          parts.push(
            card(`approve:${s.id}`, [
              <Text size="footnote" weight="bold" color={C.dirty}>{`WAITING FOR YOU · ${spec.title.toUpperCase()}`}</Text>,
              <Text weight="semibold">{question}</Text>,
              <Box flexDirection="row" gap={1}>
                <Button key={`approve:${s.id}`} variant="primary" onPress={() => void decideStep($, run.id, s.id, true)}>Approve</Button>
                <Button key={`reject:${s.id}`} onPress={() => void decideStep($, run.id, s.id, false)}>Reject</Button>
              </Box>,
            ], { fill: tint(C.dirty, '14'), stroke: tint(C.dirty, '66') }),
          )
        } else if (spec?.kind === 'claude') {
          parts.push(
            card(`claude:${s.id}`, [
              <Text size="footnote" weight="bold" color={C.edit}>WAITING FOR CLAUDE</Text>,
              <Text weight="semibold">{`Claude is working on ${spec.title}`}</Text>,
            ], { fill: tint(C.edit, '14'), stroke: tint(C.edit, '66') }),
          )
        }
      }

      // outputs
      const outs: { rel: string; abs: string }[] = []
      if (wf)
        for (const rel of outputCandidates(run, wf)) {
          const abs = `${run.dir}/${rel}`
          if (await $.fs.exists(abs).catch(() => false)) outs.push({ rel, abs })
        }
      parts.push(
        card('outputs', [
          heading('Outputs', isActive ? `${outs.length} so far` : String(outs.length)),
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
      const total = loaded.length + catalog.skills.length + catalog.agents.length
      const isLoading = catalog.at === 0
      const use = (text: string) => () => fillPrompt(text)
      const group = (title: string, color: string, label: string, items: { key: string; name: string; description: string; onPress: () => void }[], wait = false) =>
        card(`group:${title}`, [
          heading(title, wait ? '' : String(items.length)),
          ...(items.length
            ? items.map(it => (
                <Box key={`row:${it.key}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} paddingX={isDesktop ? 1 : 0} paddingY={isDesktop ? 'xs' : 0} backgroundColor={isDesktop ? C.tile : undefined}>
                  <Box flexDirection="column" flexShrink={1} minWidth={0} overflow="hidden">
                    <Text weight="semibold" wrap="truncate-end">{it.name}</Text>
                    {it.description ? <Text dimColor size="footnote" wrap="truncate-end">{it.description}</Text> : null}
                  </Box>
                  {isDesktop
                    ? (
                        <Button key={`use:${it.key}`} plain onPress={it.onPress}>
                          <Text color={color} backgroundColor={tint(color)} weight="semibold">{` ${label} `}</Text>
                        </Button>
                      )
                    : <Button key={`use:${it.key}`} onPress={it.onPress}>{label}</Button>}
                </Box>
              ))
            : [<Text dimColor size="footnote">{wait ? 'Looking…' : 'None found'}</Text>]),
        ])
      return [
        heading('Everything Claude can use', isLoading ? '' : String(total)),
        group('Workflows', C.blue, 'Open', loaded.map(f => ({ key: `wf:${f.id}`, name: f.workflow.title, description: firstSentence(f.workflow.description), onPress: () => void showWorkflow($, f.id) }))),
        group('Skills', C.add, 'Use', catalog.skills.map(s => ({ key: `skill:${s.name}`, name: s.name, description: s.description, onPress: use(s.fill) })), isLoading),
        group('Agents', C.read, 'Use', catalog.agents.map(a => ({ key: `agent:${a.name}`, name: a.name, description: a.description, onPress: use(a.fill) })), isLoading),
      ]
    }
  })
}
