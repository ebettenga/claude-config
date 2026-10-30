// A run's buttons: `buttons.json` in the run folder (flow.button in python),
// drawn in the hub's Results as rows under their group, each opening its link.
// Only Jamf Self Service and https links open: a workflow cannot open anything
// else on the Mac.

export type RunButton = { label: string; url: string; note: string; group: string }

export const BUTTONS_FILE = 'buttons.json'
export const MAX_BUTTONS = 40
const SCHEMES = ['jamfselfservice:', 'selfservice:', 'https:']

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** Whether a link may open: a Self Service or https URL, without spaces or control characters. */
export function isOpenable(url: string): boolean {
  if (!url || url.length > 2048 || /[\s\u0000-\u001f]/.test(url)) return false
  const lower = url.toLowerCase()
  return SCHEMES.some(s => lower.startsWith(s) && lower.length > s.length)
}

/** `buttons.json`: the buttons to draw, and a line for each one left out. */
export function buttonsFromJson(text: string): { buttons: RunButton[]; problems: string[] } {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return { buttons: [], problems: [`${BUTTONS_FILE}: not JSON`] }
  }
  if (!Array.isArray(doc)) return { buttons: [], problems: [`${BUTTONS_FILE}: must be a list of { label, url, note, group }`] }
  const buttons: RunButton[] = []
  const problems: string[] = []
  for (const [i, b] of doc.entries()) {
    if (buttons.length >= MAX_BUTTONS) {
      problems.push(`${doc.length - MAX_BUTTONS} more buttons not shown`)
      break
    }
    const label = isObj(b) ? str(b.label).slice(0, 60) : ''
    const url = isObj(b) ? str(b.url) : ''
    if (!label) problems.push(`button ${i + 1}: has no label`)
    else if (!isOpenable(url)) problems.push(`button "${label}": only jamfselfservice: and https: links open`)
    else buttons.push({ label, url, note: str((b as Record<string, unknown>).note), group: str((b as Record<string, unknown>).group) })
  }
  return { buttons, problems }
}

/** The buttons by group, groups in the order they first appear; an ungrouped button's group is ''. */
export function groupButtons(buttons: RunButton[]): { group: string; buttons: RunButton[] }[] {
  const groups = new Map<string, RunButton[]>()
  for (const b of buttons) groups.set(b.group, [...(groups.get(b.group) ?? []), b])
  return [...groups].map(([group, list]) => ({ group, buttons: list }))
}
