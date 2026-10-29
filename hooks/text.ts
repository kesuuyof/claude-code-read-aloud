import type { Spot } from '../types'

// Speed multiple → `say -r` words per minute, measured with Kyoko on this Mac
// (say's rate is not linear in wpm). Re-measure if the voice changes.
export const WPM: Record<number, number> = { 0.8: 80, 1: 175, 1.25: 228, 1.5: 281, 1.75: 334, 2: 381, 2.5: 503, 3: 582 }
export const RATES = Object.keys(WPM).map(Number).sort((a, b) => a - b)

// A Markdown reply → plain text that both the pane shows and say reads.
export function toSpeech(md: string): string {
  // Each code span stands in as one private-use character while emphasis goes, so
  // **`say` x** loses its ** and `src/**/*.ts` keeps its own. A private-use character
  // already in the text takes a slot too, so it comes back as itself.
  const code: string[] = []
  const masked = md
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[`~]*[ \t]*$|(?![\s\S]))/gm, '（コード省略）')
    .replace(/^[ \t]*\|?([ \t]*:?-+:?[ \t]*\|)+[ \t]*(:?-+:?[ \t]*)?(\n|$)/gm, '') // table rule rows
    .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, '') // horizontal rules
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) => row.split('|').map(cell => cell.trim()).filter(Boolean).join('、'))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // A URL ends at the first non-ASCII letter (Japanese has no space after it) and drops a trailing period.
    .replace(/<?https?:\/\/[^\s<>)\u0080-\uffff]*[^\s<>).,;:!?'"\u0080-\uffff]>?/g, 'URL')
    .replace(/^[ \t]*(#{1,6}|>+|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/`[^`\n]+`|[\ue000-\uf8ff]/g, m => String.fromCharCode(0xe000 + code.push(m.length > 1 ? m.slice(1, -1) : m) - 1))
  return plain(masked)
    .replace(/[\ue000-\uf8ff]/g, c => code[c.charCodeAt(0) - 0xe000]!)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Emphasis in pairs (**x**, __x__, ~~x~~, *x*); a lone * or _ stays (2 * 3, snake_case).
function plain(text: string): string {
  return text
    .replace(/(\*\*|~~)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(?<!\w)__(?=\S)([^\n]*?\S)__(?!\w)/g, '$1')
    .replace(/(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1')
    .replace(/`/g, '')
}

// say reads one line: each newline becomes a pause (。) or a space. `<x>` and `[[x]]`
// are say's own markup (it stops reading at a tag), so < > [ become spaces.
// Every replacement is one character for one, so offsets into the pane's text hold.
export function forSay(text: string): string {
  return text
    .replace(/\n/g, (_, i: number) => (/[。！？!?.、,:：\s]/.test(text[i - 1] ?? '\n') ? ' ' : '。'))
    .replace(/[<>[]/g, ' ')
}

// The pane's rows: every sentence of the text, trimmed, and an empty row for a blank line.
// A sentence ends at 。！？ (with any ! ? and closing bracket after it), or at ! ? right
// after a word and before a space, so code like a?.b, a ?? b or cond ? x : y stays whole.
export function sentences(text: string): Spot[] {
  const rows: Spot[] = []
  let at = 0
  for (const line of text.split('\n')) {
    const ends = [...line.matchAll(/[。！？]+[!?]*[」』）】)"'”’]*|(?<![\s!?])[!?]+(?=\s|$)/g)].map(m => m.index + m[0].length)
    const cuts = [0, ...ends, line.length]
    const before = rows.length
    for (let i = 1; i < cuts.length; i++) {
      const piece = line.slice(cuts[i - 1], cuts[i])
      const start = at + cuts[i - 1]! + piece.length - piece.trimStart().length
      if (piece.trim()) rows.push({ start, end: start + piece.trim().length })
    }
    if (rows.length === before) rows.push({ start: at, end: at })
    at += line.length + 1
  }
  return rows
}

// The row a position belongs to: the last sentence starting at or before it, so the 。
// forSay puts at a line's end still belongs to that line. -1 before the first.
export function rowAt(rows: Spot[], at: number): number {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.start < rows[i]!.end && rows[i]!.start <= at) return i
  return -1
}

// One row cut where the word begins and ends.
export function pieces(row: string, start: number, word: Spot | null) {
  const a = word ? Math.min(row.length, Math.max(0, word.start - start)) : 0
  const b = word ? Math.min(row.length, Math.max(a, word.end - start)) : 0
  return [
    { text: row.slice(0, a), isWord: false },
    { text: row.slice(a, b), isWord: true },
    { text: row.slice(b), isWord: false },
  ].filter(piece => piece.text !== '')
}

// `say --interactive=bold` redraws its line for every word, the word wrapped in
// ESC[1m … ESC(B ESC[m, and shows the cursor again (ESC[?25h) when it is done.
// Feed it stdout as it comes; it answers the newest word's range in `spoken`.
const BOLD = /\x1b\[1m([\s\S]*?)\x1b\(B\x1b\[m/g
export function tracker(spoken: string, from: number) {
  let buffer = ''
  let last = from
  let cursor = from
  return (chunk: string): { spot?: Spot; isDone: boolean } => {
    buffer += chunk
    let spot: Spot | undefined
    let used = 0
    for (const match of buffer.matchAll(BOLD)) {
      used = match.index + match[0].length
      const word = match[1]!
      // say's ranges can overlap the word before (後で, then 後です): take that over a later copy.
      const back = spoken.indexOf(word, last)
      const at = back >= 0 && back < cursor && back + word.length > cursor ? back : spoken.indexOf(word, cursor)
      // ponytail: skips a word say spells differently; a fuzzy match if that shows up
      if (word.trim() === '' || at < 0 || at - cursor > 200) continue
      spot = { start: at, end: at + word.length }
      last = at
      cursor = spot.end
    }
    const isDone = buffer.includes('\x1b[?25h')
    buffer = buffer.slice(used)
    return { spot, isDone }
  }
}

// The Japanese voice to use from `say -v '?'`: an Enhanced/Premium one if downloaded.
export function pickVoice(list: string): string | undefined {
  const names = list
    .split('\n')
    .filter(line => /\sja_JP\s/.test(line))
    .map(line => line.replace(/\s+ja_JP\s.*$/, '').trim())
  const rank = (name: string) => (/Enhanced|Premium|拡張|プレミアム/.test(name) ? 0 : /^(Kyoko|Otoya)\b/.test(name) ? 1 : 2)
  return names.sort((a, b) => rank(a) - rank(b))[0]
}
