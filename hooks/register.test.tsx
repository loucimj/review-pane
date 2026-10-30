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

// Three repositories under /work: `api` (the diff above), `web` and `ops`;
// those in `dirty` carry the diff, the rest are clean.
function fakeGit(argv: readonly string[], cwd = '/work', dirty: readonly string[] = ['api']) {
  const cmd = argv.join(' ')
  const isDirty = dirty.some(name => cwd === `/work/${name}`)
  if (cmd.startsWith('find ')) return ok('/work/api/.git\n/work/web/.git\n/work/ops/.git\n')
  if (cmd === 'git rev-parse --show-toplevel') {
    return cwd === '/work' ? { ...ok(''), exitCode: 128 } : ok(`${cwd}\n`)
  }
  if (cmd === 'git status --porcelain') return ok(isDirty ? ' M src/a.ts\n' : '')
  if (cmd.startsWith('git diff --no-color')) return ok(isDirty ? DIFF : '')

  return ok('')
}

function fakeHost(on: Parameters<TestBody>[1], dirty?: readonly string[]) {
  on('session.cwd', () => ({ value: '/work' }))
  on('process.run', (_, e) => ({ value: fakeGit(e.argv, e.init?.cwd, dirty) }))
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

test('changed repositories get a chip, clean ones none', async ($, on) => {
  fakeHost(on, ['api', 'web'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: 'repo:api' })).toBeDefined()
  expect(await ui.find({ key: 'repo:web' })).toBeDefined()
  expect(await ui.find({ key: 'repo:ops' })).toBeUndefined()
  await ui.unmount()
})

test('once the session touches a repository, the others wait behind a toggle', async ($, on) => {
  fakeHost(on, ['api', 'web'])
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await $.command.run({
    command: 'review-pane',
    args: 'add web',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  expect(await ui.find({ key: 'repo:web' })).toBeDefined()
  expect(await ui.find({ key: 'repo:api' })).toBeUndefined()
  expect((await ui.find({ key: 'repo:others' }))?.text).toContain('+1 other changed')

  await ui.press({ key: 'repo:others' })
  expect(await ui.find({ key: 'repo:api' })).toBeDefined()
  expect(await ui.find({ key: 'repo:ops' })).toBeUndefined()
  await ui.unmount()
})

test('the one changed repository is selected and a comment rides along with the next prompt', async ($, on) => {
  fakeHost(on)
  let context: readonly string[] | undefined
  on('prompt.submit', (_, e) => {
    context = e.context

    return { text: e.text, context: e.context }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  // A lone repository needs no picker.
  expect(await ui.find({ key: 'repo:api' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /No changes/ })).toBeUndefined()

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

test('the band toggles the pane and steps aside when nothing changed', async ($, on) => {
  fakeHost(on)
  const open = new Set<string>()
  on('ui.open', (_, e) => {
    open.add(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    open.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'refresh' })
  await pane.unmount()

  const BAND = {
    plugin: 'review-pane',
    component: 'AbovePrompt',
    requestId: 'band',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  } as const
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ key: 'review-toggle' }))?.text).toContain('1 file')
    await band.press({ key: 'review-toggle' })
    expect(open.has('review-pane')).toBe(true)
    await band.press({ key: 'review-toggle' })
    expect(open.has('review-pane')).toBe(false)
    await band.unmount()
  }
})
