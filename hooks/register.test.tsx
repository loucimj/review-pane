import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { formatComments, parseDiff, tokenize } from './git'

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  ' export { a, b }',
  '',
].join('\n')

const PANE = {
  plugin: 'review-pane',
  component: 'Pane',
  requestId: 'review-pane',
  props: {
    title: 'Review',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

// Two repositories under /work: `api` (the diff above) and `web` (clean).
function fakeGit(argv: readonly string[], cwd = '/work') {
  const cmd = argv.join(' ')
  if (cmd.startsWith('find ')) return ok('/work/api/.git\n/work/web/.git\n')
  if (cmd === 'git rev-parse --show-toplevel') {
    return cwd === '/work' ? { ...ok(''), exitCode: 128 } : ok(`${cwd}\n`)
  }
  if (cmd === 'git status --porcelain') return ok(cwd === '/work/api' ? ' M src/a.ts\n' : '')
  if (cmd.startsWith('git diff --no-color')) return ok(cwd === '/work/api' ? DIFF : '')

  return ok('')
}

function fakeHost(on: Parameters<TestBody>[1]) {
  on('session.cwd', () => ({ value: '/work' }))
  on('process.run', (_, e) => ({ value: fakeGit(e.argv, e.init?.cwd) }))
}

test('parseDiff numbers lines on both sides', () => {
  const [file] = parseDiff(DIFF)
  expect(file?.path).toBe('src/a.ts')
  expect([file?.added, file?.removed]).toEqual([1, 1])
  const lines = file?.hunks[0]?.lines ?? []
  expect(lines[1]).toEqual({ kind: '-', text: 'const b = 2', oldNo: 2 })
  expect(lines[2]).toEqual({ kind: '+', text: 'const b = 3', newNo: 2 })
})

test('tokenize picks out keywords, strings, numbers, calls and comments', () => {
  const kinds = tokenize('const x = fmt("a", 42) // done', 'a.ts')
    .filter(t => t.kind !== 'plain')
    .map(t => `${t.kind}:${t.text}`)
  expect(kinds).toEqual(['keyword:const', 'call:fmt', 'string:"a"', 'number:42', 'comment:// done'])
  expect(tokenize('# note', 'run.py')[0]?.kind).toBe('comment')
})

test('formatComments names a file relative to the session when it can', () => {
  const comment = { id: 'x', file: 'src/a.ts', side: 'old', line: 2, lineText: 'const b = 2', text: 'keep it', isSent: false } as const
  expect(formatComments([{ ...comment, repo: '/work/api' }], '/work')).toContain('api/src/a.ts:2 (removed line)')
  expect(formatComments([{ ...comment, repo: '/elsewhere' }], '/work')).toContain('/elsewhere/src/a.ts:2')
})

test('both repositories are found, and a comment rides along with the next prompt', async ($, on) => {
  fakeHost(on)
  let context: readonly string[] | undefined
  on('prompt.submit', (_, e) => {
    context = e.context

    return { text: e.text, context: e.context }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: 'repo:api' })).toBeDefined()
  expect(await ui.find({ key: 'repo:web' })).toBeDefined()

  await ui.press({ key: 'add:api/src/a.ts:0:2' })
  await ui.input({ key: 'draft', text: 'Why 3?' })
  expect((await ui.find({ type: 'Text', text: /1 pending comment/ }))?.text).toContain('1 pending')

  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  expect(context?.join('\n')).toContain('api/src/a.ts:2')
  expect(context?.join('\n')).toContain('Why 3?')
  await ui.unmount()
})

test('the pane draws the diff on every surface; only those with input can comment', async ($, on) => {
  fakeHost(on)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /const b = 3|^3$/ })).toBeDefined()
    expect(Boolean(await ui.find({ key: 'add:api/src/a.ts:0:2' }))).toBe(surface !== 'mobile')
    await ui.unmount()
  }
})

test('a file folds and unfolds', async ($, on) => {
  fakeHost(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: 'add:api/src/a.ts:0:2' })).toBeDefined()
  await ui.press({ key: 'f:api/src/a.ts' })
  expect(await ui.find({ key: 'add:api/src/a.ts:0:2' })).toBeUndefined()
  await ui.press({ key: 'f:api/src/a.ts' })
  await ui.unmount()
})
