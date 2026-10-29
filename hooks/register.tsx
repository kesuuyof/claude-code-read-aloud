import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import { RATES, WPM, forSay, pickVoice, pieces, rowAt, sentences, toSpeech, tracker } from './text'

const PANE = 'read-aloud'
const TITLE = '読み上げ'
const text = atom({ plugin: 'read-aloud', key: 'text' } as const, '')
const latest = atom({ plugin: 'read-aloud', key: 'latest' } as const, '')
const spot = atom({ plugin: 'read-aloud', key: 'spot' } as const, null)
const isPlaying = atom({ plugin: 'read-aloud', key: 'isPlaying' } as const, false)
const rate = atom({ plugin: 'read-aloud', key: 'rate' } as const, null)

// The say that is speaking. `plays` counts every start and halt, so a play that
// was halted or replaced sees `mine !== plays` and leaves the state alone;
// `speaking` holds the count of the play that is reading, if any.
let child: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
let plays = 0
let speaking: number | undefined
let voice: string | undefined

// ponytail: works around the engine (2.1.309) sometimes ceasing to pass a child's output on:
// the stream neither moves nor ends while say talks on, more often the more pieces it reads,
// and say redraws its line in hundreds of 1-9 byte writes a second. perl hands the output on
// once 80 ms pass with nothing new, one piece a redraw. Drop it when the engine is fixed.
// binmode: PERL_UNICODE or PERL5OPT=-C would otherwise make sysread die.
const BATCH =
  'binmode STDIN;binmode STDOUT;my $b="";my $r="";vec($r,fileno(STDIN),1)=1;' +
  'while(1){my $n=select(my $o=$r,undef,undef,length($b)?0.08:undef);' +
  'if($n>0){my $g=sysread(STDIN,my $c,65536);last unless $g;$b.=$c;next}syswrite(STDOUT,$b);$b=""}' +
  'syswrite(STDOUT,$b) if length $b'
const sayArgv = (args: string[]) => ['/bin/sh', '-c', `say "$@" | /usr/bin/perl -e '${BATCH}'`, 'sh', ...args]

// Seconds at 1x with no output before a play counts as stuck, fewer the faster it reads.
// say stays quiet while it speaks what it reports as one word, and that can be a whole
// spaceless stretch up to a "/" (about 6 characters a second at 1x).
const STUCK_S = 45

function halt() {
  plays++
  speaking = undefined
  const running = child
  child = undefined
  void running?.return({ code: null, signal: 'SIGTERM' })
}

// isPlaying copies `speaking` as it is when the write lands, so racing writes end on the truth.
const showPlaying = ($: EngineInterface) => update($, isPlaying, () => speaking !== undefined)

async function speed($: EngineInterface): Promise<number> {
  const picked = await read($, rate)
  if (picked !== null) return picked
  const kept = await $.store.get('rate')
  return typeof kept === 'number' && RATES.includes(kept) ? kept : 1
}

// `drawn` is the text the pressed button was drawn with: a press on a drawing of an
// answer that has since been replaced would start the new one at a stranger's offset.
async function play($: EngineInterface, from: number, drawn?: string) {
  halt()
  const mine = (speaking = plays)
  const all = await read($, text)
  const wpm = WPM[await speed($)] ?? 175
  // Looked up at the first ▶, not at every session start (a `claude -p` run included).
  voice ??= pickVoice((await $.process.run(['say', '-v', '?']).catch(() => undefined))?.stdout ?? '')
  if (mine !== plays) return
  if (!all || !voice || (drawn !== undefined && drawn !== all)) {
    speaking = undefined
    if (!voice) $.ui.toast('日本語の音声が見つかりません（システム設定で「システムの声」を検索して追加できます）')
    return
  }
  // Mark where say starts, so a speed change or ⏸ before its first word keeps this place.
  await update($, spot, () => ({ start: from, end: from }))
  if (mine !== plays) return
  const spoken = forSay(all)
  const say = $.process.spawn({
    argv: sayArgv(['-v', voice, '-r', String(wpm), '--interactive=bold', '-f', '-']),
    env: { TERM: 'xterm-256color' },
    input: spoken.slice(from),
  })
  child = say
  await showPlaying($)
  const next = tracker(spoken, from)
  const rows = sentences(all)
  let shown = -1
  let lit = -1
  let errors = ''
  // A stream stuck as above would hold ⏸ up for good: stop the way ⏸ does, keeping the place.
  let idle = 0
  const stuck = Math.ceil((STUCK_S * WPM[1]!) / wpm)
  const watch = $.clock.every(1000, () => {
    if (++idle < stuck || mine !== plays) return
    $.ui.toast('読み上げ位置が進まなくなったので一時停止しました。▶ で続きから読めます')
    void pause($)
  })
  try {
    for await (const chunk of say) {
      if (mine !== plays) break
      idle = 0
      if (chunk.stream === 'stderr') {
        errors += chunk.text
        continue
      }
      const { spot: word, isDone } = next(chunk.text)
      if (word) {
        lit = word.start
        await update($, spot, () => word)
        const now = rowAt(rows, word.start)
        // Keeping the row in view is a nicety: a scroll the pane refuses changes nothing.
        if (now !== shown) $.ui.scroll({ to: { key: `row-${(shown = now)}` }, in: PANE }).catch(() => undefined)
      }
      // say sometimes lingers after its last word; leaving the loop ends it.
      if (isDone) break
    }
  } catch (error) {
    errors ||= String(error)
  } finally {
    watch.cancel()
  }
  if (mine !== plays) return
  child = undefined
  speaking = undefined
  if (errors.trim()) $.ui.toast(`say: ${errors.trim()}`)
  // say also ends early, as if done, when the sound output changes (AirPods to the speaker):
  // short of the last sentence, keep the place as ⏸ does.
  if (lit >= 0 && rowAt(rows, lit) < rowAt(rows, all.length)) {
    $.ui.toast('読み上げが途中で止まりました。▶ で続きから読めます')
    await showPlaying($)
    return
  }
  await finish($, mine)
}

// Back to the top, showing the answer that waited while this one was read.
async function finish($: EngineInterface, mine: number) {
  await showPlaying($)
  if (mine !== plays) return
  await update($, spot, () => null)
  const newest = await read($, latest)
  if (mine !== plays) return
  await update($, text, () => newest)
}

async function pause($: EngineInterface) {
  halt()
  await showPlaying($)
}

async function stop($: EngineInterface) {
  halt()
  await finish($, plays)
}

async function setRate($: EngineInterface, step: number) {
  const now = await speed($)
  const picked = await update($, rate, value => RATES[Math.min(RATES.length - 1, Math.max(0, RATES.indexOf(value ?? now) + step))]!)
  await $.store.set('rate', picked)
  if (speaking !== undefined) void play($, (await read($, spot))?.start ?? 0)
}

// A new answer shows at once, unless one is being read: then it waits for the end.
async function setLatest($: EngineInterface, answer: string) {
  const speech = toSpeech(answer)
  await update($, latest, () => speech)
  if (speaking !== undefined) return
  await update($, text, () => speech)
  await update($, spot, () => null)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'read-aloud', description: '最新の回答を読み上げるパネルを開く' })
    // A reload ends say: show it stopped, with any answer that waited meanwhile.
    await showPlaying($)
    const newest = await read($, latest)
    if (newest !== (await read($, text))) {
      await update($, text, () => newest)
      await update($, spot, () => null)
    }
    if (!newest) {
      const last = (await $.session.messages()).findLast(m => m.role === 'assistant' && m.text.trim() !== '')
      if (last) await setLatest($, last.text)
    }
    // A `claude -p` run has no surface to open it on.
    void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

    return started
  })

  // /clear keeps this module, and so say, alive; the host clears the state itself.
  on('session.end', ($, e, next) => {
    halt()

    return next(e)
  })

  // Closing the pane takes its buttons away, so stop speaking (▶ resumes once reopened).
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await pause($)

    return closed
  })

  on('command.run', { command: 'read-aloud' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: '読み上げパネルを開きました。' }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.answer.trim() !== '') await setLatest($, e.answer)

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = await read($, text)
    const word = await read($, spot)
    const playing = await read($, isPlaying)
    const shownSpeed = await speed($)

    const controls = (
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap={1}>
        {playing ? (
          <Button key="pause" label="⏸ 一時停止" onPress={() => void pause($)} />
        ) : (
          <Button key="play" variant="primary" label={word ? '▶ 続きから' : '▶ 再生'} onPress={() => void play($, word?.start ?? 0, all)} />
        )}
        <Button key="stop" label="■ 停止" onPress={() => void stop($)} />
        <Button key="slower" label="−" onPress={() => void setRate($, -1)} />
        <Text>{shownSpeed}x</Text>
        <Button key="faster" label="+" onPress={() => void setRate($, 1)} />
      </Box>
    )
    if (!all) {
      return (
        <Box flexDirection="column" gap={1}>
          {controls}
          <Text dimColor>まだ回答がありません。</Text>
        </Box>
      )
    }

    // One sentence a row, so its ▸ can start the reading there (a Button holds no styled
    // text on desktop, and draws on one line, so the sentence itself cannot be the button).
    const rows = sentences(all)
    const now = word ? rowAt(rows, word.start) : -1
    const lines = rows.map((row, i) => {
      if (row.start === row.end) {
        return (
          <Box key={`row-${i}`}>
            <Text> </Text>
          </Box>
        )
      }
      const color = i === now ? 'claude' : undefined
      // The words as strings beside an element: the desktop draws a Text holding only a
      // short unspaced string (most Japanese sentences) on one line, past a narrow pane.
      return (
        <Box key={`row-${i}`} flexDirection="row" alignItems="flex-start" gap={1}>
          <Button key={`from-${row.start}`} plain dimColor label="▸" onPress={() => void play($, row.start, all)} />
          <Text color={color}>
            {pieces(all.slice(row.start, row.end), row.start, word).map(piece =>
              piece.isWord ? (
                <Text color={color} inverse bold>
                  {piece.text}
                </Text>
              ) : (
                piece.text
              ),
            )}
            <Text>{''}</Text>
          </Text>
        </Box>
      )
    })

    return (
      <Box flexDirection="column" gap={1}>
        {controls}
        <Box flexDirection="column">{lines}</Box>
      </Box>
    )
  })
}
