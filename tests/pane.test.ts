import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'read-aloud',
  component: 'Pane',
  requestId: 'read-aloud',
  props: {
    title: '読み上げ',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const frame = (before: string, word: string, after: string) => `\r\x1b[M${before}\x1b[1m${word}\x1b(B\x1b[m${after}`

// Nothing sits beneath the plugin: each hook here stands for the engine. Its clock is
// the test's, so the watchdog a play sets up never runs on its own.
function engine(on: On) {
  on('command.register', () => ({ value: { command: 'read-aloud' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  mock.store(on)
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'Kyoko (Japanese (Japan)) ja_JP    # こんにちは\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.messages', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return mock.clock(on)
}

test('▶ reads the latest answer with say, lights each word, then resets', async ($, on) => {
  engine(on)
  const runs: (readonly string[])[] = []
  const spots: unknown[] = []
  on('state.set', (_, e, next) => {
    if (e.key === 'spot') spots.push(e.value)
    return next(e)
  })
  on('process.spawn', async function* (_, e) {
    runs.push([...e.argv, e.input ?? ''])
    yield { stream: 'stdout' as const, text: '\x1b[?25l' + frame('', 'これ', 'はテスト') }
    yield { stream: 'stdout' as const, text: frame('これは', 'テスト', '') + '\n\x1b[?12l\x1b[?25h' }
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ answer: '**これは**テスト', turnId: 't1', durationMs: 1, isAborted: false, reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    spots.length = 0
    runs.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /これはテスト/ }))?.text).toBe('これはテスト')

    await ui.press({ key: 'play' })
    // say through a shell, its output batched by perl.
    expect(runs.map(argv => [...argv.slice(0, 2), ...argv.slice(3)])).toEqual([
      ['/bin/sh', '-c', 'sh', '-v', 'Kyoko (Japanese (Japan))', '-r', '175', '--interactive=bold', '-f', '-', 'これはテスト'],
    ])
    expect(runs[0]![2]).toMatch(/^say "\$@" \| \/usr\/bin\/perl -e '/)
    expect(spots).toEqual([{ start: 0, end: 0 }, { start: 0, end: 2 }, { start: 3, end: 6 }, null])
    expect(await ui.find({ key: 'play' })).toBeDefined()
    await ui.unmount()
  }
})

test('while say speaks, the pane draws the lit word and ⏸ stops it where it was', async ($, on) => {
  engine(on)
  let lit: () => void = () => {}
  on('state.set', (_, e, next) => {
    if (e.key === 'spot' && e.value !== null && e.value.end > e.value.start) lit()
    return next(e)
  })
  on('process.spawn', async function* (_, e, next) {
    yield { stream: 'stdout' as const, text: frame('', 'これ', 'はテスト') }
    // say keeps speaking until the stream is let go.
    await new Promise<void>(resolve => next.signal.addEventListener('abort', () => resolve()))
    return { value: { code: null, signal: 'SIGTERM' } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ answer: 'これはテスト', turnId: 't1', durationMs: 1, isAborted: false, reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const isLit = new Promise<void>(resolve => (lit = resolve))
    const playing = ui.press({ key: 'play' })
    await isLit
    await ui.find({ key: 'pause' })
    const word = (await ui.findAll({ type: 'Text', text: 'これ' })).find(found => found.props.inverse === true)
    expect(word).toBeDefined()

    await ui.press({ key: 'pause' })
    await playing
    expect((await ui.find({ key: 'play' }))?.props.label).toBe('▶ 続きから')
    await ui.press({ key: 'stop' })
    await ui.unmount()
  }
})

test('▸ beside a sentence reads from that sentence on', async ($, on) => {
  engine(on)
  const inputs: string[] = []
  const spots: unknown[] = []
  on('state.set', (_, e, next) => {
    if (e.key === 'spot') spots.push(e.value)
    return next(e)
  })
  on('process.spawn', async function* (_, e) {
    inputs.push(e.input ?? '')
    yield { stream: 'stdout' as const, text: frame('', '二文目', 'です。  三文目。') }
    yield { stream: 'stdout' as const, text: frame('二文目です。  ', '三文目', '。') + '\n\x1b[?25h' }
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ answer: '一文目。二文目です。\n\n三文目。', turnId: 't1', durationMs: 1, isAborted: false, reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    inputs.length = 0
    spots.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })
    // One ▸ per sentence, none for the blank line.
    const starts = (await ui.findAll({ type: 'Button' })).filter(found => found.props.label === '▸')
    expect(starts.map(found => found.props.key)).toEqual(['from-0', 'from-4', 'from-12'])

    await ui.press({ key: 'from-4' })
    expect(inputs).toEqual(['二文目です。  三文目。'])
    expect(spots).toEqual([{ start: 4, end: 4 }, { start: 4, end: 7 }, { start: 12, end: 15 }, null])
    await ui.unmount()
  }
})

test('▸ marks its sentence at once, so + before the first word keeps that place', async ($, on) => {
  engine(on)
  const inputs: string[] = []
  let spawned: () => void = () => {}
  on('process.spawn', async function* (_, e, next) {
    inputs.push(e.input ?? '')
    spawned()
    // say has not spoken a word yet, and keeps going until let go.
    await new Promise<void>(resolve => next.signal.addEventListener('abort', () => resolve()))
    return { value: { code: null, signal: 'SIGTERM' } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ answer: '一文目。二文目です。', turnId: 't1', durationMs: 1, isAborted: false, reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    inputs.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })
    let isSpawned = new Promise<void>(resolve => (spawned = resolve))
    const playing = ui.press({ key: 'from-4' })
    await isSpawned
    expect((await ui.findAll({ type: 'Text' })).find(found => found.props.color === 'claude')?.text).toBe('二文目です。')

    isSpawned = new Promise<void>(resolve => (spawned = resolve))
    const faster = ui.press({ key: 'faster' })
    await isSpawned
    expect(inputs).toEqual(['二文目です。', '二文目です。'])
    await ui.press({ key: 'stop' })
    await Promise.all([playing, faster])
    await ui.unmount()
  }
})

test('while say speaks the 。 after a heading, the heading stays lit', async ($, on) => {
  engine(on)
  let paused: () => void = () => {}
  on('state.set', (_, e, next) => {
    if (e.key === 'spot' && e.value?.start === 3) paused()
    return next(e)
  })
  on('process.spawn', async function* (_, e, next) {
    yield { stream: 'stdout' as const, text: frame('', '変更', '点。 本文です。') }
    yield { stream: 'stdout' as const, text: frame('変更点', '。', ' 本文です。') }
    await new Promise<void>(resolve => next.signal.addEventListener('abort', () => resolve()))
    return { value: { code: null, signal: 'SIGTERM' } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ answer: '## 変更点\n\n本文です。', turnId: 't1', durationMs: 1, isAborted: false, reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const isPaused = new Promise<void>(resolve => (paused = resolve))
    const playing = ui.press({ key: 'play' })
    await isPaused
    await ui.find({ key: 'pause' })
    expect((await ui.findAll({ type: 'Text' })).find(found => found.props.color === 'claude')?.text).toBe('変更点')
    await ui.press({ key: 'stop' })
    await playing
    await ui.unmount()
  }
})

test('say ending short of the last sentence (the sound output changed) keeps the place', async ($, on) => {
  engine(on)
  const spots: unknown[] = []
  on('state.set', (_, e, next) => {
    if (e.key === 'spot') spots.push(e.value)
    return next(e)
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: frame('', '一文目', '。二文目。') + '\n\x1b[?12l\x1b[?25h' }
    return { value: { code: 1, signal: null } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ answer: '一文目。二文目。', turnId: 't1', durationMs: 1, isAborted: false, reason: 'answer' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'play' })
  expect(spots.at(-1)).toEqual({ start: 0, end: 3 })
  expect((await ui.find({ key: 'play' }))?.props.label).toBe('▶ 続きから')
  await ui.unmount()
})

test('a stream that stays quiet for 45 s at 1x is let go, keeping the place', async ($, on) => {
  const clock = engine(on)
  let lit: () => void = () => {}
  on('state.set', (_, e, next) => {
    if (e.key === 'spot' && e.value !== null && e.value.end > e.value.start) lit()
    return next(e)
  })
  let isLetGo = false
  on('process.spawn', async function* (_, e, next) {
    yield { stream: 'stdout' as const, text: frame('', 'これ', 'はテスト') }
    // The engine's stream stuck: say talks on, nothing more arrives until it is let go.
    await new Promise<void>(resolve => next.signal.addEventListener('abort', () => resolve()))
    isLetGo = true
    return { value: { code: null, signal: 'SIGTERM' } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ answer: 'これはテスト', turnId: 't1', durationMs: 1, isAborted: false, reason: 'answer' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const isLit = new Promise<void>(resolve => (lit = resolve))
  const playing = ui.press({ key: 'play' })
  await isLit
  await clock.advance(44_000)
  expect(await ui.find({ key: 'pause' })).toBeDefined()
  await clock.advance(1_000)
  await playing
  expect(isLetGo).toBe(true)
  expect((await ui.find({ key: 'play' }))?.props.label).toBe('▶ 続きから')
  await ui.unmount()
})

test('speed steps through the table and is kept', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'faster' })
  await ui.press({ key: 'faster' })
  expect((await ui.find({ type: 'Text', text: /x$/ }))?.text).toBe('1.5x')
  for (let i = 0; i < 10; i++) await ui.press({ key: 'slower' })
  expect((await ui.find({ type: 'Text', text: /x$/ }))?.text).toBe('0.8x')
  await ui.unmount()
})
