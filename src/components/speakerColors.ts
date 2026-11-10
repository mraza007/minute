import type { CSSProperties } from 'react'

/** A slot in the `--speaker-N` / `--speaker-N-tint` token ramp (index.css). */
export type SpeakerColor = 1 | 2 | 3 | 4 | 5 | 6

/** Maps each speaker label to its colour slot. */
export type SpeakerColors = ReadonlyMap<string, SpeakerColor>

const YOU = 'You'
const YOU_COLOR: SpeakerColor = 1
const OTHER_COLORS: readonly SpeakerColor[] = [2, 3, 4, 5, 6]

/**
 * Assigns one colour per speaker. "You" is always blue; everyone else takes
 * the next colour in order of first appearance, so a speaker keeps the same
 * colour while the transcript is filtered and after a rename in place.
 */
export function assignSpeakerColors(speakers: readonly string[]): SpeakerColors {
  const colors = new Map<string, SpeakerColor>()
  let next = 0
  for (const speaker of speakers) {
    if (colors.has(speaker)) continue
    if (speaker === YOU) {
      colors.set(speaker, YOU_COLOR)
    } else {
      colors.set(speaker, OTHER_COLORS[next % OTHER_COLORS.length])
      next += 1
    }
  }
  return colors
}

export const EMPTY_SPEAKER_COLORS: SpeakerColors = new Map()

const UNKNOWN_STYLE = {
  '--speaker-color': 'var(--ink-muted)',
  '--speaker-tint': 'var(--surface-softer)',
} as CSSProperties

/**
 * Sets the `--speaker-color` / `--speaker-tint` pair the chip, dot, and
 * transcript label read. An unknown speaker (`null`) is grey ink, never a
 * speaker colour: it is nobody, so it must not look like one more person.
 */
export function speakerColorStyle(colors: SpeakerColors, speaker: string | null): CSSProperties {
  if (speaker === null) return UNKNOWN_STYLE
  const slot = colors.get(speaker) ?? OTHER_COLORS[0]
  return {
    '--speaker-color': `var(--speaker-${slot})`,
    '--speaker-tint': `var(--speaker-${slot}-tint)`,
  } as CSSProperties
}
