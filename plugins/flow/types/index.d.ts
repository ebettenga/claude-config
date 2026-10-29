export type Phase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

export type PlannedTask = {
  title: string
  tier: string
  after: number[]
}

export type Flow = {
  title: string
  total: number
  done: number
  running: number
  phase: Phase
  isFinished: boolean
  tasks: PlannedTask[]
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  round: number
  /** Self-reported by the worker through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  autoOpenedFor: string
}

// ---------------------------------------------------------------------------
// Workflows (flow.yaml), as hooks/spec.ts parses them.

export type InputType = 'text' | 'textarea' | 'number' | 'boolean' | 'date' | 'select' | 'file' | 'folder'
export type Tier = 'light' | 'medium' | 'careful' | 'heavy' | 'fable'
export type StepKind = 'run' | 'agent' | 'approve' | 'claude' | 'wait' | 'uses' | 'python' | 'mcp' | 'http' | 'model'

export type InputSpec = {
  id: string
  label: string
  type: InputType
  options: string[]
  accept: string[]
  multiple: boolean
  /** Folder inputs: files the folder must hold (e.g. package.json); the hub finds folders that do. */
  contains: string[]
  default: string
  required: boolean
  help: string
}

export type StepSpec = {
  id: string
  title: string
  kind: StepKind
  /** The command, prompt or question, as written (before templating). */
  body: string
  tier?: Tier
  cwd: string
  after: string[]
  timeoutSec: number
  /** A failure is reported but doesn't stop the steps that wait for this one. */
  continueOnFail: boolean
  /** `if:` as written: evaluated once the `after` steps are settled; false skips the step. */
  if?: string
  /** run and agent steps: how many times a failed attempt is tried again (0-5). */
  retry?: number
  /** Seconds between a failed attempt and the next one (default 10). */
  retryDelaySec?: number
  /** Paths in the run folder (templated) that must exist once the step succeeds. */
  outputs?: string[]
  /** run and agent steps: a list of items, or a template that resolves to items (newline or comma separated). */
  forEach?: string[] | string
  /** The item's template name (default `item`). */
  as?: string
  /** How many items run at once (default 3). */
  maxParallel?: number
  /** A wait step: what it waits for (`target` is templated). */
  wait?: { kind: 'file' | 'url' | 'until'; target: string }
  /** A wait step: seconds between checks (default 15). */
  intervalSec?: number
  /** A uses step: the child workflow's id (also the body). */
  uses?: string
  /** A uses step: the child's inputs, templated values by input id. */
  with?: Record<string, string>
  /** A python step: a script file (relative to the workflow folder) or inline code, its argv and its checks. */
  python?: PythonSpec
  /** An mcp step: a tool on one of the session's MCP servers, with deep-templated arguments. */
  mcp?: McpSpec
  /** An http step: one request through the host. */
  http?: HttpSpec
  /** A model step: one prompt to Claude with files attached; no agent, no tools. */
  ask?: ModelSpec
}

export type ModelSpec = {
  /** Templated. */
  prompt: string
  /** Templated paths whose text is attached after the prompt. */
  files: string[]
  /** Templated path the answer is written to, or empty. */
  write: string
  /** A model alias or id; empty: the session's model. */
  use: string
  maxTokens: number
  effort: string
  /** Templated system prompt, or empty. */
  system: string
}

export type PythonSpec = {
  /** The script, as written (relative to the workflow folder, or absolute); absent with `code`. */
  file?: string
  /** Inline code, run as written (not templated); absent with `file`. */
  code?: string
  /** One argv entry each, templated at run time. */
  args: string[]
  /** Default python3; a relative path is in the workflow folder. */
  interpreter: string
  /** Import names checked before the script runs. */
  requirements: string[]
}

export type McpSpec = {
  server: string
  tool: string
  /** Every string value is templated at run time. */
  args: Record<string, unknown>
}

export type HttpSpec = {
  method: string
  url: string
  headers: Record<string, string>
  /** An object is sent as JSON; a string as written (both templated). */
  body?: unknown
  /** Statuses that count as success; empty: any 2xx. */
  expect: number[]
}

export type Workflow = {
  id: string
  title: string
  description: string
  owner: string
  tags: string[]
  env: string[]
  inputs: InputSpec[]
  steps: StepSpec[]
  /** What the run leaves for people: shown after a run (Markdown rendered, CSVs as tables or charts). */
  outputs: OutputSpec[]
}

export type ChartType = 'bar' | 'line'
export type ChartAgg = 'sum' | 'count' | 'mean'

/** A declared output's chart: one bar or line per group of `x` (a CSV/TSV column, or a JSON array's key). */
export type OutputChart = {
  type: ChartType
  x: string
  /** The numeric column summed, averaged or (absent) counted. */
  y?: string
  /** Default sum, or count when there is no y. */
  agg: ChartAgg
  /** The biggest groups kept (default 12). */
  top: number
  /** Default value (biggest first) for bars, label for lines. */
  sort: 'value' | 'label'
}

/** A workflow-level output: written as a path, or `{ file, title?, chart? }`. */
export type OutputSpec = {
  /** A path in the run folder (templated). */
  file: string
  /** Default: the file name. */
  title: string
  chart?: OutputChart
}

/** A chart as drawn: from a declared output's chart or a `*.chart.json` file (flow.chart in python). */
export type ChartData = {
  type: ChartType
  title: string
  labels: string[]
  series: { name: string; values: number[] }[]
  yLabel?: string
}

/** One workflow folder as found: the workflow when it reads, the problems either way. */
export type Found = {
  id: string
  dir: string
  file: string
  workflow?: Workflow
  errors: string[]
}

// ---------------------------------------------------------------------------
// Runs of a workflow, as hooks/runner.ts keeps them (and writes run.json).

export type StepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped' | 'cancelled' | 'interrupted'

/** One item of a for_each step. */
export type ItemRun = {
  value: string
  status: StepStatus
  output: string
  tail: string
  exitCode?: number
  error?: string
  startedAt?: number
  endedAt?: number
  attempt?: number
  agentId?: string
}

export type StepRun = {
  id: string
  status: StepStatus
  startedAt?: number
  endedAt?: number
  /** A run step's stdout (trimmed) or an agent's answer; at most 20000 characters. */
  output: string
  /** The last 4000 characters (at most) of the step's log. */
  tail: string
  exitCode?: number
  error?: string
  agentId?: string
  /** Why a skipped step was skipped: `condition` when its `if:` was false (it does not block what waits on it). */
  reason?: 'condition'
  /** run and agent steps: the attempt going or last made, from 1. */
  attempt?: number
  /** A for_each step's items, in order. */
  items?: ItemRun[]
  /** A uses step: the child run's id. */
  childRun?: string
}

export type RunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export type Run = {
  id: string
  workflowId: string
  title: string
  workflowDir: string
  /** The run folder: ~/.flow/runs/<workflowId>/<runId>/ */
  dir: string
  inputs: Record<string, string>
  status: RunStatus
  startedAt: number
  endedAt?: number
  steps: StepRun[]
  /** A run started by a `uses` step: that run and step. */
  parent?: { run: string; step: string }
}

// ---------------------------------------------------------------------------
// The /flow-chart hub pane (hooks/hub.tsx).

export type HubTab = 'workflows' | 'runs' | 'skills'

/** The inline file browser under a file or folder input. */
/** The open file chooser: suggestions (with a search) or the folder browser. */
export type HubPicker = { workflowId: string; inputId: string; dir: string; mode: 'suggest' | 'browse'; query: string }

/** A skill or agent Claude can use, as the Skills tab lists it. */
export type CatalogItem = {
  /** As shown: the skill's or agent's name (plugin ones as plugin:name). */
  name: string
  /** What Use writes in the prompt box. */
  fill: string
  description: string
  path: string
}

export type HubCatalog = { skills: CatalogItem[]; agents: CatalogItem[]; at: number }

/** Form values by workflow id, then input id. */
export type HubForms = Record<string, Record<string, string>>
/** Whether each workflow env name is set. */
export type HubEnv = Record<string, boolean>
/** Problems by workflow id (or `rerun:<run id>`). */
export type HubAttempts = Record<string, string[]>
/** By run id: the Results blocks (output paths) shown collapsed. */
export type HubOpenResults = Record<string, string[]>

declare module 'claude-code' {
  interface PluginState {
    flow: {
      progressFlow: Flow | null
      progressAgents: AgentRun[]
      progressPanel: Panel
      progressNow: number
      // workflow state is added below
      workflows: Shaped<Found[]>
      /** Newest first, at most 30. */
      runs: Shaped<Run[]>
      // the hub pane
      hubTab: Shaped<HubTab>
      /** The workflow board open on the Workflows tab ('' for the list). */
      hubWorkflow: Shaped<string>
      /** The run board open on the Runs tab ('' for the list). */
      hubRun: Shaped<string>
      /** Form values by workflow id, then input id. */
      hubForms: Shaped<HubForms>
      hubPicker: Shaped<HubPicker | null>
      hubQuery: Shaped<string>
      /** The step whose log shows: a step id, or `id[i]` for an item. */
      hubLogStep: Shaped<string>
      /** Steps the shimmer while a run is running. */
      hubFrame: Shaped<number>
      hubCatalog: Shaped<HubCatalog>
      /** Whether each workflow env name is set, checked once per refresh. */
      hubEnv: Shaped<HubEnv>
      /** Workflows the person pressed Run on: the problems inputProblems does not cover (env, missing files). */
      hubAttempts: Shaped<HubAttempts>
      /** By run id: the Results blocks shown collapsed (absent: all but the first two open). */
      hubOpenResults: Shaped<HubOpenResults>
    }
  }
}
