// Pure note -> markdown template, built entirely from data already on disk
// (a note's meta.json + transcript.json — no summarization, no network).
// Mirrors the Stage 1 mock's markdown-tab template shape minus the
// "## Summary" / "## Decisions" / "## Action items" sections, which depend
// on the local LLM and are Stage 3 work.

import type { NoteMeta, StoredSegment } from '../ipc/types'
import { formatMmSs } from './adapters'

function formatDateLabel(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

function transcriptBody(segments: StoredSegment[]): string {
  if (segments.length === 0) return '_No speech detected._'
  return segments.map(seg => `**${seg.speaker}** (${formatMmSs(seg.start)})\n${seg.text}`).join('\n\n')
}

/**
 * Renders a note's markdown export/preview from its metadata and stored
 * transcript. `durationSec` is rounded to the nearest whole minute (same
 * rounding `noteMetaToListItem` uses for the sidebar's "N min" line).
 */
export function noteToMarkdown(meta: NoteMeta, segments: StoredSegment[]): string {
  const minutes = Math.round(meta.durationSec / 60)
  const header = `# ${meta.title}\n\n**Date:** ${formatDateLabel(meta.createdAt)} · **Duration:** ${minutes} min · **Speakers:** ${meta.speakers}`
  return `${header}\n\n## Transcript\n\n${transcriptBody(segments)}`
}
