// A range of the pane's text, as JS string offsets.
export type Spot = { start: number; end: number }

declare module 'claude-code' {
  interface PluginState {
    'read-aloud': {
      // What the pane shows and say reads: the answer with Markdown stripped.
      text: string
      // The newest answer; it replaces `text` once nothing is playing.
      latest: string
      // The word say reported last; null before the first word and after the end.
      spot: Spot | null
      isPlaying: boolean
      // Speed as a multiple of say's default; null until picked this session,
      // when the one kept in $.store applies (the host clears state on /clear).
      rate: number | null
    }
  }
}
