import type { Comment, DiffLine, FileDiff, Hunk, Scope } from '../types'

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-renames', '-U3']

export type ScopeArgs = {
  scope: Scope
  mergeBase: string | null
  commit: string | null
  turnBase: string | null
  turnFiles: readonly string[]
}

// The argv that diffs one untracked file as all-added; git exits 1 on a difference.
export function untrackedArgv(path: string): string[] {
  return ['git', 'diff', '--no-index', ...DIFF_FLAGS, '--', '/dev/null', path]
}

// The git argv that yields the scope's diff in one repository, or a reason it
// has none yet.
export function diffArgv(a: ScopeArgs): string[] | { reason: string } {
  switch (a.scope) {
    case 'unstaged':
      return ['git', 'diff', ...DIFF_FLAGS]
    case 'staged':
      return ['git', 'diff', '--cached', ...DIFF_FLAGS]
    case 'branch':
      return a.mergeBase
        ? ['git', 'diff', ...DIFF_FLAGS, a.mergeBase]
        : { reason: 'No merge base with the chosen base branch.' }
    case 'commit':
      return ['git', 'show', '--format=', ...DIFF_FLAGS, a.commit ?? 'HEAD']
    case 'turn':
      // A repository first touched mid-turn has no snapshot: fall back to
      // HEAD, narrowed to the files the turn wrote there.
      if (a.turnBase) return ['git', 'diff', ...DIFF_FLAGS, a.turnBase]
      if (a.turnFiles.length) return ['git', 'diff', ...DIFF_FLAGS, 'HEAD', '--', ...a.turnFiles]

      return { reason: 'No turn has run since the pane loaded.' }
  }
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let file: FileDiff | undefined
  let hunk: Hunk | undefined
  let oldNo = 0
  let newNo = 0

  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(raw)
      file = {
        path: m?.[2] ?? raw.slice(11),
        status: 'modified',
        added: 0,
        removed: 0,
        isBinary: false,
        hunks: [],
      }
      if (m && m[1] !== m[2]) {
        file.oldPath = m[1]
        file.status = 'renamed'
      }
      files.push(file)
      hunk = undefined
      continue
    }
    if (!file) continue

    const head = HUNK.exec(raw)
    if (head) {
      oldNo = Number(head[1])
      newNo = Number(head[2])
      hunk = { header: raw, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) {
      if (raw.startsWith('new file mode')) file.status = 'added'
      else if (raw.startsWith('deleted file mode')) file.status = 'deleted'
      else if (raw.startsWith('Binary files')) file.isBinary = true
      continue
    }

    const kind = raw[0]
    const body = raw.slice(1)
    if (kind === '+') {
      hunk.lines.push({ kind: '+', text: body, newNo: newNo++ })
      file.added++
    } else if (kind === '-') {
      hunk.lines.push({ kind: '-', text: body, oldNo: oldNo++ })
      file.removed++
    } else if (kind === ' ') {
      hunk.lines.push({ kind: ' ', text: body, oldNo: oldNo++, newNo: newNo++ })
    }
    // `\ No newline at end of file` and the trailing empty split are skipped.
  }

  return files
}

// Generated files (source maps, build info, lockfiles, minified bundles) and
// diffs too big to read start folded: drawn whole they stall the pane.
const GENERATED = /(\.map|\.tsbuildinfo|\.min\.(js|css)|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml))$/
const MAX_FILE_LINES = 2000
const MAX_LINE_CHARS = 2000

export function isHeavy(file: FileDiff): boolean {
  if (GENERATED.test(file.path)) return true
  let count = 0
  for (const hunk of file.hunks) {
    count += hunk.lines.length
    if (count > MAX_FILE_LINES) return true
    if (hunk.lines.some(l => l.text.length > MAX_LINE_CHARS)) return true
  }

  return false
}

export const MAX_HUNK_LINES = 300
export const MAX_DRAWN_CHARS = 400

// What the snapshot keeps of a file: no more lines than are drawn, each no
// longer than is drawn, so the stored state stays small however big the diff.
export function slim(file: FileDiff): FileDiff {
  return {
    ...file,
    isLarge: isHeavy(file),
    hunks: file.hunks.map(h => ({
      header: h.header,
      lines: h.lines.slice(0, MAX_HUNK_LINES).map(l => ({ ...l, text: clip(l.text, MAX_DRAWN_CHARS) })),
      more: (h.more ?? 0) + Math.max(0, h.lines.length - MAX_HUNK_LINES),
    })),
  }
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more chars)` : text
}

export function lineAnchor(line: DiffLine): { side: 'old' | 'new'; line: number } {
  return line.kind === '-'
    ? { side: 'old', line: line.oldNo ?? 0 }
    : { side: 'new', line: line.newNo ?? 0 }
}

export function isOnLine(c: Comment, repo: string, file: string, line: DiffLine): boolean {
  if (c.repo !== repo || c.file !== file) return false
  const a = lineAnchor(line)

  return a.side === c.side && a.line === c.line
}

export function repoName(root: string): string {
  return root.split('/').filter(Boolean).pop() ?? root
}

// A path as the model should read it: relative to the session's directory
// when the file is under it, else absolute.
export function displayPath(repo: string, file: string, cwd: string): string {
  const abs = `${repo}/${file}`

  return abs.startsWith(cwd + '/') ? abs.slice(cwd.length + 1) : abs
}

// The block the model reads beside the next prompt.
export function formatComments(comments: readonly Comment[], cwd: string): string {
  const rows = comments.map(c => {
    const where = `${displayPath(c.repo, c.file, cwd)}:${c.line}${c.side === 'old' ? ' (removed line)' : ''}`
    const quoted = c.lineText.trim() ? `\n  > ${c.lineText.trim()}` : ''

    return `- ${where}${quoted}\n  ${c.text.replace(/\n/g, '\n  ')}`
  })

  return [
    'Inline review comments the user left in the review pane on the current diff.',
    'Treat them as review guidance: address each one with the smallest change that satisfies it.',
    '',
    ...rows,
  ].join('\n')
}

// A small highlighter for diff rows: good enough to read code by, across the
// common languages, one line at a time (a comment or string opened on an
// earlier line is not followed).
export type TokenKind = 'plain' | 'keyword' | 'string' | 'number' | 'comment' | 'call' | 'type'
export type Token = { kind: TokenKind; text: string }

const KEYWORDS = new Set(
  (
    'abstract and as async await break case catch class const continue def default defer del ' +
    'delete do elif else enum export extends false final finally fn for from func function go ' +
    'if impl implements import in instanceof interface is let match module mut new nil none ' +
    'None not null of or package private protected pub public raise return select self static ' +
    'struct super switch this throw throws true True False try type typeof undefined use var ' +
    'void when where while with yield'
  ).split(' '),
)

const HASH_COMMENTS = /\.(py|rb|sh|bash|zsh|ya?ml|toml|r|pl|ex|exs|conf|ini|mk)$|(^|\/)(Dockerfile|Makefile|\.env[^/]*)$/
const SQL_COMMENTS = /\.(sql|lua|hs)$/

export function tokenize(text: string, path: string): Token[] {
  const comment = HASH_COMMENTS.test(path) ? '#' : SQL_COMMENTS.test(path) ? '--' : '//'
  const tokens: Token[] = []
  const push = (kind: TokenKind, s: string) => {
    const last = tokens[tokens.length - 1]
    if (last && last.kind === kind) last.text += s
    else tokens.push({ kind, text: s })
  }

  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    if (rest.startsWith(comment) || rest.startsWith('/*')) {
      push('comment', rest)
      break
    }
    const ch = text[i] ?? ''
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1
      push('string', text.slice(i, j + 1))
      i = j + 1
      continue
    }
    const num = /^(0x[\da-f]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)/i.exec(rest)
    if (num && !/[\w$]/.test(text[i - 1] ?? '')) {
      push('number', num[0])
      i += num[0].length
      continue
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest)
    if (word) {
      const w = word[0]
      const after = text.slice(i + w.length)
      const kind: TokenKind = KEYWORDS.has(w)
        ? 'keyword'
        : /^\s*\(/.test(after)
          ? 'call'
          : /^[A-Z]/.test(w)
            ? 'type'
            : 'plain'
      push(kind, w)
      i += w.length
      continue
    }
    push('plain', ch)
    i++
  }

  return tokens
}
