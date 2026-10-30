import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  Comment,
  DiffLine,
  Draft,
  FileDiff,
  RepoGroup,
  RepoSummary,
  Scope,
  Snapshot,
} from '../types'
import type { TokenKind } from './git'
import {
  diffArgv,
  formatComments,
  isOnLine,
  lineAnchor,
  clip,
  isHeavy,
  MAX_DRAWN_CHARS,
  MAX_HUNK_LINES,
  slim,
  parseDiff,
  repoName,
  tokenize,
  untrackedArgv,
} from './git'

const PANE = 'review-pane'
const TITLE = 'Review'
const MAX_UNTRACKED = 30

const SCOPES: { id: Scope; label: string }[] = [
  { id: 'unstaged', label: 'Unstaged' },
  { id: 'staged', label: 'Staged' },
  { id: 'branch', label: 'Branch' },
  { id: 'commit', label: 'Commit' },
  { id: 'turn', label: 'Last turn' },
]

// Theme keys, so tokens follow the person's light or dark theme.
const TOKEN_COLOR: Record<TokenKind, string | undefined> = {
  plain: undefined,
  keyword: 'merged',
  string: 'success',
  number: 'claude',
  comment: 'inactive',
  call: 'suggestion',
  type: 'permission',
}

const EMPTY: Snapshot = {
  groups: [],
  repos: [],
  others: [],
  error: null,
  branches: [],
  commits: [],
  root: null,
  scope: null,
}

const scope = atom({ plugin: 'review-pane', key: 'scope' } as const, 'unstaged')
const repos = atom({ plugin: 'review-pane', key: 'repos' } as const, [])
const repo = atom({ plugin: 'review-pane', key: 'repo' } as const, null)
const base = atom({ plugin: 'review-pane', key: 'base' } as const, {})
const commit = atom({ plugin: 'review-pane', key: 'commit' } as const, null)
// Files start unfolded; this holds the `root:path` of the ones folded.
const collapsed = atom({ plugin: 'review-pane', key: 'collapsed' } as const, [])
const draft = atom({ plugin: 'review-pane', key: 'draft' } as const, null)
const turnBase = atom({ plugin: 'review-pane', key: 'turnBase' } as const, {})
const turnFiles = atom({ plugin: 'review-pane', key: 'turnFiles' } as const, {})
// HEAD and `git status` per repository as the turn started, to tell which
// ones the turn changed, Bash included.
const turnPrint = atom({ plugin: 'review-pane', key: 'turnPrint' } as const, {})
const touched = atom({ plugin: 'review-pane', key: 'touched' } as const, [])
const showAll = atom({ plugin: 'review-pane', key: 'showAll' } as const, false)
// True while a refresh reloads the diff, so the header's button can say so.
const isRefreshing = atom({ plugin: 'review-pane', key: 'isRefreshing' } as const, false)
// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const snapshot = atom({ plugin: 'review-pane', key: 'snapshot' } as const, EMPTY, {
  shape: 'snapshot-4',
})
const comments = atom({ plugin: 'review-pane', key: 'comments' } as const, [], {
  shape: 'comments-2',
})

type $ = EngineInterface

async function git($: $, argv: string[], cwd?: string): Promise<string | null> {
  const ran = await $.process.run(argv, cwd ? { cwd } : {})

  return ran.exitCode === 0 ? ran.stdout : null
}

async function toplevel($: $, dir: string): Promise<string | null> {
  return (await git($, ['git', 'rev-parse', '--show-toplevel'], dir))?.trim() || null
}

function dirOf(path: string): string {
  return path.slice(0, Math.max(1, path.lastIndexOf('/')))
}

async function addRepo($: $, root: string): Promise<void> {
  await update($, repos, list => (list.includes(root) ? list : [...list, root]))
}

async function markTouched($: $, root: string): Promise<void> {
  await update($, touched, list => (list.includes(root) ? list : [...list, root]))
}

async function fingerprint($: $, root: string): Promise<string | null> {
  const head = (await git($, ['git', 'rev-parse', 'HEAD'], root))?.trim() ?? ''
  const status = await git($, ['git', 'status', '--porcelain'], root)

  return status === null ? null : `${head}\n${status}`
}

// A repository the turn changed: its HEAD or status moved, or a file already
// changed was changed again (the tree differs from the turn's snapshot).
async function detectTouched($: $): Promise<void> {
  const known = await read($, touched)
  const prints = await read($, turnPrint)
  const bases = await read($, turnBase)
  const roots = Object.keys(prints).filter(r => !known.includes(r))
  const changed = await Promise.all(
    roots.map(async root => {
      if ((await fingerprint($, root)) !== prints[root]) return true
      const sha = bases[root]
      if (!sha) return false
      const ran = await $.process.run(['git', 'diff', '--quiet', sha], { cwd: root })

      return ran.exitCode === 1
    }),
  )
  for (const [i, root] of roots.entries()) if (changed[i]) await markTouched($, root)
}

// The session's own repository, those one or two folders below it, and any
// already known (touched by an edit or added by hand). Which of them get a
// chip is `load`'s choice.
async function discover($: $): Promise<void> {
  const cwd = await $.session.cwd()
  const found: string[] = []
  const own = await toplevel($, cwd)
  if (own) found.push(own)

  const ran = await $.process.run([
    'find', cwd, '-mindepth', '2', '-maxdepth', '3', '-name', '.git',
    '-not', '-path', '*/node_modules/*',
  ])
  const roots = await Promise.all(
    ran.stdout.split('\n').filter(Boolean).map(dotGit => toplevel($, dirOf(dotGit))),
  )
  for (const root of roots) if (root && !found.includes(root)) found.push(root)

  // Submodules sit at any depth, deeper than the search above reaches.
  const subs = await Promise.all(
    found.map(root => git($, ['git', 'submodule', 'foreach', '--quiet', '--recursive', 'pwd'], root)),
  )
  for (const out of subs) {
    for (const root of (out ?? '').split('\n').filter(Boolean)) if (!found.includes(root)) found.push(root)
  }

  for (const root of found) await addRepo($, root)
}

async function defaultBase($: $, root: string, branches: string[]): Promise<string | null> {
  const head = await git($, ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root)
  if (head?.trim()) return head.trim()

  return ['main', 'master', 'develop'].find(b => branches.includes(b)) ?? branches[0] ?? null
}

async function untracked($: $, root: string, paths: string[]): Promise<FileDiff[]> {
  const out: FileDiff[] = []
  for (const path of paths.slice(0, MAX_UNTRACKED)) {
    // `--no-index` exits 1 when the files differ, which they always do here.
    const ran = await $.process.run(untrackedArgv(path), { cwd: root })
    out.push(...parseDiff(ran.stdout))
  }

  return out
}

async function loadGroup($: $, root: string, current: Scope, branches: string[]): Promise<RepoGroup> {
  const name = repoName(root)
  let mergeBase: string | null = null
  if (current === 'branch') {
    const chosen = (await read($, base))[root] ?? (await defaultBase($, root, branches))
    if (chosen) mergeBase = (await git($, ['git', 'merge-base', 'HEAD', chosen], root))?.trim() || null
  }
  const wrote = (await read($, turnFiles))[root] ?? []
  const argv = diffArgv({
    scope: current,
    mergeBase,
    commit: await read($, commit),
    turnBase: (await read($, turnBase))[root] ?? null,
    turnFiles: wrote,
  })
  if (!Array.isArray(argv)) throw new Error(argv.reason)

  const ran = await $.process.run(argv, { cwd: root })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `git exited ${ran.exitCode}`)
  const files = parseDiff(ran.stdout)

  // Untracked files are part of the working tree, Codex-style: in Unstaged all
  // of them, in Last turn only those the turn wrote.
  if (current === 'unstaged' || current === 'turn') {
    const others = await git($, ['git', 'ls-files', '--others', '--exclude-standard'], root)
    let paths = (others ?? '').split('\n').filter(Boolean)
    if (current === 'turn') paths = paths.filter(p => wrote.includes(p))
    files.push(...(await untracked($, root, paths)))
  }

  return { root, name, files: files.map(slim) }
}

async function load($: $): Promise<Snapshot> {
  const list = await read($, repos)
  if (list.length === 0) {
    return {
      ...EMPTY,
      scope: await read($, scope),
      error: 'No git repository here. Add one with /review-pane add <path>.',
    }
  }

  const marked = await read($, touched)
  const summaries: RepoSummary[] = await Promise.all(
    list.map(async root => {
      const status = (await git($, ['git', 'status', '--porcelain'], root)) ?? ''
      const changed = status.split('\n').filter(Boolean).length
      // A changed submodule of a touched repository counts as touched: its
      // parent's status names it, but its own files are only diffed here.
      const isInside = marked.some(t => root.startsWith(t + '/'))

      return {
        root,
        name: repoName(root),
        changed,
        isTouched: marked.includes(root) || (isInside && changed > 0),
      }
    }),
  )

  // Chips go to the repositories this session touched; before it has touched
  // any, to those with changes. Other changed ones wait behind a toggle, and
  // clean ones are never drawn. With nothing to show, the session's own
  // repository stands alone, for its branch and commits.
  const anyTouched = summaries.some(r => r.isTouched)
  const isFocus = (r: RepoSummary) => (anyTouched ? r.isTouched : r.changed > 0)
  const focus = summaries.filter(isFocus)
  const others = summaries.filter(r => !isFocus(r) && r.changed > 0)
  let shown = (await read($, showAll)) ? [...focus, ...others] : focus
  if (shown.length === 0) {
    const own = await toplevel($, await $.session.cwd())
    shown = summaries.filter(r => r.root === own).slice(0, 1)
  }

  const selected = await read($, repo)
  const root = shown.some(r => r.root === selected) ? (selected ?? '') : (shown[0]?.root ?? '')
  if (root !== (selected ?? '')) await update($, repo, () => root || null)
  const current = await read($, scope)
  if (!root && current !== 'turn') {
    return { ...EMPTY, others, scope: current, error: null }
  }

  const branches = ((await git($, ['git', 'branch', '--format=%(refname:short)'], root)) ?? '')
    .split('\n')
    .filter(Boolean)
  const log = (await git($, ['git', 'log', '-n', '20', '--format=%h%x09%s'], root)) ?? ''
  const snap: Snapshot = {
    ...EMPTY,
    repos: shown,
    others,
    root: root || null,
    scope: current,
    branches,
    commits: log
      .split('\n')
      .filter(Boolean)
      .map(row => {
        const [sha = '', ...rest] = row.split('\t')

        return { sha, subject: rest.join('\t') }
      }),
  }

  try {
    if (current !== 'turn') return { ...snap, groups: [await loadGroup($, root, current, branches)] }

    // Last turn spans every repository the turn could have changed.
    const groups: RepoGroup[] = []
    const bases = await read($, turnBase)
    const wrote = await read($, turnFiles)
    if (Object.keys(bases).length === 0 && Object.keys(wrote).length === 0) {
      return { ...snap, error: 'No turn has run since the pane loaded.' }
    }
    for (const r of list) {
      if (!bases[r] && !wrote[r]?.length) continue
      const group = await loadGroup($, r, current, [])
      if (group.files.length) groups.push(group)
    }

    return { ...snap, groups }
  } catch (err) {
    return { ...snap, error: err instanceof Error ? err.message : String(err) }
  }
}

// Coalesces bursts (a turn's many tool calls) into one refresh at a time.
let chain: Promise<void> = Promise.resolve()
let isQueued = false

function refresh($: $): Promise<void> {
  if (isQueued) return chain
  isQueued = true
  chain = chain
    .then(async () => {
      isQueued = false
      await update($, isRefreshing, () => true)
      const next = await load($)
      await update($, snapshot, () => next)
    })
    .catch(async err => {
      isQueued = false
      await update($, snapshot, s => ({ ...s, error: String(err) }))
    })
    .finally(() => update($, isRefreshing, () => false))

  return chain
}

async function showStatus($: $): Promise<void> {
  const pending = (await read($, comments)).filter(c => !c.isSent).length
  $.ui.status(
    pending ? `${pending} review comment${pending === 1 ? '' : 's'} pending` : undefined,
  )
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'review-pane',
      description: 'Open the code review pane: scoped diffs with inline comments',
      argumentHint: '[add <repo path>]',
    })
    void discover($).then(() => refresh($))
    if (e.surface === 'desktop') void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'review-pane' }, async ($, e) => {
    const [verb, ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'add') {
      const cwd = await $.session.cwd()
      const arg = rest.join(' ')
      const path = arg.startsWith('/') ? arg : `${cwd}/${arg}`
      const root = arg ? await toplevel($, path) : null
      if (!root) return { text: `Not a git repository: ${arg || '(no path given)'}` }
      await addRepo($, root)
      await markTouched($, root)
      await update($, repo, () => root)
      await refresh($)
      await $.ui.open({ id: PANE, title: TITLE })

      return { text: `Review pane: added ${repoName(root)}.` }
    }
    await discover($)
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Review pane opened.' }
  })

  // Last turn: snapshot each known repository's working tree without
  // touching it, before the model runs, so the scope shows only this turn.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const bases: Record<string, string> = {}
      const prints: Record<string, string> = {}
      await Promise.all(
        (await read($, repos)).map(async root => {
          const stash = (await git($, ['git', 'stash', 'create'], root))?.trim()
          const head = (await git($, ['git', 'rev-parse', 'HEAD'], root))?.trim()
          const sha = stash || head
          if (sha) bases[root] = sha
          const print = await fingerprint($, root)
          if (print !== null) prints[root] = print
        }),
      )
      await update($, turnBase, () => bases)
      await update($, turnPrint, () => prints)
      await update($, turnFiles, () => ({}))
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.tool === 'Edit' || e.tool === 'Write') {
      const root = await toplevel($, dirOf(e.file_path))
      if (root && e.file_path.startsWith(root + '/')) {
        const rel = e.file_path.slice(root.length + 1)
        await addRepo($, root)
        await markTouched($, root)
        await update($, turnFiles, all => {
          const list = all[root] ?? []

          return list.includes(rel) ? all : { ...all, [root]: [...list, rel] }
        })
      }
    }
    if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'Bash') void refresh($)

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    void detectTouched($).then(() => refresh($))

    return next(e)
  })

  // Pending comments reach the model beside the person's next message, as
  // Codex sends inline comments with the next follow-up.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    const pending = (await read($, comments)).filter(c => !c.isSent)
    if (pending.length === 0) return next(e)

    const cwd = await $.session.cwd()
    const ran = await next({ ...e, context: [...(e.context ?? []), formatComments(pending, cwd)] })
    if (ran.drop === undefined) {
      const sent = new Set(pending.map(c => c.id))
      await update($, comments, list =>
        list.map(c => (sent.has(c.id) ? { ...c, isSent: true } : c)),
      )
      await showStatus($)
      $.ui.toast(`Sent ${pending.length} review comment${pending.length === 1 ? '' : 's'}`)
    }

    return ran
  }).catch(($, e, next) => next(e))

  // A one-click toggle above the prompt, the nearest a mod gets to a title
  // bar button; it steps aside when nothing is changed or pending.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const snap = await read($, snapshot)
    const changed = snap.repos.reduce((n, r) => n + r.changed, 0)
    const pending = (await read($, comments)).filter(c => !c.isSent).length
    if (changed === 0 && pending === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const toggle = async () => {
      const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
      if (isOpen) {
        await $.ui.close({ id: PANE })
      } else {
        await $.ui.open({ id: PANE, title: TITLE })
      }
    }

    return (
      <Box>
        <Button key="review-toggle" plain onPress={toggle}>
          Review
          <Text dimColor>
            {changed ? ` · ${changed} file${changed === 1 ? '' : 's'}` : ''}
            {pending ? ` · ${pending} comment${pending === 1 ? '' : 's'}` : ''}
          </Text>
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // Mobile has no text field or select: it shows diffs and comments only.
    const canType = e.surface !== 'mobile'
    const Input = canType && 'Input' in table ? table.Input : undefined
    const Select = canType && 'Select' in table ? table.Select : undefined
    // The terminal has no pointer to reveal a hover control, nor CSS colors.
    const isTerminal = e.surface === 'terminal'
    const addedBg = isTerminal ? 'diffAddedDimmed' : 'rgba(46, 160, 67, 0.15)'
    const removedBg = isTerminal ? 'diffRemovedDimmed' : 'rgba(248, 81, 73, 0.15)'

    const snap = await read($, snapshot)
    const current = await read($, scope)
    const selected = await read($, repo)
    const folded = new Set(await read($, collapsed))
    const draftNow = await read($, draft)
    const all = await read($, comments)
    const pending = all.filter(c => !c.isSent)
    const baseNow = selected ? ((await read($, base))[selected] ?? '') : ''
    const commitNow = (await read($, commit)) ?? ''

    const setScope = async (next: Scope) => {
      await update($, scope, () => next)
      await update($, draft, () => null)
      await refresh($)
    }
    const setRepo = async (root: string) => {
      await update($, repo, () => root)
      await update($, commit, () => null)
      await update($, draft, () => null)
      await refresh($)
    }
    const removeComment = async (id: string) => {
      await update($, comments, list => list.filter(c => c.id !== id))
      await showStatus($)
    }
    const addComment = async (d: Draft, text: string) => {
      if (!text.trim()) return
      const c: Comment = { ...d, id: newId(), text: text.trim(), isSent: false }
      await update($, comments, list => [...list, c])
      await update($, draft, () => null)
      await showStatus($)
    }
    const sendNow = () =>
      $.prompt.fill({
        text: 'Address my inline review comments from the review pane. Keep each change minimal and scoped to its comment.',
        mode: 'replace',
      })

    const isAll = await read($, showAll)
    const isBusy = await read($, isRefreshing)
    const toggleOthers = async () => {
      await update($, showAll, v => !v)
      await refresh($)
    }

    // The selection or scope moved on since the last load: its groups belong
    // to another repository, so they are not drawn as this one's.
    const isLoading =
      snap.scope !== current || (current !== 'turn' && (snap.root ?? null) !== (selected ?? null))
    const groups = isLoading ? [] : snap.groups
    const files = groups.flatMap(g => g.files)
    const totals = files.reduce(
      (t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }),
      { added: 0, removed: 0 },
    )
    const isMulti = snap.repos.length > 1 || snap.others.length > 0
    const title = current === 'turn' && isMulti
      ? 'All repos'
      : repoName(selected ?? snap.repos[0]?.root ?? 'Review')

    const renderLine = (group: RepoGroup, file: FileDiff, line: DiffLine, id: string, width: number) => {
      const anchor = lineAnchor(line)
      const isDraft =
        draftNow !== null &&
        draftNow.repo === group.root &&
        draftNow.file === file.path &&
        draftNow.side === anchor.side &&
        draftNow.line === anchor.line
      const onLine = all.filter(c => isOnLine(c, group.root, file.path, line))
      const bg = line.kind === '+' ? { backgroundColor: addedBg } : line.kind === '-' ? { backgroundColor: removedBg } : {}
      const pad = (n?: number) => (n === undefined ? '' : String(n)).padStart(width)

      return (
        <Box flexDirection="column">
          <Box key={`row:${id}`} {...bg}>
            <Box width={2} flexShrink={0}>
              {Input && (
                <Box {...(isTerminal ? {} : { display: 'none', hover: { display: 'flex' } } as const)}>
                  <Button
                    key={`add:${id}`}
                    plain
                    label="+"
                    dimColor
                    onPress={() =>
                      update($, draft, () => ({
                        ...anchor,
                        repo: group.root,
                        file: file.path,
                        lineText: line.text,
                      }))
                    }
                  />
                </Box>
              )}
            </Box>
            <Box flexShrink={0}>
              <Text mono tabular dimColor>
                {pad(line.oldNo)} {pad(line.newNo)}{' '}
              </Text>
              <Text mono color={line.kind === '+' ? 'green' : line.kind === '-' ? 'red' : 'inactive'}>
                {line.kind}{' '}
              </Text>
            </Box>
            <Text mono>
              {line.text === '' ? ' ' : tokenize(clip(line.text, MAX_DRAWN_CHARS), file.path).map(t => {
                const color = TOKEN_COLOR[t.kind]

                return color ? (
                  <Text color={color} italic={t.kind === 'comment'}>
                    {t.text}
                  </Text>
                ) : (
                  t.text
                )
              })}
            </Text>
          </Box>
          {onLine.map(c => (
            <Box gap={1} paddingLeft={width * 2 + 6}>
              <Text dimColor={c.isSent}>
                💬 {c.text}
                {c.isSent ? ' (sent)' : ''}
              </Text>
              <Button key={`del:${c.id}`} label="Delete" dimColor onPress={() => removeComment(c.id)} />
            </Box>
          ))}
          {Input && isDraft && draftNow && (
            <Box flexDirection="column" paddingLeft={width * 2 + 6}>
              <Input
                key="draft"
                rows={3}
                autoFocus
                placeholder={`Comment on line ${anchor.line}…`}
                submitLabel="add comment"
                onSubmit={text => addComment(draftNow, text)}
              />
              <Button key="draft-cancel" label="Cancel" dimColor onPress={() => update($, draft, () => null)} />
            </Box>
          )}
        </Box>
      )
    }

    const renderFile = (group: RepoGroup, file: FileDiff) => {
      const foldKey = `${group.root}:${file.path}`
      // `collapsed` holds the files flipped from their default: heavy ones
      // start folded, the rest open.
      const isLarge = file.isLarge ?? isHeavy(file)
      const isOpen = isLarge ? folded.has(foldKey) : !folded.has(foldKey)
      const toggle = () =>
        update($, collapsed, list =>
          list.includes(foldKey) ? list.filter(p => p !== foldKey) : [...list, foldKey],
        )
      const tag = file.status === 'modified' ? '' : ` ${file.status}`
      const maxNo = Math.max(
        1,
        ...file.hunks.flatMap(h => h.lines.map(l => Math.max(l.oldNo ?? 0, l.newNo ?? 0))),
      )
      const width = String(maxNo).length

      return (
        <Box flexDirection="column">
          <Button key={`f:${group.name}/${file.path}`} plain onPress={toggle}>
            {isOpen ? '▾ ' : '▸ '}
            <Text bold>{file.path}</Text>{' '}
            <Text color="green">+{file.added}</Text>{' '}
            <Text color="red">-{file.removed}</Text>
            <Text dimColor>{tag}</Text>
            {isLarge && !isOpen ? <Text dimColor> · large or generated, folded</Text> : ''}
          </Button>
          {isOpen && file.isBinary && <Text dimColor>  Binary file</Text>}
          {isOpen &&
            !file.isBinary &&
            file.hunks.map((hunk, i) => {
              const shown = hunk.lines.slice(0, MAX_HUNK_LINES)
              const more = (hunk.more ?? 0) + hunk.lines.length - shown.length

              return (
                <Box flexDirection="column">
                  <Box paddingLeft={2}>
                    <Text mono dimColor>
                      {hunk.header}
                    </Text>
                  </Box>
                  {shown.map((line, j) =>
                    renderLine(group, file, line, `${group.name}/${file.path}:${i}:${j}`, width),
                  )}
                  {more > 0 && (
                    <Text dimColor>  … {more} more lines</Text>
                  )}
                </Box>
              )
            })}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" gap={1}>
          <Box justifyContent="space-between" alignItems="center" gap={1}>
            <Text bold>
              {title}{' '}
              <Text dimColor>
                {files.length} file{files.length === 1 ? '' : 's'}{' '}
              </Text>
              <Text color="green">+{totals.added}</Text> <Text color="red">-{totals.removed}</Text>
            </Text>
            <Button
              key="refresh"
              label={isBusy ? '↻ Refreshing…' : '↻ Refresh'}
              dimColor={isBusy}
              onPress={() => discover($).then(() => refresh($))}
            />
          </Box>
          {isMulti && (
            <Box gap={1} flexWrap="wrap">
              {snap.repos.map(r => (
                <Button
                  key={`repo:${r.name}`}
                  variant={r.root === selected && current !== 'turn' ? 'primary' : 'secondary'}
                  dimColor={r.root !== selected || current === 'turn'}
                  onPress={() => setRepo(r.root)}
                >
                  {r.name}
                  {r.changed ? <Text dimColor> {r.changed}</Text> : ''}
                </Button>
              ))}
              {snap.others.length > 0 && (
                <Button
                  key="repo:others"
                  label={isAll ? 'Only this session’s' : `+${snap.others.length} other changed`}
                  dimColor
                  onPress={toggleOthers}
                />
              )}
            </Box>
          )}
          <Box gap={1} flexWrap="wrap">
            {SCOPES.map(s => (
              <Button
                key={`scope:${s.id}`}
                label={s.label}
                variant={s.id === current ? 'primary' : 'secondary'}
                dimColor={s.id !== current}
                onPress={() => setScope(s.id)}
              />
            ))}
          </Box>
          {current === 'branch' && Select && selected && snap.branches.length > 0 && (
            <Select
              key="base"
              label="Base"
              value={snap.branches.includes(baseNow) ? baseNow : snap.branches[0]}
              options={snap.branches.map(b => ({ value: b, label: b }))}
              onSelect={async value => {
                await update($, base, all => ({ ...all, [selected]: value }))
                await refresh($)
              }}
            />
          )}
          {current === 'commit' && Select && snap.commits.length > 0 && (
            <Select
              key="commit"
              label="Commit"
              value={snap.commits.some(c => c.sha === commitNow) ? commitNow : snap.commits[0]?.sha}
              options={snap.commits.map(c => ({ value: c.sha, label: `${c.sha} ${c.subject}` }))}
              onSelect={async value => {
                await update($, commit, () => value)
                await refresh($)
              }}
            />
          )}
          {snap.error && <Text color="red">{snap.error}</Text>}
        </Box>

        {pending.length > 0 && (
          <Box flexDirection="column">
            <Box gap={1}>
              <Text bold>
                {pending.length} pending comment{pending.length === 1 ? '' : 's'}
              </Text>
              <Button key="send" label="Send to Claude" variant="primary" onPress={sendNow} />
              <Button
                key="clear"
                label="Clear"
                dimColor
                onPress={async () => {
                  await update($, comments, list => list.filter(c => c.isSent))
                  await showStatus($)
                }}
              />
            </Box>
            {pending.map(c => (
              <Box gap={1}>
                <Text dimColor>
                  {isMulti ? `${repoName(c.repo)}/` : ''}
                  {c.file}:{c.line}
                </Text>
                <Text>{c.text}</Text>
                <Button key={`pdel:${c.id}`} label="Delete" dimColor onPress={() => removeComment(c.id)} />
              </Box>
            ))}
            <Text dimColor>They go to Claude with your next message.</Text>
          </Box>
        )}

        {isLoading && <Text dimColor>Loading…</Text>}
        {!isLoading && !snap.error && files.length === 0 && (
          <Text dimColor>
            {snap.root || current === 'turn' ? 'No changes in this scope.' : 'No changes in any repository.'}
          </Text>
        )}
        {groups.map(group => (
          <Box flexDirection="column" gap={1}>
            {(current === 'turn' && isMulti) && <Text bold color="claude">{group.name}</Text>}
            {group.files.map(file => renderFile(group, file))}
          </Box>
        ))}
      </Box>
    )
  }).catch(($, e, next) => {
    // Say why rather than leave the pane blank.
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="red">The review pane could not draw ({next.error.kind}).</Text>
        {next.error.message ? <Text dimColor>{next.error.message}</Text> : null}
      </Box>
    )
  })
}
