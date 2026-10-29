import { expect, test } from 'claude-code/testing'

import { forSay, pickVoice, pieces, rowAt, sentences, toSpeech, tracker } from '../hooks/text'

test('Markdown becomes text say can read', () => {
  const md = '## 方針\n\n- `turn.complete` で **回答** を取る\n- [詳細](https://example.com) は https://a.b/c\n\n```ts\nconst x = 1\n```\n\n| 列 | 値 |\n|---|---|\n| a | 1 |'
  expect(toSpeech(md)).toBe('方針\n\nturn.complete で 回答 を取る\n詳細 は URL\n\n（コード省略）\n\n列、値\na、1')
})

test('a URL ends where the Japanese starts', () => {
  expect(toSpeech('詳細はhttps://example.com/docsを参照。次の文。')).toBe('詳細はURLを参照。次の文。')
  expect(toSpeech('リポジトリ（https://github.com/a/b）にあります。')).toBe('リポジトリ（URL）にあります。')
  expect(toSpeech('See https://example.com/docs. Next.')).toBe('See URL. Next.')
})

test('only fences at a line start hide code, and a longer fence holds a shorter one', () => {
  const inline = 'コードは ` ``` ` で囲みます。\n\n大事な説明。\n\n```ts\nconst a = 1\n```\n\n最後のまとめ。'
  expect(toSpeech(inline)).toContain('大事な説明。\n\n（コード省略）\n\n最後のまとめ。')
  const nested = '例:\n\n````markdown\n```bash\nnpm test\n```\n````\n\n以上です。'
  expect(toSpeech(nested)).toBe('例:\n\n（コード省略）\n\n以上です。')
})

test('emphasis goes, but code, globs and arithmetic keep their * and _', () => {
  expect(toSpeech('glob は `src/**/*.test.ts`、計算は 2 * 3、Python の `__init__` と *強調* と __太字__。')).toBe(
    'glob は src/**/*.test.ts、計算は 2 * 3、Python の __init__ と 強調 と 太字。',
  )
  expect(toSpeech('snake_case_name はそのまま')).toBe('snake_case_name はそのまま')
  // Emphasis wrapped around a code span goes too.
  expect(toSpeech('- **`say` が止まらない**：`a**b` は *`x`* と __`y`__')).toBe('say が止まらない：a**b は x と y')
  // A private-use glyph (an icon font's) stays itself.
  expect(toSpeech('\ue000 は `starship`、\ue001 は `git`')).toBe('\ue000 は starship、\ue001 は git')
})

test('say gets one line with no markup, and every offset holds', () => {
  const text = '見出し\n本文です。\n\n型は Promise<void> と [[volm 0]]'
  const spoken = forSay(text)
  expect(spoken).toBe('見出し。本文です。  型は Promise void  と   volm 0]]')
  expect(spoken.length).toBe(text.length)
})

test('the word say marks bold is found in the text, in order', () => {
  const spoken = 'これはテストです。テストです。'
  const next = tracker(spoken, 0)
  const frame = (before: string, word: string, after: string) => `\r\x1b[M${before}\x1b[1m${word}\x1b(B\x1b[m${after}`
  expect(next('\x1b[?25l' + frame('', 'これ', 'はテストです。テストです。')).spot).toEqual({ start: 0, end: 2 })
  // A frame split across two chunks is read once it is whole.
  const third = frame('これは', 'テスト', 'です。テストです。')
  expect(next(third.slice(0, 12)).spot).toBeUndefined()
  expect(next(third.slice(12)).spot).toEqual({ start: 3, end: 6 })
  // The second テスト is the later one, not the one already read.
  expect(next(frame('これはテストです。', 'テスト', 'です。')).spot).toEqual({ start: 9, end: 12 })
  expect(next('\n\x1b[?12l\x1b[?25h').isDone).toBe(true)
  // Resuming mid-text searches from there.
  expect(tracker(spoken, 9)(frame('', 'テスト', 'です。')).spot).toEqual({ start: 9, end: 12 })
})

test('a word overlapping the one before does not jump to a later copy', () => {
  const spoken = 'x - y。最後です。次に設定を読みます。それから後です。'
  const next = tracker(spoken, 0)
  const bold = (word: string) => `\x1b[1m${word}\x1b(B\x1b[m`
  next(bold('最') + bold('後で'))
  expect(next(bold('後です')).spot).toEqual({ start: 7, end: 10 })
  expect(next(bold('次')).spot).toEqual({ start: 11, end: 12 })
})

test('each sentence is a row, a blank line an empty one, and code keeps its ? and !', () => {
  const text = '一文目。二文目です。\n\n「本当？」と聞く。 Is it? Yes!\nコードは a?.b と a != b\n   '
  const rows = sentences(text)
  expect(rows.map(row => text.slice(row.start, row.end))).toEqual([
    '一文目。',
    '二文目です。',
    '',
    '「本当？」',
    'と聞く。',
    'Is it?',
    'Yes!',
    'コードは a?.b と a != b',
    '',
  ])
  expect(rows[2]).toEqual({ start: 11, end: 11 })
  const code = 'a ?? b や cond ? x : y、Bash の ! コマンド。すごい！? はい。“完了。”と答えます。'
  expect(sentences(code).map(row => code.slice(row.start, row.end))).toEqual([
    'a ?? b や cond ? x : y、Bash の ! コマンド。',
    'すごい！?',
    'はい。',
    '“完了。”',
    'と答えます。',
  ])
})

test('the 。 say speaks after a heading belongs to the heading', () => {
  const rows = sentences('変更点\n\n本文です。')
  expect([rowAt(rows, 0), rowAt(rows, 3), rowAt(rows, 4), rowAt(rows, 5)]).toEqual([0, 0, 0, 2])
})

test('a row is cut where the word begins and ends', () => {
  expect(pieces('二文目です。', 4, { start: 6, end: 8 })).toEqual([
    { text: '二文', isWord: false },
    { text: '目で', isWord: true },
    { text: 'す。', isWord: false },
  ])
  expect(pieces('二文目です。', 4, { start: 0, end: 3 })).toEqual([{ text: '二文目です。', isWord: false }])
  expect(pieces('二文目です。', 4, null)).toEqual([{ text: '二文目です。', isWord: false }])
})

test('an Enhanced Japanese voice wins over Kyoko and the novelty voices', () => {
  const list = [
    'Eddy (Japanese (Japan)) ja_JP    # こんにちは',
    'Kyoko (Japanese (Japan)) ja_JP    # こんにちは',
    'Samantha            en_US    # Hello',
  ].join('\n')
  expect(pickVoice(list)).toBe('Kyoko (Japanese (Japan))')
  expect(pickVoice(list + '\nKyoko (Enhanced) ja_JP    # こんにちは')).toBe('Kyoko (Enhanced)')
  expect(pickVoice('Samantha            en_US    # Hello')).toBeUndefined()
})
