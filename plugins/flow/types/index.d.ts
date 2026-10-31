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
  /** Select inputs: offer the values used in earlier runs as well as `options`, and take new ones. */
  remember: boolean
  /** Folder inputs: files the folder must hold (e.g. package.json); the hub finds folders that do. */
  contains: string[]
  /** Text inputs: suggestions from an MCP tool as the person types; picking one sets the value. */
  search?: InputSearch
  default: string
  required: boolean
  help: string
}

/** A text input's `search:`: the call, with `{{query}}` the text typed, and how each item shows and fills the input. */
export type InputSearch = {
  call: ViewCall
  /** path to the array in the result */
  items: string
  /** template for the value a pick puts in the input (`{{item.id}}`) */
  value: string
  /** template for each suggestion's line, also shown once it is picked */
  title: string
  subtitle?: string
  limit: number
  /** characters typed before it searches */
  min: number
}

/** One suggestion of a search input. */
export type InputOption = { value: string; title: string; subtitle?: string }

/** A search input's last search and its pick, by `<workflow id>:<input id>`. */
export type HubInputSearch = Record<
  string,
  {
    query: string
    state: 'idle' | 'loading' | 'ok' | 'error'
    options: InputOption[]
    message?: string
    picked?: InputOption
  }
>

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
  /** An agent step: what its headless Claude may use. */
  agent?: AgentSpec
}

/** An agent step runs `claude -p --restricted` with only these. */
export type AgentSpec = {
  /** Built-in tools it gets (never one that runs commands or code). Default Read, Grep, Glob, Write. */
  tools: string[]
  /** Templated folders it may read, besides the run folder. */
  read: string[]
  /** Templated folders it may write, besides the run folder. */
  write: string[]
  /** Dollars it may spend before it is stopped. */
  budget: number
  /** A model alias or id; empty: the tier's. */
  use: string
  /** An effort level; empty: the tier's. */
  effort: string
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
  /** The source it came from (its `name` in flows.yaml); none for the flows folder and .flows/. */
  source?: string
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
// The /flow-board hub pane (hooks/hub.tsx).

export type HubTab = 'workflows' | 'views' | 'runs' | 'agents' | 'skills'

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

/** One connected MCP server, from the tools the model can call: its name and its tools. */
export type CatalogServer = { name: string; tools: string[] }

export type HubCatalog = { skills: CatalogItem[]; agents: CatalogItem[]; mcp: CatalogServer[]; at: number }

/** Form values by workflow id, then input id. */
export type HubForms = Record<string, Record<string, string>>
/** Whether each workflow env name is set. */
export type HubEnv = Record<string, boolean>
/** Problems by workflow id (or `rerun:<run id>`). */
export type HubAttempts = Record<string, string[]>
/** By run id: the Results blocks (output paths) shown collapsed. */
export type HubOpenResults = Record<string, string[]>

// ---------------------------------------------------------------------------
// Views (view.yaml): a search, a list and a detail page over MCP tool calls,
// drawn on the hub's Views tab. hooks/views.ts parses and fills them.

/** One MCP call of a view; every string in `args` is a template. */
export type ViewCall = { server: string; tool: string; args: Record<string, unknown> }

/** A filter button; one is on per group (the group's first by default). */
export type ViewFilter = { id: string; label: string; group: string; args: Record<string, unknown> }

/** A form field of an action; `default` is a template, filled when the form opens. */
export type ViewField = {
  id: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'toggle' | 'select' | 'date'
  options: { value: string; label: string }[]
  default: string
  required: boolean
  help?: string
}

/** A button that calls a tool: a write, so it can ask to confirm, and can take a form first. */
export type ViewAction = {
  id: string
  label: string
  call: ViewCall
  fields: ViewField[]
  /** a template asked before the call runs ("Remove {{row.email}}?") */
  confirm?: string
  style: 'primary' | 'danger' | 'plain'
  /** shown when the call succeeds; default "<label>: done" */
  done?: string
}

export type ViewTable = { items: string; columns: { label: string; value: string }[]; empty: string; limit: number }

/** A bar chart of a list: one bar per item, labelled and sized by templates. */
export type ViewChart = { items: string; label: string; value: string; title?: string }

export type ViewRange = { modes: ('week' | 'month' | 'year' | 'ytd')[]; default: 'week' | 'month' | 'year' | 'ytd' }

/** A list of rows inside a detail section, or the view's own list. */
export type ViewRows = {
  /** path to the array: `requests.requests`, or `peers` in the list call's result */
  items: string
  /** template for each row's line (`{{row.status}}`; `{{item.x}}` in the view's list) */
  text: string
  /** an optional second, dimmer line */
  subtitle?: string
  /** path to a value that, when true, draws the row's dot green */
  dot?: string
  empty: string
  limit: number
}

export type ViewStat = { label: string; value: string }

export type ViewSection = {
  title: string
  /** the detail call this section waits on (its loading and errors show here) */
  from?: string
  stats: ViewStat[]
  /** template lines; an empty line is not drawn */
  text: string[]
  rows?: ViewRows
  table?: ViewTable
  chart?: ViewChart
  /** a path to an object whose keys and values are listed */
  pairs?: string
  /** buttons under the section; with rows or table, `row_actions` go on each row */
  actions: ViewAction[]
  row_actions: ViewAction[]
}

export type ViewTab = {
  id: string
  title: string
  /** run when the tab opens (and again on Refresh or a range change) */
  calls: Record<string, ViewCall>
  range?: ViewRange
  sections: ViewSection[]
  actions: ViewAction[]
}

export type ViewSpec = {
  id: string
  title: string
  description: string
  owner: string
  search?: { placeholder: string }
  filters: ViewFilter[]
  list: {
    call: ViewCall
    rows: ViewRows
    /** path to the item's key, passed to the detail page as {{key}} */
    key: string
    /** path to the total count in the list call's result */
    count?: string
    /** previous and next buttons; {{page}} (from 1) fills the list call's args */
    paged: boolean
  }
  detail?: {
    title: string
    subtitle?: string
    calls: Record<string, ViewCall>
    actions: ViewAction[]
    /** shown above the tabs, on every tab */
    sections: ViewSection[]
    tabs: ViewTab[]
  }
}

export type FoundView = {
  id: string
  dir: string
  file: string
  view?: ViewSpec
  errors: string[]
  source?: string
}

/** A call's result as the hub keeps it. */
export type ViewPart = { state: 'loading' } | { state: 'ok'; value: unknown } | { state: 'error'; message: string }

/** An action's form or confirm step, open on the page. */
export type ViewOpenAction = { key: string; values: Record<string, string>; isConfirming: boolean; isRunning: boolean }

/** What one view shows now: its search, list and open item. */
export type ViewState = {
  query: string
  /** the filter ids that are on, one per group, joined by commas */
  filter: string
  page: number
  list: ViewPart
  /** the open item's key ('' for the list), and its detail calls by name */
  key: string
  detail: Record<string, ViewPart>
  /** the open tab's id ('' for the first) */
  tab: string
  /** each tab's range: its mode and a date inside it (YYYY-MM-DD) */
  ranges: Record<string, { mode: string; anchor: string }>
  open?: ViewOpenAction
  /** the last action's outcome, shown at the top of the page */
  notice?: { ok: boolean; text: string }
}

declare module 'claude-code' {
  interface PluginState {
    flow: {
      progressFlow: Flow | null
      progressAgents: AgentRun[]
      progressPanel: Panel
      progressNow: number
      // workflow state is added below
      workflows: Shaped<Found[]>
      views: Shaped<FoundView[]>
      /** Each view's search, list and open item, by view id. */
      viewStates: Shaped<Record<string, ViewState>>
      /** The view open on the Views tab ('' for the list). */
      hubView: Shaped<string>
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
      /** Search inputs' suggestions and picks, by `<workflow id>:<input id>`. */
      hubInputSearch: Shaped<HubInputSearch>
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
      /** flows.yaml: the Workflows page's groups and their order. */
      layout: Shaped<Layout>
      /** The Workflows page in Arrange mode. */
      hubArrange: Shaped<boolean>
      /** Groups folded shut on the Workflows page, by title. */
      hubFolded: Shaped<Record<string, boolean>>
    }
  }
}

/** One group of flows.yaml: its title and its workflows' ids, in order. */
export type LayoutGroup = { title: string; workflows: string[] }

/**
 * One `sources:` entry of flows.yaml: another folder of workflows, usually a
 * git repo the hub clones and pulls (a team's shared flows).
 */
export type Source = {
  /** kebab-case; the folder under ~/.flow/sources when `path` is not given. */
  name: string
  /** shown on the Workflows page; default the name. */
  title: string
  /** clone URL; none for a plain folder. */
  git?: string
  branch?: string
  /** where it lives on this Mac (absolute, after ~ is expanded). */
  path: string
}

/** A source as the hub last found it. */
export type SourceState = Source & {
  /** cloned or found, and how many workflows it holds */
  isPresent: boolean
  count: number
  /** the source's own flows.yaml groups, titled "<source title> · <group>" */
  groups: LayoutGroup[]
  /** the last pull: when, and what went wrong if it did */
  pulledAt?: number
  error?: string
}

/** flows.yaml, read: the groups, the sources, and what in it is wrong. */
export type Layout = { groups: LayoutGroup[]; errors: string[]; file?: string; sources?: SourceState[] }
