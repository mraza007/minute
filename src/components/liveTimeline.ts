import type { NoteMarker } from '../ipc/types'
import type { LiveTranscriptGroup } from '../state/adapters'

export type LiveTimelineItem =
  | { kind: 'turn'; group: LiveTranscriptGroup }
  | { kind: 'marker'; marker: NoteMarker; index: number }

/**
 * The live transcript and its markers as one list in time order. A marker
 * sits after the last turn that started before it, so a marker added while
 * the transcript is behind still lands in the right place once the later
 * turns arrive.
 */
export function liveTimeline(groups: readonly LiveTranscriptGroup[], markers: readonly NoteMarker[]): LiveTimelineItem[] {
  const pending = markers
    .map((marker, index) => ({ kind: 'marker' as const, marker, index }))
    .sort((a, b) => a.marker.seconds - b.marker.seconds)
  const items: LiveTimelineItem[] = []
  let next = 0
  for (const group of groups) {
    while (next < pending.length && pending[next].marker.seconds < group.start) {
      items.push(pending[next])
      next += 1
    }
    items.push({ kind: 'turn', group })
  }
  return items.concat(pending.slice(next))
}
