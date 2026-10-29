// A run's Results, the pure part: CSV/TSV/JSON tables, the charts made from
// them (a declared output's `chart:`) or read from `*.chart.json`, and how
// each draws: an svg string on desktop, text bars in the terminal, a
// Markdown table preview. No `$` and no elements here: hooks/hub.tsx draws.

import type { ChartData, OutputChart } from '../types'
import { C } from './hub-parts'

/** Biggest file Results reads (a summary, a table, a chart's data). */
export const MAX_RESULT_BYTES = 2 * 1024 * 1024

/**
 * Series colors, in order: the hub's blue, orange, teal, yellow and pink,
 * stepped into the dark-surface band and checked as a set with the dataviz
 * validator on C.card (lightness, chroma, adjacent CVD and normal-vision
 * separation, contrast: all pass). A sixth series is not drawn.
 */
export const SERIES = ['#4a90e0', '#d9732f', '#0fa392', '#b38716', '#d06aa8'] as const
export const MAX_BARS = 30
/** A line's latest points drawn (an Svg's markup is at most 131072 characters). */
export const MAX_POINTS = 365

export type Table = { header: string[]; rows: string[][] }

// ── tables ───────────────────────────────────────────────────────────────

/** CSV or TSV rows: quoted fields (with "" for a quote, delimiters and newlines inside), CRLF or LF, a BOM. Blank rows are dropped. */
export function parseDelimited(text: string, delim = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let isQuoted = false
  let isField = false
  const endRow = () => {
    row.push(field)
    rows.push(row)
    row = []
    field = ''
    isField = false
  }
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i]
    if (isQuoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else isQuoted = false
      } else field += c
      continue
    }
    if (c === '"' && !isField) {
      isQuoted = true
      isField = true
    } else if (c === delim) {
      row.push(field)
      field = ''
      isField = false
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++
      endRow()
    } else {
      field += c
      isField = true
    }
  }
  if (isField || field || row.length) endRow()
  return rows.filter(r => r.some(cell => cell.trim() !== ''))
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const cellText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

/** A .csv, .tsv or .json (an array of objects) file as a header and rows. */
export function tableOf(text: string, file: string): { table?: Table; problem?: string } {
  const ext = (file.split('.').pop() ?? '').toLowerCase()
  if (ext === 'json') {
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch {
      return { problem: `${baseOf(file)} is not JSON` }
    }
    if (!Array.isArray(doc) || !doc.every(isObj)) return { problem: `${baseOf(file)} is not a JSON array of objects` }
    const header: string[] = []
    for (const o of doc as Record<string, unknown>[]) for (const k of Object.keys(o)) if (!header.includes(k)) header.push(k)
    return { table: { header, rows: (doc as Record<string, unknown>[]).map(o => header.map(k => cellText(o[k]))) } }
  }
  const all = parseDelimited(text, ext === 'tsv' ? '\t' : ',')
  const [header, ...rows] = all
  if (!header) return { problem: `${baseOf(file)} is empty` }
  return { table: { header: header.map(h => h.trim()), rows } }
}

const baseOf = (p: string) => p.split('/').pop() || p

/** The column's index: exact, else ignoring case and spaces at the ends; -1 when there is none. */
export function columnIndex(header: string[], name: string): number {
  const exact = header.indexOf(name)
  if (exact >= 0) return exact
  const want = name.trim().toLowerCase()
  return header.findIndex(h => h.trim().toLowerCase() === want)
}

/** A number as a table writes one: `1,234.5`, `$40`, `-3`; NaN for anything else. */
export function toNumber(text: string): number {
  const s = text.trim().replace(/^([-+]?)\$/, '$1').replace(/,(?=\d{3}(\D|$))/g, '')
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return Number.NaN
  return Number(s)
}

const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)

/** A declared chart from a table: one value per group of `x`, the biggest `top` groups, ordered by `sort`. */
export function chartFromTable(table: Table, chart: OutputChart, title: string): { data?: ChartData; problem?: string } {
  const xi = columnIndex(table.header, chart.x)
  if (xi < 0) return { problem: `no column ${chart.x}` }
  const yi = chart.y ? columnIndex(table.header, chart.y) : -1
  if (chart.y && yi < 0) return { problem: `no column ${chart.y}` }
  const groups = new Map<string, { sum: number; n: number }>()
  for (const [r, row] of table.rows.entries()) {
    const label = (row[xi] ?? '').trim() || '(blank)'
    const g = groups.get(label) ?? { sum: 0, n: 0 }
    if (chart.agg === 'count') g.n++
    else {
      const raw = (row[yi] ?? '').trim()
      if (!raw) continue
      const v = toNumber(raw)
      if (Number.isNaN(v)) return { problem: `${chart.y} is not numeric (row ${r + 2}: "${clipText(raw, 20)}")` }
      g.sum += v
      g.n++
    }
    groups.set(label, g)
  }
  const entries = [...groups].filter(([, g]) => g.n > 0)
  if (!entries.length) return { problem: 'no rows to chart' }
  const valueOf = (g: { sum: number; n: number }) => (chart.agg === 'count' ? g.n : chart.agg === 'mean' ? g.sum / g.n : g.sum)
  const kept = entries
    .map(([label, g]) => ({ label, value: valueOf(g) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, chart.top)
  if (chart.sort === 'label') kept.sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }))
  const name = chart.agg === 'count' ? 'count' : `${chart.agg} of ${chart.y}`
  return { data: { type: chart.type, title, labels: kept.map(k => k.label), series: [{ name, values: kept.map(k => k.value) }], yLabel: chart.agg === 'count' ? `rows by ${chart.x}` : `${name} by ${chart.x}` } }
}

/** A `*.chart.json` file (flow.chart): checked as the hub draws it. */
export function chartFromJson(text: string, fallbackTitle: string): { data?: ChartData; problem?: string } {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return { problem: 'not JSON' }
  }
  if (!isObj(doc)) return { problem: 'must be an object with type, labels and series' }
  if (doc.type !== 'bar' && doc.type !== 'line') return { problem: `type ${doc.type === undefined ? 'is missing' : `"${cellText(doc.type)}"`}: use bar or line` }
  if (!Array.isArray(doc.labels)) return { problem: 'labels must be a list' }
  const labels = doc.labels.map(cellText)
  if (!Array.isArray(doc.series) || !doc.series.length) return { problem: 'series must be a list of { name, values }' }
  const series: ChartData['series'] = []
  for (const [i, s] of doc.series.entries()) {
    if (!isObj(s) || !Array.isArray(s.values)) return { problem: `series[${i}] must be { name, values }` }
    const name = cellText(s.name) || `series ${i + 1}`
    if (s.values.length !== labels.length) return { problem: `series "${name}" has ${s.values.length} values for ${labels.length} labels` }
    if (!s.values.every(v => typeof v === 'number' && Number.isFinite(v))) return { problem: `series "${name}" has a value that is not a number` }
    series.push({ name, values: s.values as number[] })
  }
  if (!labels.length) return { problem: 'no labels to chart' }
  const title = typeof doc.title === 'string' && doc.title.trim() ? doc.title.trim() : fallbackTitle
  return { data: { type: doc.type, title, labels, series, ...(typeof doc.yLabel === 'string' && doc.yLabel.trim() ? { yLabel: doc.yLabel.trim() } : {}) } }
}

/** What a chart draws: at most SERIES.length series, MAX_BARS bars or a line's last MAX_POINTS points; and what was left out. */
export function drawnPart(data: ChartData): { data: ChartData; left: string[] } {
  const left: string[] = []
  let { labels, series } = data
  if (series.length > SERIES.length) {
    left.push(`${series.length - SERIES.length} more series not shown`)
    series = series.slice(0, SERIES.length)
  }
  if (data.type === 'bar' && labels.length > MAX_BARS) {
    left.push(`${labels.length - MAX_BARS} more bars not shown`)
    labels = labels.slice(0, MAX_BARS)
    series = series.map(s => ({ ...s, values: s.values.slice(0, MAX_BARS) }))
  }
  if (data.type === 'line' && labels.length > MAX_POINTS) {
    left.push(`${labels.length - MAX_POINTS} earlier points not shown`)
    labels = labels.slice(-MAX_POINTS)
    series = series.map(s => ({ ...s, values: s.values.slice(-MAX_POINTS) }))
  }
  return { data: { ...data, labels, series }, left }
}

/** A Markdown table of the first rows and columns, cells clipped. */
export function tableMarkdown(table: Table, maxRows = 10, maxCols = 8, maxCell = 24): string {
  const cols = Math.min(maxCols, table.header.length)
  const cell = (s: string) => clipText(s.replace(/\s+/g, ' ').trim(), maxCell).replace(/\\/g, '\\\\').replace(/\|/g, '\\|') || ' '
  const line = (cells: string[]) => `| ${Array.from({ length: cols }, (_, i) => cell(cells[i] ?? '')).join(' | ')} |`
  return [line(table.header), `|${' --- |'.repeat(cols)}`, ...table.rows.slice(0, maxRows).map(line)].join('\n')
}

// ── numbers ──────────────────────────────────────────────────────────────

const groupDigits = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const trimZeros = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s)

/** A value as a label: 1,284 · 12.9K · 4.2M · 3.75. */
export function formatValue(v: number): string {
  const a = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (a >= 1e9) return `${sign}${trimZeros((a / 1e9).toFixed(1))}B`
  if (a >= 1e6) return `${sign}${trimZeros((a / 1e6).toFixed(1))}M`
  if (a >= 1e4) return `${sign}${trimZeros((a / 1e3).toFixed(1))}K`
  const [whole = '0', frac] = trimZeros(a.toFixed(2)).split('.')
  return `${sign}${groupDigits(whole)}${frac ? `.${frac}` : ''}`
}

/** An axis tick: compact from 1,000 up (0 · 500 · 1K · 1.5K). */
export function formatTick(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e3 && a < 1e4) return `${v < 0 ? '-' : ''}${trimZeros((a / 1e3).toFixed(1))}K`
  return formatValue(v)
}

function niceStep(raw: number): number {
  const exp = Math.floor(Math.log10(raw))
  const f = raw / 10 ** exp
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return nice * 10 ** exp
}

/** 3 to 5 round ticks covering [min, max] (and 0); whole numbers only for whole-number data. */
export function niceTicks(min: number, max: number, isWhole = false): number[] {
  const lo = Math.min(0, min)
  const hi = Math.max(0, max) === lo ? lo + 1 : Math.max(0, max)
  // Of the round steps giving 3 to 5 ticks: the tightest span, then the most ticks.
  let best: number[] = []
  const span = (t: number[]) => (t[t.length - 1] ?? 0) - (t[0] ?? 0)
  for (const count of [3, 4, 5, 6]) {
    const step = niceStep((hi - lo) / (count - 1))
    if (isWhole && !Number.isInteger(step)) continue
    const start = Math.floor(lo / step) * step
    const end = Math.ceil(hi / step) * step
    const n = Math.round((end - start) / step) + 1
    if (n < 3 || n > 5) continue
    const ticks = Array.from({ length: n }, (_, i) => Number((start + i * step).toPrecision(12)))
    if (!best.length || span(ticks) < span(best) - 1e-9 || (Math.abs(span(ticks) - span(best)) <= 1e-9 && n > best.length)) best = ticks
  }
  return best.length ? best : [lo, hi]
}

// ── svg (desktop) ────────────────────────────────────────────────────────

const FONT = 11
/** An 11 px sans figure or letter, on average: what labels are measured with. */
const CH = 6.6
const FONT_FAMILY = `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`
const GRID = C.border
const BASELINE = C.faint

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const r1 = (n: number) => Math.round(n * 10) / 10
const textW = (s: string) => s.length * CH

function text(x: number, y: number, s: string, fill: string, anchor: 'start' | 'middle' | 'end' = 'start', extra = '') {
  return `<text x="${r1(x)}" y="${r1(y)}" fill="${fill}" text-anchor="${anchor}"${extra}>${esc(s)}</text>`
}

function svgDoc(width: number, height: number, body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT_FAMILY}" font-size="${FONT}">${body}</svg>`
}

/** Swatches and names, left to right, for two or more series. */
function legend(series: ChartData['series'], y: number): string {
  if (series.length < 2) return ''
  let x = 0
  return series
    .map((s, j) => {
      const name = clipText(s.name, 18)
      const out = `<rect x="${r1(x)}" y="${y}" width="10" height="10" rx="2" fill="${SERIES[j]}"/>${text(x + 14, y + 9, name, C.body)}`
      x += 14 + textW(name) + 14
      return out
    })
    .join('')
}

/** A horizontal bar from the baseline `xa` to `xb`: square at the baseline, 4 px round at the data end. */
function hBar(xa: number, xb: number, y: number, h: number): string {
  const w = Math.abs(xb - xa)
  if (w < 0.5) return ''
  const r = Math.min(4, h / 2, w)
  const d = xb >= xa ? 1 : -1
  const e = xb - d * r
  return `M${r1(xa)} ${r1(y)}H${r1(e)}Q${r1(xb)} ${r1(y)} ${r1(xb)} ${r1(y + r)}V${r1(y + h - r)}Q${r1(xb)} ${r1(y + h)} ${r1(e)} ${r1(y + h)}H${r1(xa)}Z`
}

/** Bars (horizontal, so long labels read): one band per label, grouped by series, value at the tip of a lone series. */
export function barChartSvg(data: ChartData, width: number): string {
  const { labels, series } = data
  const k = series.length
  const all = series.flatMap(s => s.values)
  const ticks = niceTicks(Math.min(...all), Math.max(...all), all.every(Number.isInteger))
  const lo = ticks[0] ?? 0
  const hi = ticks[ticks.length - 1] ?? 1
  const thick = k === 1 ? 16 : k === 2 ? 10 : 8
  const groupH = k * thick + (k - 1) * 2
  const rowH = groupH + 10
  const top = k > 1 ? 22 : 4
  const plotH = labels.length * rowH
  const height = top + plotH + 20
  const labelChars = Math.max(4, Math.floor((Math.min(width * 0.38, Math.max(...labels.map(l => l.length), 4) * CH + 10) - 10) / CH))
  const labelW = labelChars * CH + 10
  const valuePad = k === 1 ? Math.max(...series[0]!.values.map(v => textW(formatValue(v)))) + 10 : 12
  const x0 = labelW
  const x1 = Math.max(x0 + 40, width - valuePad)
  const xOf = (v: number) => x0 + ((v - lo) / (hi - lo || 1)) * (x1 - x0)
  const zero = xOf(0)
  const parts: string[] = [legend(series, 2)]
  // value axis: hairline gridlines and their ticks under the plot
  for (const t of ticks) {
    const x = xOf(t)
    parts.push(`<line x1="${r1(x)}" y1="${top}" x2="${r1(x)}" y2="${top + plotH}" stroke="${t === 0 ? BASELINE : GRID}" stroke-width="1"/>`)
    const w = textW(formatTick(t))
    const anchor = x + w / 2 > width ? 'end' : 'middle'
    parts.push(text(anchor === 'end' ? width : x, top + plotH + 14, formatTick(t), C.dim, anchor, ' style="font-variant-numeric: tabular-nums"'))
  }
  labels.forEach((label, i) => {
    const y = top + i * rowH + 5
    parts.push(text(labelW - 8, y + groupH / 2 + 4, clipText(label, labelChars), C.body, 'end'))
    series.forEach((s, j) => {
      const v = s.values[i] ?? 0
      const by = y + j * (thick + 2)
      const tip = `${label}${k > 1 ? ` · ${s.name}` : ''}: ${formatValue(v)}`
      const path = hBar(zero, xOf(v), by, thick)
      parts.push(
        `<g><title>${esc(tip)}</title><rect x="0" y="${r1(by - 1)}" width="${width}" height="${thick + 2}" fill="transparent"/>${path ? `<path d="${path}" fill="${SERIES[j]}"/>` : ''}</g>`,
      )
      if (k === 1) {
        const end = xOf(v)
        parts.push(text(v < 0 ? end - 6 : end + 6, by + thick / 2 + 4, formatValue(v), C.text, v < 0 ? 'end' : 'start', ' style="font-variant-numeric: tabular-nums"'))
      }
    })
  })
  return svgDoc(width, height, parts.join(''))
}

/** Lines: one 2 px line per series over the labels in order, points marked, the last value of a lone series labelled. */
export function lineChartSvg(data: ChartData, width: number): string {
  const { labels, series } = data
  const k = series.length
  const n = labels.length
  const all = series.flatMap(s => s.values)
  const ticks = niceTicks(Math.min(...all), Math.max(...all), all.every(Number.isInteger))
  const lo = ticks[0] ?? 0
  const hi = ticks[ticks.length - 1] ?? 1
  const top = k > 1 ? 26 : 8
  const plotH = 160
  const bottom = top + plotH
  const height = bottom + 22
  const x0 = Math.max(...ticks.map(t => textW(formatTick(t)))) + 10
  const last = series[0]?.values[n - 1] ?? 0
  const x1 = width - (k === 1 ? textW(formatValue(last)) + 14 : 10)
  const xOf = (i: number) => (n === 1 ? (x0 + x1) / 2 : x0 + (i * (x1 - x0)) / (n - 1))
  const yOf = (v: number) => bottom - ((v - lo) / (hi - lo || 1)) * plotH
  const parts: string[] = [legend(series, 2)]
  for (const t of ticks) {
    const y = yOf(t)
    parts.push(`<line x1="${r1(x0)}" y1="${r1(y)}" x2="${r1(x1)}" y2="${r1(y)}" stroke="${t === lo || t === 0 ? BASELINE : GRID}" stroke-width="1"/>`)
    parts.push(text(x0 - 6, y + 4, formatTick(t), C.dim, 'end', ' style="font-variant-numeric: tabular-nums"'))
  }
  // label axis: the first and the last label, and between them every one that fits without touching its neighbours
  const labelChars = Math.min(12, Math.max(...labels.map(l => l.length), 1))
  const placed = labels.map((l, i) => {
    const s = clipText(l, labelChars)
    const w = textW(s)
    const anchor: 'start' | 'middle' | 'end' = n > 1 && i === 0 ? 'start' : n > 1 && i === n - 1 ? 'end' : 'middle'
    const x = xOf(i)
    const left = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2
    return { i, s, x, anchor, left, right: left + w }
  })
  const kept: typeof placed = []
  const lastLabel = placed[n - 1]
  for (const p of placed.slice(0, -1)) {
    const prev = kept[kept.length - 1]
    if (prev && p.left < prev.right + 12) continue
    if (lastLabel && n > 1 && p.right + 12 > lastLabel.left) continue
    kept.push(p)
  }
  if (lastLabel) kept.push(lastLabel)
  for (const p of kept) parts.push(text(p.x, bottom + 15, p.s, C.dim, p.anchor))
  const isMarked = n <= 40
  series.forEach((s, j) => {
    const pts = s.values.map((v, i) => `${r1(xOf(i))},${r1(yOf(v))}`)
    if (n > 1) parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${SERIES[j]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`)
    s.values.forEach((v, i) => {
      if (isMarked || i === n - 1) parts.push(`<circle cx="${r1(xOf(i))}" cy="${r1(yOf(v))}" r="4" fill="${SERIES[j]}" stroke="${C.card}" stroke-width="2"/>`)
    })
  })
  if (k === 1 && n) parts.push(text(xOf(n - 1) + 8, yOf(last) + 4, formatValue(last), C.text, 'start', ' style="font-variant-numeric: tabular-nums"'))
  // hover: one band per label, its tooltip every series' value there
  labels.forEach((label, i) => {
    const left = i === 0 ? x0 : (xOf(i - 1) + xOf(i)) / 2
    const right = i === n - 1 ? x1 : (xOf(i) + xOf(i + 1)) / 2
    const tip = [label, ...series.map(s => `${k > 1 ? `${s.name}: ` : ''}${formatValue(s.values[i] ?? 0)}`)].join('\n')
    parts.push(`<g><title>${esc(tip)}</title><rect x="${r1(left)}" y="${top}" width="${r1(Math.max(1, right - left))}" height="${plotH}" fill="transparent"/></g>`)
  })
  return svgDoc(width, height, parts.join(''))
}

export const chartSvg = (data: ChartData, width: number) => (data.type === 'line' ? lineChartSvg(data, width) : barChartSvg(data, width))

/** What a reader without the drawing gets: the title and every value. */
export function chartAlt(data: ChartData): string {
  const values = data.labels.map((l, i) => `${l} ${data.series.map(s => formatValue(s.values[i] ?? 0)).join('/')}`)
  return clipText(`${data.type === 'line' ? 'Line' : 'Bar'} chart, ${data.title}: ${values.join(', ')}`, 600)
}

// ── text bars (terminal) ─────────────────────────────────────────────────

export type TextBarRow = { label: string; bar: string; value: string; color: string }

/** One row per label (and per series under it): the label, █ scaled to the largest value, the value. */
export function textBars(data: ChartData, cols: number, maxRows = 30): { rows: TextBarRow[]; left: number } {
  const k = data.series.length
  let idx = data.labels.map((_, i) => i)
  let left = 0
  const perLabel = Math.max(1, Math.floor(maxRows / k))
  if (idx.length > perLabel) {
    left = idx.length - perLabel
    // a line's latest points, a bar chart's first (biggest) bars
    idx = data.type === 'line' ? idx.slice(-perLabel) : idx.slice(0, perLabel)
  }
  const labelW = Math.min(18, Math.max(4, ...idx.map(i => (data.labels[i] ?? '').length)))
  const values = data.series.flatMap(s => idx.map(i => s.values[i] ?? 0))
  const valueW = Math.max(...values.map(v => formatValue(v).length))
  const barW = Math.max(6, cols - labelW - valueW - 4)
  const max = Math.max(...values.map(v => Math.abs(v)), 0) || 1
  const rows: TextBarRow[] = []
  for (const i of idx)
    data.series.forEach((s, j) => {
      const v = s.values[i] ?? 0
      const len = v === 0 ? 0 : Math.max(1, Math.round((Math.abs(v) / max) * barW))
      const label = j === 0 ? clipText(data.labels[i] ?? '', labelW) : ''
      rows.push({ label: label.padEnd(labelW), bar: (v < 0 ? '░' : '█').repeat(len), value: formatValue(v), color: SERIES[j] ?? C.blue })
    })
  return { rows, left }
}
