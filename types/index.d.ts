export type Scope = 'unstaged' | 'staged' | 'branch' | 'commit' | 'turn'

export type LineKind = ' ' | '+' | '-'

export type DiffLine = {
  kind: LineKind
  text: string
  oldNo?: number
  newNo?: number
}

export type Hunk = { header: string; lines: DiffLine[] }

export type FileDiff = {
  path: string
  oldPath?: string
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  added: number
  removed: number
  isBinary: boolean
  hunks: Hunk[]
}

// A comment is anchored to one side of the diff: `new` for added and context
// lines, `old` for removed lines. `repo` is the repository's absolute root,
// `file` relative to it; `lineText` lets a later diff find it again.
export type Comment = {
  id: string
  repo: string
  file: string
  side: 'old' | 'new'
  line: number
  lineText: string
  text: string
  isSent: boolean
}

export type Draft = Omit<Comment, 'id' | 'text' | 'isSent'>

// One repository's files in the drawn scope: one group for a single-repo
// scope, one per changed repository for Last turn.
export type RepoGroup = { root: string; name: string; files: FileDiff[] }

// `isTouched`: this session changed it (an Edit or Write there, a turn that
// changed its tree or HEAD, or added by hand).
export type RepoSummary = { root: string; name: string; changed: number; isTouched: boolean }

// `repos` are the chips drawn; `others` the changed repositories the session
// did not touch, drawn only on request. `root` and `scope` name what `groups`
// were loaded for, so a drawing can tell a stale snapshot from an empty one.
export type Snapshot = {
  groups: RepoGroup[]
  repos: RepoSummary[]
  others: RepoSummary[]
  error: string | null
  branches: string[]
  commits: { sha: string; subject: string }[]
  root: string | null
  scope: Scope | null
}

declare module 'claude-code' {
  interface PluginState {
    'review-pane': {
      scope: Scope
      repos: string[]
      repo: string | null
      base: Record<string, string>
      commit: string | null
      collapsed: string[]
      draft: Draft | null
      turnBase: Record<string, string>
      turnFiles: Record<string, string[]>
      turnPrint: Record<string, string>
      touched: string[]
      showAll: boolean
      snapshot: Shaped<Snapshot>
      comments: Shaped<Comment[]>
    }
  }
}
