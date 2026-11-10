/** Every non-zero category keeps at least this share of the usage bar. */
const MIN_STORAGE_SLICE_PCT = 1.5

/**
 * The usage bar's segments, as percentages that always sum to 100 or less.
 * Sizes are proportional, except that every non-zero category is floored at
 * [`MIN_STORAGE_SLICE_PCT`] and the others scale down to fit. True
 * proportions would draw audio and notes as slivers next to multi-GB
 * models, and a bar that looks like one colour reads as broken.
 */
export function storageBarSegments(
  modelsBytes: number,
  audioBytes: number,
  notesBytes: number,
): { key: 'audio' | 'models' | 'notes'; pct: number; color: string }[] {
  const total = modelsBytes + audioBytes + notesBytes
  const raw = [
    { key: 'audio' as const, bytes: audioBytes, color: 'var(--accent)' },
    { key: 'models' as const, bytes: modelsBytes, color: 'var(--speaker-3)' },
    { key: 'notes' as const, bytes: notesBytes, color: 'var(--ok-text)' },
  ]
  if (total <= 0) return raw.map(({ key, color }) => ({ key, color, pct: 0 }))

  // Tiny categories are pinned at the floor. The rest of the width is split
  // among the others in proportion to their true sizes, so the floor never
  // gets scaled back under itself.
  const rawPct = (bytes: number) => (bytes / total) * 100
  const isFloored = (bytes: number) => bytes > 0 && rawPct(bytes) < MIN_STORAGE_SLICE_PCT
  const flooredTotal = raw.filter(s => isFloored(s.bytes)).length * MIN_STORAGE_SLICE_PCT
  const unflooredRawTotal = raw.filter(s => !isFloored(s.bytes)).reduce((acc, s) => acc + rawPct(s.bytes), 0)
  const scale = unflooredRawTotal > 0 ? (100 - flooredTotal) / unflooredRawTotal : 0

  return raw.map(({ key, color, bytes }) => ({
    key,
    color,
    pct: bytes <= 0 ? 0 : isFloored(bytes) ? MIN_STORAGE_SLICE_PCT : rawPct(bytes) * scale,
  }))
}
