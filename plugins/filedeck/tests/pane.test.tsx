import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'filedeck',
  component: 'Pane',
  requestId: 'filedeck',
  props: {
    title: 'Files: demo',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const STATUS = '## main...origin/main [ahead 1]\0 M src/app.ts\0?? notes.md\0'

function engine(on: Parameters<Parameters<typeof test>[1]>[1], listed = '') {
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_, e) => {
    const args = e.argv.slice(1).join(' ')
    if (args.startsWith('rev-parse')) return { value: { exitCode: 0, stdout: '/repo\n', stderr: '' } }
    if (args.startsWith('status')) return { value: { exitCode: 0, stdout: STATUS, stderr: '' } }
    if (args.startsWith('ls-files -co')) return { value: { exitCode: 0, stdout: listed, stderr: '' } }
    if (args.startsWith('diff HEAD')) return { value: { exitCode: 0, stdout: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n', stderr: '' } }
    if (args.startsWith('diff')) return { value: { exitCode: 0, stdout: '3\t1\tsrc/app.ts\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('fs.list', (_, e) => {
    const dir = String(e.path ?? '/repo')
    const t = Date.now()
    if (dir === '/repo')
      return { value: [
        { name: 'src', kind: 'dir', size: 0, mtimeMs: t, isLink: false },
        { name: 'notes.md', kind: 'file', size: 10, mtimeMs: t, isLink: false },
        { name: 'receipt.pdf', kind: 'file', size: 10, mtimeMs: t, isLink: false },
      ] }
    return { value: [{ name: 'app.ts', kind: 'file', size: 10, mtimeMs: t, isLink: false }] }
  })
  on('command.register', () => ({ value: { command: 'filedeck' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.read', () => ({ value: '# notes\nhello\n' }))
  on('prompt.fill', () => ({ value: { text: '', cursor: 0 } }))
  on('tool.call', () => ({ result: {} }))
}

test('files tab: badges, folder change count, Claude touched', async ($, on) => {
  engine(on)
  await $.command.run({ command: 'filedeck', args: '' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/notes.md' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /1 changed/ }))?.text).toBe('1 changed')
    if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: /PDF/ })).toBeTruthy()
    else expect(String((await ui.findAll({ type: 'Svg' })).map(x => x.props?.alt).join(' '))).toMatch(/PDF/)
    expect(await ui.find({ type: 'Text', text: /clean|changed/ })).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /1 file$/i }))?.text).toMatch(/1 FILE/)
    if (surface === 'desktop') expect((await ui.findAll({ type: 'Svg' })).length).toBeGreaterThan(2)
    await ui.press({ key: 'f:/repo/src' })
    expect(await ui.find({ type: 'Text', text: /app\.ts/ })).toBeTruthy()
    await ui.press({ key: 'tab:changes' })
    expect(await ui.find({ type: 'Text', text: /\+3/ })).toBeTruthy()
    await ui.press({ key: 'tab:files' })
    await ui.press({ key: 'collapse' })
    await ui.unmount()
  }
})

test('search lists matching files', async ($, on) => {
  engine(on, 'src/app.ts\nnotes.md\n')
  await $.command.run({ command: 'filedeck', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'find', text: 'app', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /^app\.ts$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /notes\.md/ })).toBeFalsy()
  await ui.unmount()
})

test('selecting a file opens its diff, and File shows its text', async ($, on) => {
  engine(on)
  await $.command.run({ command: 'filedeck', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'f:/repo/src' })
  await ui.press({ key: 'f:/repo/src/app.ts' })
  const diff = await ui.find({ type: 'Code' })
  expect(String(diff?.props?.source)).toMatch(/^@@ -1,2/)
  expect(diff?.props?.format).toBe('diff')
  await ui.press({ key: 'pvf:/repo/src/app.ts' })
  expect(String((await ui.find({ type: 'Code' }))?.props?.source)).toMatch(/hello/)
  await ui.press({ key: 'pvx:/repo/src/app.ts' })
  expect(await ui.find({ type: 'Code' })).toBeFalsy()
  await ui.unmount()
})

test('a file Claude reads opens the tree to it and keeps a read mark', async ($, on) => {
  engine(on)
  on('ui.scroll', () => ({ value: {} }))
  await $.command.run({ command: 'filedeck', args: '' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // src opened by itself, and app.ts carries the read mark.
  expect(await ui.find({ type: 'Text', text: /^app\.ts$/ })).toBeTruthy()
  expect((await ui.findAll({ type: 'Text', text: /•/ })).length).toBeGreaterThan(0)
  await ui.unmount()
})

test('clicking a file in Claude touched opens its viewer there, with Mention', async ($, on) => {
  engine(on)
  on('ui.scroll', () => ({ value: {} }))
  await $.command.run({ command: 'filedeck', args: '' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tb:/repo/src/app.ts' })
  expect(await ui.find({ type: 'Code' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'pvm:/repo/src/app.ts' })).toBeTruthy()
  // One viewer only: not also under the tree row.
  expect((await ui.findAll({ type: 'Code' })).length).toBe(1)
  await ui.press({ key: 'tb:/repo/src/app.ts' })
  expect(await ui.find({ type: 'Code' })).toBeFalsy()
  await ui.unmount()
})
