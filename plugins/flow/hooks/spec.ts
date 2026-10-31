// Workflow files (flow.yaml): parsing, checking and templating. No `$` here,
// so the rules can be tested on their own; register.tsx reads the files.

import { load } from './vendor/js-yaml.mjs'
import { parseInputSearch } from './views'
import type { AgentSpec, ChartAgg, ChartType, Found, HttpSpec, InputSpec, InputType, McpSpec, OutputChart, OutputSpec, PythonSpec, StepKind, StepSpec, Tier, Workflow, ModelSpec } from '../types'

export type { ChartAgg, ChartType, Found, HttpSpec, InputSpec, InputType, McpSpec, OutputChart, OutputSpec, PythonSpec, StepKind, StepSpec, Tier, Workflow }

export const INPUT_TYPES = ['text', 'textarea', 'number', 'boolean', 'date', 'select', 'file', 'folder'] as const satisfies readonly InputType[]
export const TIERS = ['light', 'medium', 'careful', 'heavy', 'fable'] as const satisfies readonly Tier[]
export const STEP_KINDS = ['run', 'agent', 'approve', 'claude', 'wait', 'uses', 'python', 'mcp', 'http', 'model'] as const satisfies readonly StepKind[]
/** Steps that do work, take a slot, and can be retried and repeated (for_each). */
export const WORK_KINDS = ['run', 'agent', 'python', 'mcp', 'http', 'model'] as const satisfies readonly StepKind[]
export const PYTHON_FIELDS = ['file', 'code', 'args', 'interpreter', 'requirements'] as const
export const MCP_FIELDS = ['server', 'tool', 'args'] as const
export const HTTP_FIELDS = ['method', 'url', 'headers', 'body', 'expect'] as const
export const MODEL_FIELDS = ['prompt', 'files', 'write', 'use', 'max_tokens', 'effort', 'system'] as const
/** The tools an agent step may list; none of them runs commands or code. */
export const AGENT_TOOLS = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebSearch', 'WebFetch'] as const
const AGENT_READ_TOOLS = ['Read', 'Grep', 'Glob']
const DEFAULT_AGENT_BUDGET = 1
const MAX_AGENT_BUDGET = 20
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const WAIT_KINDS = ['file', 'url', 'until'] as const
export const FILTERS = ['sh', 'json'] as const
export const OUTPUT_FIELDS = ['file', 'title', 'chart'] as const
export const CHART_FIELDS = ['type', 'x', 'y', 'agg', 'top', 'sort'] as const
export const CHART_TYPES = ['bar', 'line'] as const satisfies readonly ChartType[]
export const CHART_AGGS = ['sum', 'count', 'mean'] as const satisfies readonly ChartAgg[]
const CHART_SORTS = ['value', 'label'] as const
const MAX_CHART_TOP = 50
const DEFAULT_CHART_TOP = 12

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const DEFAULT_TIMEOUT_SEC = 600
const DEFAULT_WAIT_TIMEOUT_SEC = 3600
const DEFAULT_WAIT_INTERVAL_SEC = 15
const DEFAULT_RETRY_DELAY_SEC = 10
const DEFAULT_MAX_PARALLEL = 3
const MAX_RETRY = 5
const RESERVED_NAMES = new Set(['inputs', 'steps', 'run', 'item_index'])

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '')
const strList = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : typeof v === 'string' && v ? [v] : [])
/** "a, b and c". */
const listText = (xs: readonly string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)
const ENV_TEMPLATE_PLACES = 'python args, mcp args and http url, headers and body'

/** A step is AI when Claude does it: an agent or claude step. Everything else runs the same way every time. */
export const isAIStep = (spec: Pick<StepSpec, 'kind'>) => spec.kind === 'agent' || spec.kind === 'claude' || spec.kind === 'model'

/** Every string in a value (deep), in order. */
export function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(deepStrings)
  if (isObj(value)) return Object.values(value).flatMap(deepStrings)
  return []
}

/** A copy of a value with every string (deep) passed through `fn`; keys stay as written. */
export function deepMap(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map(v => deepMap(v, fn))
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepMap(v, fn)]))
  return value
}

/**
 * Splits an args line like a shell would (quotes and backslashes, no
 * expansion); a {{ template }} stays one piece with what it touches.
 */
export function splitArgs(line: string): { args: string[]; error?: string } {
  const args: string[] = []
  let cur = ''
  let isWord = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? ''
    if (line.startsWith('{{', i)) {
      const end = line.indexOf('}}', i + 2)
      if (end < 0) return { args, error: `the template starting at ${line.slice(i, i + 12)} is not closed` }
      cur += line.slice(i, end + 2)
      isWord = true
      i = end + 1
    } else if (c === "'" || c === '"') {
      const end = line.indexOf(c, i + 1)
      if (c === "'") {
        if (end < 0) return { args, error: `the quote starting at ${line.slice(i, i + 12)} is not closed` }
        cur += line.slice(i + 1, end)
        i = end
      } else {
        let j = i + 1
        for (; j < line.length && line[j] !== '"'; j++) {
          if (line[j] === '\\' && j + 1 < line.length && '"\\$`'.includes(line[j + 1] ?? '')) j++
          cur += line[j]
        }
        if (j >= line.length) return { args, error: `the quote starting at ${line.slice(i, i + 12)} is not closed` }
        i = j
      }
      isWord = true
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i]
      isWord = true
    } else if (/\s/.test(c)) {
      if (isWord) args.push(cur)
      cur = ''
      isWord = false
    } else {
      cur += c
      isWord = true
    }
  }
  if (isWord) args.push(cur)
  return { args }
}

/** The {{env.NAME}} names a python, mcp or http step uses, in order, once each. */
export function stepEnvNames(spec: StepSpec): string[] {
  const texts = [...(spec.python?.args ?? []), ...deepStrings(spec.mcp?.args), ...(spec.http ? [spec.http.url, ...Object.values(spec.http.headers), ...deepStrings(spec.http.body)] : [])]
  const names: string[] = []
  for (const t of texts)
    for (const m of t.matchAll(/\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|[^}]*)?\}\}/g)) if (m[1] && !names.includes(m[1])) names.push(m[1])
  return names
}

const JSON_PATH_RE = /^steps\.([A-Za-z0-9_-]+)\.json((?:\.[A-Za-z0-9_-]+|\[\d+\])*)$/

/** A JSON path's parts: `.orders[0].total` → ['orders', 0, 'total']. */
export function jsonPathParts(path: string): (string | number)[] {
  return [...path.matchAll(/\.([A-Za-z0-9_-]+)|\[(\d+)\]/g)].map(m => (m[1] !== undefined ? m[1] : Number(m[2])))
}

/** A step output parsed as JSON; null when it is empty or not JSON. */
export function parseJson(text: string): unknown {
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** The value at a JSON path; undefined where the path leads nowhere. */
export function atJsonPath(value: unknown, parts: (string | number)[]): unknown {
  let cur = value
  for (const p of parts) {
    if (typeof p === 'number') cur = Array.isArray(cur) ? cur[p] : undefined
    else cur = isObj(cur) ? cur[p] : undefined
    if (cur === undefined) return undefined
  }
  return cur
}

/** A JSON value as template text: objects and arrays as JSON, scalars as text, null as empty. */
export const jsonText = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

export function parseWorkflow(text: string, dir: string, file: string): Found {
  const folderId = dir.replace(/\/+$/, '').split('/').pop() ?? ''
  const found: Found = { id: folderId, dir, file, errors: [] }
  let doc: unknown
  try {
    doc = load(text)
  } catch (err) {
    found.errors.push(`not valid YAML: ${String((err as Error)?.message ?? err).split('\n')[0]}`)
    return found
  }
  if (!isObj(doc)) {
    found.errors.push('the file must be a mapping (id:, title:, steps: ...)')
    return found
  }
  const errors = found.errors
  const id = str(doc.id) || folderId
  if (!ID_RE.test(id)) errors.push(`id: "${id}" must be lowercase letters, digits, - or _`)
  found.id = id

  const inputs: InputSpec[] = []
  const rawInputs = doc.inputs ?? []
  if (!Array.isArray(rawInputs)) errors.push('inputs: must be a list')
  else
    rawInputs.forEach((raw, i) => {
      const at = `inputs[${i}]`
      if (!isObj(raw)) return void errors.push(`${at}: must be a mapping with id and type`)
      const inId = str(raw.id)
      if (!/^[a-z][a-z0-9_]*$/i.test(inId)) errors.push(`${at}.id: "${inId}" must be letters, digits or _`)
      if (inputs.some(x => x.id === inId)) errors.push(`${at}.id: "${inId}" is used twice`)
      const type = (str(raw.type) || 'text') as InputType
      if (!INPUT_TYPES.includes(type)) errors.push(`${at}.type: "${type}" must be one of ${INPUT_TYPES.join(', ')}`)
      const options = strList(raw.options)
      const remember = raw.remember === true
      if (raw.remember !== undefined && type !== 'select') errors.push(`${at}.remember: only select inputs take remember:`)
      if (raw.multiple !== undefined && type !== 'select' && type !== 'file') errors.push(`${at}.multiple: only select and file inputs take multiple:`)
      if (type === 'select' && !options.length && !remember) errors.push(`${at}.options: a select needs at least one option (or remember: true, to offer the values used before)`)
      const contains = strList(raw.contains)
      if (contains.length && type !== 'folder') errors.push(`${at}.contains: only folder inputs take contains:`)
      if (contains.some(c => c.startsWith('/') || c.split('/').includes('..'))) errors.push(`${at}.contains: paths are relative to the folder (no leading / or ..)`)
      if (raw.search !== undefined && type !== 'text') errors.push(`${at}.search: only text inputs take search:`)
      const search = raw.search === undefined ? undefined : parseInputSearch(raw.search, `${at}.search`, errors)
      inputs.push({
        id: inId,
        label: str(raw.label) || inId,
        type,
        options,
        accept: strList(raw.accept).map(a => a.toLowerCase()),
        multiple: raw.multiple === true,
        contains,
        ...(search ? { search } : {}),
        // A multiple select's default may be a list: its values, one per line.
        default: raw.default === undefined || raw.default === null ? '' : Array.isArray(raw.default) ? strList(raw.default).join('\n') : str(raw.default),
        remember,
        required: raw.required !== false,
        help: str(raw.help),
      })
    })

  const envNames = strList(doc.env)
  const steps: StepSpec[] = []
  /** Templated text of each step, whether it may use the item templates, and whether {{env.NAME}}. */
  const texts: { text: string; isItemOk: boolean; isEnvOk?: boolean }[][] = []
  const rawSteps = doc.steps
  if (!Array.isArray(rawSteps) || !rawSteps.length) errors.push('steps: needs at least one step')
  else
    rawSteps.forEach((raw, i) => {
      const at = `steps[${i}]`
      texts[i] = []
      if (!isObj(raw)) return void errors.push(`${at}: must be a mapping with id and one of ${STEP_KINDS.join(', ')}`)
      const stepId = str(raw.id) || `step_${i + 1}`
      if (!/^[a-z][a-z0-9_-]*$/i.test(stepId)) errors.push(`${at}.id: "${stepId}" must be letters, digits, - or _`)
      if (steps.some(x => x.id === stepId)) errors.push(`${at}.id: "${stepId}" is used twice`)
      const kinds = STEP_KINDS.filter(k => raw[k] !== undefined)
      if (kinds.length !== 1) errors.push(`${at}: needs exactly one of ${STEP_KINDS.join(', ')}${kinds.length ? ` (has ${kinds.join(', ')})` : ''}`)
      const kind = kinds[0] ?? 'run'
      const onlyFor = (field: string, allowed: readonly StepKind[]) => {
        if (raw[field] !== undefined && !allowed.includes(kind)) errors.push(`${at}.${field}: only ${listText(allowed)} steps take ${field}:`)
      }
      let body = str(raw[kind])
      let tier: Tier | undefined
      let wait: StepSpec['wait']
      let uses: string | undefined
      let withValues: Record<string, string> | undefined
      let python: PythonSpec | undefined
      let mcp: McpSpec | undefined
      let ask: ModelSpec | undefined
      let agent: AgentSpec | undefined
      let http: HttpSpec | undefined
      /** The templated parts of a python, mcp or http step, and whether each may use {{env.NAME}}. */
      const parts: { text: string; isEnvOk: boolean }[] = []
      const unknownFields = (field: string, value: Record<string, unknown>, allowed: readonly string[]) => {
        for (const k of Object.keys(value)) if (!allowed.includes(k)) errors.push(`${at}.${field}.${k}: is not a ${field} field (use ${allowed.join(', ')})`)
      }
      if (kind === 'agent') {
        tier = str(raw.agent) as Tier
        if (!TIERS.includes(tier)) errors.push(`${at}.agent: "${str(raw.agent)}" must be one of ${TIERS.join(', ')}`)
        body = str(raw.prompt)
        if (!body) errors.push(`${at}.prompt: an agent step needs a prompt`)
        // A headless Claude with only these tools: nothing that runs commands or code.
        const tools = raw.tools === undefined ? [...AGENT_READ_TOOLS, 'Write'] : strList(raw.tools)
        for (const t of tools)
          if (!(AGENT_TOOLS as readonly string[]).includes(t))
            errors.push(
              t === 'Bash' || t === 'PowerShell'
                ? `${at}.tools: ${t} is not allowed in an agent step (put the command in a run step before it)`
                : `${at}.tools: "${t}" must be one of ${AGENT_TOOLS.join(', ')}`,
            )
        const budget = raw.budget === undefined ? DEFAULT_AGENT_BUDGET : Number(raw.budget)
        if (!Number.isFinite(budget) || budget <= 0 || budget > MAX_AGENT_BUDGET) errors.push(`${at}.budget: must be dollars, more than 0 and at most ${MAX_AGENT_BUDGET}`)
        const effort = str(raw.effort).trim()
        if (effort && !EFFORTS.includes(effort)) errors.push(`${at}.effort: must be one of ${EFFORTS.join(', ')}`)
        agent = { tools: [...new Set(tools)], read: strList(raw.read), write: strList(raw.write), budget, use: str(raw.use).trim(), effort }
        for (const t of [...agent.read, ...agent.write]) parts.push({ text: t, isEnvOk: false })
      } else if (kind === 'wait') {
        const w = raw.wait
        if (!isObj(w)) errors.push(`${at}.wait: must be a mapping with one of ${WAIT_KINDS.join(', ')}`)
        else {
          const forms = WAIT_KINDS.filter(k => w[k] !== undefined)
          if (forms.length !== 1) errors.push(`${at}.wait: needs exactly one of ${WAIT_KINDS.join(', ')}${forms.length ? ` (has ${forms.join(', ')})` : ''}`)
          const form = forms[0] ?? 'file'
          const target = str(w[form]).trim()
          if (!target) errors.push(`${at}.wait.${form}: is empty`)
          else if (!target.includes('{{')) {
            if (form === 'url' && !/^https?:\/\/\S+$/i.test(target)) errors.push(`${at}.wait.url: "${target}" must be an http or https URL`)
            if (form === 'until' && untilTime(target, new Date()) === undefined) errors.push(`${at}.wait.until: "${target}" must be HH:MM or an ISO date and time`)
          }
          wait = { kind: form, target }
          body = target
        }
      } else if (kind === 'uses') {
        uses = str(raw.uses).trim()
        body = uses
        if (!ID_RE.test(uses)) errors.push(`${at}.uses: "${uses}" must be a workflow id`)
        else if (uses === id) errors.push(`${at}.uses: a workflow cannot use itself`)
        if (raw.with !== undefined && raw.with !== null && !isObj(raw.with)) errors.push(`${at}.with: must be a mapping of input id to value`)
        withValues = {}
        for (const [key, value] of Object.entries(isObj(raw.with) ? raw.with : {})) {
          if (!/^[a-z][a-z0-9_]*$/i.test(key)) errors.push(`${at}.with.${key}: is not an input id`)
          if (isObj(value) || Array.isArray(value)) errors.push(`${at}.with.${key}: must be a single value`)
          withValues[key] = value === null || value === undefined ? '' : str(value)
        }
      } else if (kind === 'python') {
        const p = raw.python
        python = { args: [], interpreter: 'python3', requirements: [] }
        if (typeof p === 'string') {
          python.code = p
          if (!p.trim()) errors.push(`${at}.python: is empty`)
        } else if (isObj(p)) {
          unknownFields('python', p, PYTHON_FIELDS)
          if ((p.file === undefined) === (p.code === undefined)) errors.push(`${at}.python: needs exactly one of file or code`)
          if (p.file !== undefined) {
            python.file = str(p.file).trim()
            if (!python.file) errors.push(`${at}.python.file: is empty`)
            else parts.push({ text: python.file, isEnvOk: false })
          }
          if (p.code !== undefined) {
            python.code = typeof p.code === 'string' ? p.code : ''
            if (!python.code.trim()) errors.push(`${at}.python.code: is empty`)
          }
          if (Array.isArray(p.args)) {
            if (p.args.some(v => isObj(v) || Array.isArray(v))) errors.push(`${at}.python.args: each arg must be a single value`)
            python.args = p.args.map(v => (v === null || v === undefined ? '' : str(v)))
          } else if (typeof p.args === 'string') {
            const split = splitArgs(p.args)
            if (split.error !== undefined) errors.push(`${at}.python.args: ${split.error}`)
            python.args = split.args
          } else if (p.args !== undefined && p.args !== null) errors.push(`${at}.python.args: must be a list or one string`)
          for (const a of python.args) parts.push({ text: a, isEnvOk: true })
          if (p.interpreter !== undefined) {
            python.interpreter = str(p.interpreter).trim()
            if (!python.interpreter) errors.push(`${at}.python.interpreter: is empty`)
          }
          if (p.requirements !== undefined && p.requirements !== null && !Array.isArray(p.requirements) && typeof p.requirements !== 'string')
            errors.push(`${at}.python.requirements: must be a list of import names`)
          python.requirements = strList(p.requirements)
          for (const r of python.requirements)
            if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(r)) errors.push(`${at}.python.requirements: "${r}" is not an import name`)
        } else errors.push(`${at}.python: must be code, or a mapping with file or code`)
        body = python.file ?? python.code ?? ''
      } else if (kind === 'mcp') {
        const m = raw.mcp
        if (!isObj(m)) errors.push(`${at}.mcp: must be a mapping with server, tool and args`)
        const mm = isObj(m) ? m : {}
        if (isObj(m)) unknownFields('mcp', m, MCP_FIELDS)
        const server = typeof mm.server === 'string' ? mm.server.trim() : ''
        const tool = typeof mm.tool === 'string' ? mm.tool.trim() : ''
        if (isObj(m) && !server) errors.push(`${at}.mcp.server: must be the server's name, as /mcp lists it`)
        if (isObj(m) && !tool) errors.push(`${at}.mcp.tool: must be the tool's name on that server`)
        if (mm.args !== undefined && mm.args !== null && !isObj(mm.args)) errors.push(`${at}.mcp.args: must be a mapping of argument names to values`)
        mcp = { server, tool, args: isObj(mm.args) ? mm.args : {} }
        for (const t of deepStrings(mcp.args)) parts.push({ text: t, isEnvOk: true })
        body = `${server} ${tool}`.trim()
      } else if (kind === 'model') {
        const m = raw.model
        if (!isObj(m)) errors.push(`${at}.model: must be a mapping with prompt (and files, write, use)`)
        const mm = isObj(m) ? m : {}
        if (isObj(m)) unknownFields('model', m, MODEL_FIELDS)
        const prompt = str(mm.prompt)
        if (isObj(m) && !prompt.trim()) errors.push(`${at}.model.prompt: a model step needs a prompt`)
        const maxTokens = mm.max_tokens === undefined ? 4000 : Number(mm.max_tokens)
        if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 64000) errors.push(`${at}.model.max_tokens: must be a whole number from 1 to 64000`)
        const effort = str(mm.effort).trim()
        if (effort && !EFFORTS.includes(effort)) errors.push(`${at}.model.effort: must be one of ${EFFORTS.join(', ')}`)
        ask = { prompt, files: strList(mm.files), write: str(mm.write).trim(), use: str(mm.use).trim(), maxTokens, effort, system: str(mm.system) }
        for (const t of [ask.prompt, ask.write, ask.system, ...ask.files]) if (t) parts.push({ text: t, isEnvOk: false })
        body = prompt
      } else if (kind === 'http') {
        const h = raw.http
        if (!isObj(h)) errors.push(`${at}.http: must be a mapping with url`)
        const hh = isObj(h) ? h : {}
        if (isObj(h)) unknownFields('http', h, HTTP_FIELDS)
        const method = (str(hh.method) || 'GET').trim().toUpperCase()
        if (!/^[A-Z]+$/.test(method)) errors.push(`${at}.http.method: "${str(hh.method)}" is not an HTTP method`)
        const url = str(hh.url).trim()
        if (isObj(h) && !url) errors.push(`${at}.http.url: is empty`)
        else if (url && !url.includes('{{') && !/^https?:\/\/\S+$/i.test(url)) errors.push(`${at}.http.url: "${url}" must be an http or https URL`)
        const headers: Record<string, string> = {}
        if (hh.headers !== undefined && hh.headers !== null && !isObj(hh.headers)) errors.push(`${at}.http.headers: must be a mapping of header names to values`)
        for (const [k, v] of Object.entries(isObj(hh.headers) ? hh.headers : {})) {
          if (isObj(v) || Array.isArray(v)) errors.push(`${at}.http.headers.${k}: must be a single value`)
          headers[k] = v === null || v === undefined ? '' : str(v)
        }
        const rawExpect = hh.expect === undefined || hh.expect === null ? [] : Array.isArray(hh.expect) ? hh.expect : [hh.expect]
        const expect = rawExpect.map(Number)
        if (expect.some(n => !Number.isInteger(n) || n < 100 || n > 599)) errors.push(`${at}.http.expect: must be HTTP status codes (100 to 599)`)
        if (hh.body !== undefined && hh.body !== null && typeof hh.body !== 'string' && !isObj(hh.body) && !Array.isArray(hh.body))
          errors.push(`${at}.http.body: must be text or a mapping (sent as JSON)`)
        http = { method, url, headers, expect, ...(hh.body !== undefined && hh.body !== null ? { body: hh.body } : {}) }
        parts.push({ text: url, isEnvOk: true })
        for (const v of Object.values(headers)) parts.push({ text: v, isEnvOk: true })
        for (const t of deepStrings(http.body)) parts.push({ text: t, isEnvOk: true })
        body = `${method} ${url}`
      } else if (!body) errors.push(`${at}.${kind}: is empty`)
      onlyFor('with', ['uses'])
      for (const field of ['tools', 'read', 'write', 'budget', 'use', 'effort']) onlyFor(field, ['agent'])
      onlyFor('interval', ['wait'])

      const timeout = raw.timeout === undefined ? (kind === 'wait' ? DEFAULT_WAIT_TIMEOUT_SEC : DEFAULT_TIMEOUT_SEC) : Number(raw.timeout)
      if (!Number.isFinite(timeout) || timeout <= 0) errors.push(`${at}.timeout: must be a number of seconds`)
      const after = raw.after === undefined ? (steps.length ? [steps[steps.length - 1]?.id ?? ''] : []) : strList(raw.after)
      const spec: StepSpec = { id: stepId, title: str(raw.title) || stepId, kind, body, tier, cwd: str(raw.cwd), after, timeoutSec: timeout, continueOnFail: raw.continue_on_fail === true }
      if (agent) spec.agent = agent

      // if:
      if (raw.if !== undefined) {
        spec.if = str(raw.if).trim()
        const parsed = parseCondition(spec.if)
        if (parsed.error !== undefined) errors.push(`${at}.if: ${parsed.error}`)
      }

      // retry: and retry_delay:
      onlyFor('retry', WORK_KINDS)
      onlyFor('retry_delay', WORK_KINDS)
      const retry = raw.retry === undefined ? 0 : Number(raw.retry)
      if (!Number.isInteger(retry) || retry < 0 || retry > MAX_RETRY) errors.push(`${at}.retry: must be a whole number from 0 to ${MAX_RETRY}`)
      const retryDelay = raw.retry_delay === undefined ? DEFAULT_RETRY_DELAY_SEC : Number(raw.retry_delay)
      if (!Number.isFinite(retryDelay) || retryDelay < 0) errors.push(`${at}.retry_delay: must be a number of seconds`)
      spec.retry = retry
      spec.retryDelaySec = retryDelay

      // outputs:
      const outputs = raw.outputs === undefined ? [] : Array.isArray(raw.outputs) || typeof raw.outputs === 'string' ? strList(raw.outputs) : null
      if (!outputs) errors.push(`${at}.outputs: must be a list of paths in the run folder`)
      for (const path of outputs ?? [])
        if (path.startsWith('/') || path.startsWith('~') || path.split('/').includes('..')) errors.push(`${at}.outputs: "${path}" must be a path inside the run folder`)
      spec.outputs = outputs ?? []

      // for_each:, as: and max_parallel:
      onlyFor('for_each', WORK_KINDS)
      for (const field of ['as', 'max_parallel'])
        if (raw[field] !== undefined && raw.for_each === undefined) errors.push(`${at}.${field}: only a for_each step takes ${field}:`)
      if (raw.for_each !== undefined) {
        if (Array.isArray(raw.for_each)) {
          if (raw.for_each.some(v => isObj(v) || Array.isArray(v))) errors.push(`${at}.for_each: each item must be a single value`)
          spec.forEach = raw.for_each.map(v => (v === null || v === undefined ? '' : str(v)))
        } else if (typeof raw.for_each === 'string' && raw.for_each.trim()) spec.forEach = raw.for_each
        else errors.push(`${at}.for_each: must be a list or a template string`)
        const as = raw.as === undefined ? 'item' : str(raw.as)
        if (!/^[a-z_][a-z0-9_]*$/i.test(as) || RESERVED_NAMES.has(as)) errors.push(`${at}.as: "${as}" must be a name (letters, digits, _), not ${[...RESERVED_NAMES].join(', ')}`)
        const maxParallel = raw.max_parallel === undefined ? DEFAULT_MAX_PARALLEL : Number(raw.max_parallel)
        if (!Number.isInteger(maxParallel) || maxParallel < 1) errors.push(`${at}.max_parallel: must be a whole number from 1`)
        spec.as = as
        spec.maxParallel = maxParallel
        for (const t of typeof spec.forEach === 'string' ? [spec.forEach] : (spec.forEach ?? [])) texts[i]?.push({ text: t, isItemOk: false })
      }

      if (kind === 'wait') {
        const rawInterval = raw.interval ?? (isObj(raw.wait) ? raw.wait.interval : undefined)
        const interval = rawInterval === undefined ? DEFAULT_WAIT_INTERVAL_SEC : Number(rawInterval)
        if (!Number.isFinite(interval) || interval <= 0) errors.push(`${at}.interval: must be a number of seconds`)
        spec.wait = wait
        spec.intervalSec = interval
      }
      if (kind === 'uses') {
        spec.uses = uses
        spec.with = withValues
      }
      if (python) spec.python = python
      if (mcp) spec.mcp = mcp
      if (http) spec.http = http
      if (ask) spec.ask = ask

      const isItemOk = spec.forEach !== undefined
      // A python, mcp or http step's templates are its parts (inline python code is not templated).
      const isParted = kind === 'python' || kind === 'mcp' || kind === 'http' || kind === 'model'
      for (const t of [...(isParted ? [] : [body]), spec.cwd, ...spec.outputs, ...Object.values(withValues ?? {})]) texts[i]?.push({ text: t, isItemOk })
      for (const p of parts) texts[i]?.push({ text: p.text, isItemOk, isEnvOk: p.isEnvOk })
      steps.push(spec)
    })

  // Every `after` names a step, and the steps can be ordered.
  const ids = new Set(steps.map(s => s.id))
  steps.forEach((s, i) => s.after.forEach(a => ids.has(a) || errors.push(`steps[${i}].after: no step "${a}"`)))
  if (!errors.length && hasCycle(steps)) errors.push('steps: the after: links go in a circle')

  // Templates and conditions name inputs and steps that exist.
  const known = { inputs: new Set(inputs.map(x => x.id)), steps: ids }
  steps.forEach((s, i) => {
    const itemNames = s.forEach !== undefined ? ['item', 'item_index', s.as ?? 'item'] : []
    for (const { text, isItemOk, isEnvOk } of texts[i] ?? [])
      for (const ref of templateRefs(text, itemNames)) {
        if (ref.kind === 'inputs' && !known.inputs.has(ref.name)) errors.push(`steps[${i}]: {{inputs.${ref.name}}} names no input`)
        if (ref.kind === 'steps' && !known.steps.has(ref.name)) errors.push(`steps[${i}]: {{steps.${ref.name}.${ref.field ?? 'output'}}} names no step`)
        if (ref.kind === 'env' && !isEnvOk) errors.push(`steps[${i}]: {{env.${ref.name}}} only works in ${ENV_TEMPLATE_PLACES} (a run step has $${ref.name})`)
        else if (ref.kind === 'env' && !envNames.includes(ref.name)) errors.push(`steps[${i}]: {{env.${ref.name}}} needs ${ref.name} listed under env:`)
        if (ref.kind === 'json') errors.push(`steps[${i}]: {{${ref.name}}} is not a JSON path (use steps.<id>.json, then .key and [n], as in steps.fetch.json.orders[0].total)`)
        if (ref.kind === 'item' && !isItemOk) errors.push(`steps[${i}]: {{${ref.name}}} only works in a for_each step's command, prompt, cwd or outputs`)
        if (ref.kind === 'filter') errors.push(`steps[${i}]: {{${ref.name}}} uses "${ref.field}", which is not a filter (use ${FILTERS.join(' or ')})`)
        if (ref.kind === 'bad') errors.push(`steps[${i}]: {{${ref.name}}} is not a template (use inputs.<id>, steps.<id>.output or run.dir)`)
      }
    if (s.if === undefined) return
    const parsed = parseCondition(s.if)
    if (!parsed.node) return
    for (const ref of conditionRefs(parsed.node)) {
      if (ref[0] === 'inputs' && !known.inputs.has(ref[1] ?? '')) errors.push(`steps[${i}].if: inputs.${ref[1]} names no input`)
      if (ref[0] === 'steps' && !known.steps.has(ref[1] ?? '')) errors.push(`steps[${i}].if: steps.${ref[1]} names no step`)
    }
  })

  // hide_when: a condition on the latest finished run, as a step's if: is on the run so far.
  let hideWhen: string | undefined
  if (doc.hide_when !== undefined) {
    const parsed = typeof doc.hide_when === 'string' || typeof doc.hide_when === 'boolean' ? parseCondition(String(doc.hide_when)) : undefined
    if (!parsed) errors.push('hide_when: must be a condition, as in an if:')
    else if (!parsed.node) errors.push(`hide_when: ${parsed.error}`)
    else {
      hideWhen = String(doc.hide_when)
      for (const ref of conditionRefs(parsed.node)) {
        if (ref[0] === 'inputs' && !known.inputs.has(ref[1] ?? '')) errors.push(`hide_when: inputs.${ref[1]} names no input`)
        if (ref[0] === 'steps' && !known.steps.has(ref[1] ?? '')) errors.push(`hide_when: steps.${ref[1]} names no step`)
      }
    }
  }

  found.workflow = {
    id,
    title: str(doc.title) || id,
    description: str(doc.description).trim(),
    owner: str(doc.owner),
    tags: strList(doc.tags),
    env: envNames,
    inputs,
    steps,
    outputs: parseOutputs(doc.outputs, errors),
    ...(hideWhen ? { hideWhen } : {}),
  }
  return found
}

const fileName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p

/** Top-level `outputs:`: paths, or `{ file, title?, chart? }` mappings; problems go to `errors` by field. */
export function parseOutputs(raw: unknown, errors: string[]): OutputSpec[] {
  if (raw === undefined || raw === null) return []
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : null
  if (!list) {
    errors.push('outputs: must be a list of paths in the run folder, or of { file, title, chart } mappings')
    return []
  }
  const outputs: OutputSpec[] = []
  list.forEach((item, i) => {
    const at = `outputs[${i}]`
    if (typeof item === 'string' || typeof item === 'number') {
      const file = String(item).trim()
      if (file) outputs.push({ file, title: fileName(file) })
      return
    }
    if (!isObj(item)) return void errors.push(`${at}: must be a path or a mapping with file (and title, chart)`)
    for (const k of Object.keys(item)) if (!(OUTPUT_FIELDS as readonly string[]).includes(k)) errors.push(`${at}.${k}: is not an output field (use ${OUTPUT_FIELDS.join(', ')})`)
    const file = str(item.file).trim()
    if (!file) errors.push(`${at}.file: is required (a path in the run folder)`)
    if (item.title !== undefined && typeof item.title !== 'string') errors.push(`${at}.title: must be text`)
    const spec: OutputSpec = { file, title: str(item.title).trim() || fileName(file) }
    if (item.chart !== undefined) {
      const chart = parseOutputChart(item.chart, `${at}.chart`, errors)
      if (chart && file && !/\.(csv|tsv|json)$/i.test(file)) errors.push(`${at}.chart: only a .csv, .tsv or .json output can be charted`)
      if (chart) spec.chart = chart
    }
    if (file) outputs.push(spec)
  })
  return outputs
}

function parseOutputChart(raw: unknown, at: string, errors: string[]): OutputChart | undefined {
  if (!isObj(raw)) {
    errors.push(`${at}: must be a mapping with type and x (and y, agg, top, sort)`)
    return undefined
  }
  const before = errors.length
  for (const k of Object.keys(raw)) if (!(CHART_FIELDS as readonly string[]).includes(k)) errors.push(`${at}.${k}: is not a chart field (use ${CHART_FIELDS.join(', ')})`)
  const type = str(raw.type) as ChartType
  if (raw.type === undefined) errors.push(`${at}.type: is required (${CHART_TYPES.join(' or ')})`)
  else if (!CHART_TYPES.includes(type)) errors.push(`${at}.type: "${str(raw.type)}" must be ${CHART_TYPES.join(' or ')}`)
  const x = str(raw.x).trim()
  if (!x) errors.push(`${at}.x: is required (the column to group by)`)
  const y = raw.y === undefined || raw.y === null ? undefined : str(raw.y).trim() || undefined
  if (raw.y !== undefined && raw.y !== null && !y) errors.push(`${at}.y: must name a numeric column`)
  const agg = (raw.agg === undefined ? (y ? 'sum' : 'count') : str(raw.agg)) as ChartAgg
  if (!CHART_AGGS.includes(agg)) errors.push(`${at}.agg: "${str(raw.agg)}" must be one of ${CHART_AGGS.join(', ')}`)
  else if (agg !== 'count' && !y) errors.push(`${at}.agg: ${agg} needs y (a numeric column)`)
  const top = raw.top === undefined ? DEFAULT_CHART_TOP : raw.top
  if (typeof top !== 'number' || !Number.isInteger(top) || top < 1 || top > MAX_CHART_TOP) errors.push(`${at}.top: must be a whole number from 1 to ${MAX_CHART_TOP}`)
  const sort = (raw.sort === undefined ? (type === 'line' ? 'label' : 'value') : str(raw.sort)) as OutputChart['sort']
  if (!CHART_SORTS.includes(sort)) errors.push(`${at}.sort: "${str(raw.sort)}" must be value or label`)
  if (errors.length > before) return undefined
  return { type, x, ...(y ? { y } : {}), agg, top: top as number, sort }
}

function hasCycle(steps: StepSpec[]): boolean {
  const state = new Map<string, 'open' | 'done'>()
  const byId = new Map(steps.map(s => [s.id, s]))
  const visit = (id: string): boolean => {
    if (state.get(id) === 'done') return false
    if (state.get(id) === 'open') return true
    state.set(id, 'open')
    for (const a of byId.get(id)?.after ?? []) if (visit(a)) return true
    state.set(id, 'done')
    return false
  }
  return steps.some(s => visit(s.id))
}

type Ref = { kind: 'inputs' | 'steps' | 'run' | 'item' | 'env' | 'json' | 'filter' | 'bad'; name: string; field?: string }

/** A template's reference and filters: `inputs.x | sh` → ['inputs.x', ['sh']]. */
function splitTemplate(expr: string): { ref: string; filters: string[] } {
  const [ref = '', ...filters] = expr.split('|').map(p => p.trim())
  return { ref, filters }
}

function templateRefs(text: string, itemNames: string[] = []): Ref[] {
  const refs: Ref[] = []
  for (const m of text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    const expr = m[1] ?? ''
    const { ref, filters } = splitTemplate(expr)
    const bad = filters.find(f => !(FILTERS as readonly string[]).includes(f))
    if (bad !== undefined) {
      refs.push({ kind: 'filter', name: expr, field: bad })
      continue
    }
    const input = /^inputs\.([A-Za-z0-9_]+)$/.exec(ref)
    const step = /^steps\.([A-Za-z0-9_-]+)\.(output|files|dir)$/.exec(ref)
    const json = JSON_PATH_RE.exec(ref)
    const env = /^env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref)
    if (input?.[1]) refs.push({ kind: 'inputs', name: input[1] })
    else if (step?.[1]) refs.push({ kind: 'steps', name: step[1], field: step[2] })
    else if (json?.[1]) refs.push({ kind: 'steps', name: json[1], field: 'json' })
    else if (/^steps\.[A-Za-z0-9_-]+\.json\b/.test(ref)) refs.push({ kind: 'json', name: expr })
    else if (env?.[1]) refs.push({ kind: 'env', name: env[1] })
    else if (ref === 'run.dir') refs.push({ kind: 'run', name: ref })
    else if (ref === 'item' || ref === 'item_index' || itemNames.includes(ref)) refs.push({ kind: 'item', name: ref })
    else refs.push({ kind: 'bad', name: expr })
  }
  return refs
}

export type TemplateContext = {
  inputs: Record<string, string>
  outputs: Record<string, string>
  runDir: string
  /** Each done step's outputs: as absolute paths. */
  files?: Record<string, string[]>
  /** A uses step's child run folder (other steps: the run folder). */
  dirs?: Record<string, string>
  /** In a for_each step: the item, its index and its name. */
  item?: { value: string; index: number; as: string }
  /** {{env.NAME}} values (python, mcp and http steps only); absent, env templates stay as written. */
  env?: Record<string, string>
}

/** Quotes a value for bash: 'it'\''s'. */
export const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

// CSI (colours, cursor moves), OSC (titles, links) and two-byte escapes.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const LINE_MAX = 500

/**
 * Terminal output as plain text the pane can draw: escape codes gone, each line
 * as a terminal would leave it after carriage returns, other control characters
 * dropped, and lines cut at 500 characters. Code and Text refuse any control
 * character but tab and newline, and one refused element blanks the whole pane.
 */
export function cleanTerminal(s: string): string {
  return s
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => {
      const shown = line.slice(line.lastIndexOf('\r') + 1).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
      return shown.length > LINE_MAX ? `${shown.slice(0, LINE_MAX)}…` : shown
    })
    .join('\n')
}

function resolveRef(ref: string, ctx: TemplateContext): string | undefined {
  const input = /^inputs\.([A-Za-z0-9_]+)$/.exec(ref)
  if (input?.[1]) return ctx.inputs[input[1]] ?? ''
  const step = /^steps\.([A-Za-z0-9_-]+)\.(output|files|dir)$/.exec(ref)
  if (step?.[1]) {
    if (step[2] === 'files') return (ctx.files?.[step[1]] ?? []).join('\n')
    if (step[2] === 'dir') return ctx.dirs?.[step[1]] ?? ctx.runDir
    return ctx.outputs[step[1]] ?? ''
  }
  const json = JSON_PATH_RE.exec(ref)
  if (json?.[1]) return jsonText(atJsonPath(parseJson(ctx.outputs[json[1]] ?? ''), jsonPathParts(json[2] ?? '')))
  const env = /^env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref)
  if (env?.[1]) return ctx.env && env[1] in ctx.env ? ctx.env[env[1]] : undefined
  if (ref === 'run.dir') return ctx.runDir
  if (ctx.item && (ref === 'item' || ref === ctx.item.as)) return ctx.item.value
  if (ctx.item && ref === 'item_index') return String(ctx.item.index)
  return undefined
}

/**
 * Fills {{inputs.x}}, {{steps.x.output|files|dir}}, {{steps.x.json.<path>}},
 * {{run.dir}}, {{env.NAME}} (when ctx.env has it) and, in a for_each step,
 * {{item}}, {{<as>}} and {{item_index}}; `| sh` quotes the value
 * for bash and `| json` makes it a JSON string. Anything else is left as written.
 */
export function fill(text: string, ctx: TemplateContext): string {
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, expr: string) => {
    const { ref, filters } = splitTemplate(expr)
    let value = resolveRef(ref, ctx)
    if (value === undefined) return whole
    for (const f of filters) {
      if (f === 'sh') value = shQuote(value)
      else if (f === 'json') value = JSON.stringify(value)
      else return whole
    }
    return value
  })
}

// ---------------------------------------------------------------------------
// Conditions (`if:`): a tokenizer and a recursive-descent parser; no eval.

export type CondNode =
  | { k: 'lit'; v: string | number | boolean }
  | { k: 'ref'; path: string[]; json?: (string | number)[] }
  | { k: 'call'; name: 'always' | 'failure' }
  | { k: 'not'; a: CondNode }
  | { k: 'and' | 'or'; a: CondNode; b: CondNode }
  | { k: 'cmp'; op: '==' | '!=' | '<' | '<=' | '>' | '>='; a: CondNode; b: CondNode }

type Tok = { t: 'op' | 'str' | 'num' | 'word'; v: string }

const STEP_FIELDS = ['status', 'output', 'exit']
const CMP_OPS = ['==', '!=', '<', '<=', '>', '>=']

function tokenize(text: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i] ?? ''
    if (/\s/.test(c)) {
      i++
      continue
    }
    const two = text.slice(i, i + 2)
    if (['||', '&&', '==', '!=', '<=', '>='].includes(two)) {
      toks.push({ t: 'op', v: two })
      i += 2
      continue
    }
    if ('!<>()'.includes(c)) {
      toks.push({ t: 'op', v: c })
      i++
      continue
    }
    if (c === '"' || c === "'") {
      let v = ''
      let j = i + 1
      for (; j < text.length && text[j] !== c; j++) {
        if (text[j] === '\\' && j + 1 < text.length) j++
        v += text[j]
      }
      if (j >= text.length) throw new Error(`the string starting at ${c}${text.slice(i + 1, i + 11)} is not closed`)
      toks.push({ t: 'str', v })
      i = j + 1
      continue
    }
    const num = /^-?\d+(\.\d+)?/.exec(text.slice(i))
    if (num && (c !== '-' || /\d/.test(text[i + 1] ?? ''))) {
      toks.push({ t: 'num', v: num[0] })
      i += num[0].length
      continue
    }
    const word = /^[A-Za-z_](?:[A-Za-z0-9_.-]|\[\d+\])*/.exec(text.slice(i))
    if (word) {
      toks.push({ t: 'word', v: word[0] })
      i += word[0].length
      continue
    }
    throw new Error(c === '=' ? 'use == to compare' : `unexpected "${c}"`)
  }
  return toks
}

/** Parses an `if:` expression; `error` says what is wrong with it. */
export function parseCondition(text: string): { node?: CondNode; error?: string } {
  try {
    const toks = tokenize(text)
    if (!toks.length) return { error: 'is empty' }
    let pos = 0
    const peek = () => toks[pos]
    const isOp = (v: string) => peek()?.t === 'op' && peek()?.v === v
    const describe = (t: Tok | undefined) => (t ? `"${t.v}"` : 'the end')
    const expect = (v: string) => {
      if (!isOp(v)) throw new Error(`expected "${v}" but found ${describe(peek())}`)
      pos++
    }
    const primary = (): CondNode => {
      const t = peek()
      if (!t) throw new Error('expected a value but found the end')
      if (t.t === 'op' && t.v === '(') {
        pos++
        const node = or()
        expect(')')
        return node
      }
      if (t.t === 'str') return pos++, { k: 'lit', v: t.v }
      if (t.t === 'num') return pos++, { k: 'lit', v: Number(t.v) }
      if (t.t !== 'word') throw new Error(`expected a value but found ${describe(t)}`)
      pos++
      if (t.v === 'true' || t.v === 'false') return { k: 'lit', v: t.v === 'true' }
      if (isOp('(')) {
        if (t.v !== 'always' && t.v !== 'failure') throw new Error(`"${t.v}()" is not a function (use always() or failure())`)
        pos++
        expect(')')
        return { k: 'call', name: t.v }
      }
      const json = JSON_PATH_RE.exec(t.v)
      if (json?.[1]) return { k: 'ref', path: ['steps', json[1], 'json'], json: jsonPathParts(json[2] ?? '') }
      const path = t.v.split('.')
      if (!t.v.includes('[')) {
        if (path[0] === 'inputs' && path.length === 2 && path[1]) return { k: 'ref', path }
        if (path[0] === 'steps' && path.length === 3 && path[1] && STEP_FIELDS.includes(path[2] ?? '')) return { k: 'ref', path }
      }
      throw new Error(`"${t.v}" is not a reference (use inputs.<id>, steps.<id>.status, steps.<id>.output, steps.<id>.exit or steps.<id>.json.<path>)`)
    }
    const unary = (): CondNode => {
      if (isOp('!')) {
        pos++
        return { k: 'not', a: unary() }
      }
      return primary()
    }
    const cmp = (): CondNode => {
      const a = unary()
      const t = peek()
      if (t?.t === 'op' && CMP_OPS.includes(t.v)) {
        pos++
        return { k: 'cmp', op: t.v as '==', a, b: unary() }
      }
      return a
    }
    const and = (): CondNode => {
      let a = cmp()
      while (isOp('&&')) {
        pos++
        a = { k: 'and', a, b: cmp() }
      }
      return a
    }
    const or = (): CondNode => {
      let a = and()
      while (isOp('||')) {
        pos++
        a = { k: 'or', a, b: and() }
      }
      return a
    }
    const node = or()
    if (pos < toks.length) throw new Error(`unexpected ${describe(peek())}`)
    return { node }
  } catch (err) {
    return { error: String((err as Error)?.message ?? err) }
  }
}

/** The references a condition makes: ['inputs', id] or ['steps', id, field]. */
export function conditionRefs(node: CondNode): string[][] {
  switch (node.k) {
    case 'ref':
      return [node.path]
    case 'not':
      return conditionRefs(node.a)
    case 'and':
    case 'or':
    case 'cmp':
      return [...conditionRefs(node.a), ...conditionRefs(node.b)]
    default:
      return []
  }
}

/** Whether a condition uses always() or failure(): then it runs once its after steps settle, however they ended. */
export function checksStatus(node: CondNode): boolean {
  if (node.k === 'call') return true
  if (node.k === 'not') return checksStatus(node.a)
  if (node.k === 'and' || node.k === 'or' || node.k === 'cmp') return checksStatus(node.a) || checksStatus(node.b)
  return false
}

export type ConditionScope = {
  inputs: Record<string, string>
  steps: Record<string, { status: string; output: string; exit: string; json?: unknown }>
  /** The statuses of the step's `after` steps. */
  after: string[]
}

type Value = string | number | boolean

/** Non-empty and not "false" or "0". */
export const isTruthy = (v: Value) => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 && !Number.isNaN(v) : v !== '' && v !== 'false' && v !== '0')

function valueOf(node: CondNode, scope: ConditionScope): Value {
  switch (node.k) {
    case 'lit':
      return node.v
    case 'ref': {
      const [root, id = '', field = ''] = node.path
      if (root === 'inputs') return scope.inputs[id] ?? ''
      const step = scope.steps[id]
      if (field === 'json') {
        const v = atJsonPath(step ? (step.json !== undefined ? step.json : parseJson(step.output)) : null, node.json ?? [])
        return typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ? v : jsonText(v)
      }
      return step ? (step[field as 'status'] ?? '') : ''
    }
    case 'call':
      return node.name === 'always' ? true : scope.after.includes('failed')
    case 'not':
      return !isTruthy(valueOf(node.a, scope))
    case 'and':
      return isTruthy(valueOf(node.a, scope)) && isTruthy(valueOf(node.b, scope))
    case 'or':
      return isTruthy(valueOf(node.a, scope)) || isTruthy(valueOf(node.b, scope))
    case 'cmp': {
      const a = valueOf(node.a, scope)
      const b = valueOf(node.b, scope)
      const num = (v: Value) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined)
      const na = num(a)
      const nb = num(b)
      const [x, y]: [Value, Value] = na !== undefined && nb !== undefined ? [na, nb] : [String(a), String(b)]
      if (node.op === '==') return x === y
      if (node.op === '!=') return x !== y
      if (node.op === '<') return x < y
      if (node.op === '<=') return x <= y
      if (node.op === '>') return x > y
      return x >= y
    }
  }
}

/** Evaluates a parsed condition to true or false. */
export function evalCondition(node: CondNode, scope: ConditionScope): boolean {
  return isTruthy(valueOf(node, scope))
}

/** A wait step's `until:` as a time: HH:MM is its next occurrence, a date alone is its local midnight. */
export function untilTime(text: string, now: Date): number | undefined {
  const hm = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (hm) {
    const h = Number(hm[1])
    const m = Number(hm[2])
    if (h > 23 || m > 59) return undefined
    const d = new Date(now)
    d.setHours(h, m, 0, 0)
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
  if (day) {
    const t = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime()
    return Number.isNaN(t) ? undefined : t
  }
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text.trim())) return undefined
  const t = Date.parse(text.trim().replace(' ', 'T'))
  return Number.isNaN(t) ? undefined : t
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const isoDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/** An input's starting value: its default, with date words (today, yesterday, last-monday) resolved. */
export function defaultValue(input: InputSpec, now = new Date()): string {
  if (input.type === 'boolean') return input.default === 'true' ? 'true' : 'false'
  if (input.type === 'select' && input.multiple) return input.default
  if (input.type === 'select') return input.options.includes(input.default) || input.remember ? input.default || (input.options[0] ?? '') : input.options[0] ?? ''
  if (input.type !== 'date') return input.default
  const d = new Date(now)
  if (input.default === 'today') return isoDay(d)
  if (input.default === 'yesterday') return isoDay(new Date(d.getTime() - 86_400_000))
  const weekday = /^last-(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.exec(input.default)
  if (weekday?.[1]) {
    const target = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(weekday[1])
    const back = ((d.getDay() - target + 7) % 7) || 7
    return isoDay(new Date(d.getTime() - back * 86_400_000))
  }
  return input.default
}

/** What stops a run from starting: required inputs left empty, values of the wrong shape. */
export function inputProblems(wf: Workflow, values: Record<string, string>): string[] {
  const problems: string[] = []
  for (const input of wf.inputs) {
    const value = (values[input.id] ?? '').trim()
    if (!value) {
      if (input.required) problems.push(`${input.label} is required`)
      continue
    }
    if (input.type === 'number' && !Number.isFinite(Number(value))) problems.push(`${input.label} must be a number`)
    if (input.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) problems.push(`${input.label} must be a date (YYYY-MM-DD)`)
    if (input.type === 'select' && !input.remember) {
      // A remembered select takes new values too; a fixed one only its options.
      const picked = input.multiple ? value.split('\n').map(v => v.trim()).filter(Boolean) : [value]
      for (const v of picked) if (!input.options.includes(v)) problems.push(`${input.label}: "${v}" must be one of ${input.options.join(', ')}`)
    }
    if (input.type === 'file' && input.accept.length) {
      const files = input.multiple ? value.split('\n').filter(Boolean) : [value]
      for (const f of files)
        if (!input.accept.some(a => f.toLowerCase().endsWith(a))) problems.push(`${input.label}: ${f.split('/').pop()} is not ${input.accept.join(' or ')}`)
    }
  }
  return problems
}

/** Steps grouped into the order they can run in: each group waits only for earlier groups. */
export function stepLevels(steps: StepSpec[]): StepSpec[][] {
  const level = new Map<string, number>()
  const byId = new Map(steps.map(s => [s.id, s]))
  const depth = (s: StepSpec, seen = new Set<string>()): number => {
    const known = level.get(s.id)
    if (known !== undefined) return known
    if (seen.has(s.id)) return 0
    seen.add(s.id)
    const d = s.after.length ? 1 + Math.max(...s.after.map(a => (byId.get(a) ? depth(byId.get(a) as StepSpec, seen) : 0))) : 0
    level.set(s.id, d)
    return d
  }
  const groups: StepSpec[][] = []
  for (const s of steps) {
    const d = depth(s)
    ;(groups[d] ??= []).push(s)
  }
  return groups.filter(Boolean)
}
