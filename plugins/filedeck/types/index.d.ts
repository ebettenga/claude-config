export type Touch = { path: string; kind: 'read' | 'edit'; isActive: boolean; at: number }
export type GitFile = { path: string; x: string; y: string; add: number; del: number }
export type GitSnap = {
  isRepo: boolean
  root: string
  branch: string
  upstream: string
  ahead: number
  behind: number
  files: GitFile[]
  ignored: string[]
  at: number
}
export type Tab = 'files' | 'changes'
export type PreviewMode = 'diff' | 'file'

declare module 'claude-code' {
  interface PluginState {
    filedeck: {
      expanded: Shaped<string[]>
      touched: Shaped<Touch[]>
      git: Shaped<GitSnap>
      busy: Shaped<string>
      note: Shaped<string>
      showHidden: Shaped<boolean>
      showSizes: Shaped<boolean>
      tab: Shaped<Tab>
      tick: Shaped<number>
      query: Shaped<string>
      viewRoot: Shaped<string>
      selection: Shaped<string>
      previewMode: Shaped<PreviewMode>
    }
  }
}
