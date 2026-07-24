import type { TranscriptSegment } from '../types'

interface TranscriptListProps {
  segments: TranscriptSegment[]
}

function Segment({ segment }: { segment: TranscriptSegment }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: '50%',
          background: 'var(--panel-warm)',
          color: 'var(--ink-muted)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 700,
          flex: 'none',
        }}
      >
        {segment.initials}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 9, fontSize: 12, marginBottom: 3, alignItems: 'baseline' }}>
          <b>{segment.speaker}</b>
          <span style={{ color: 'var(--ink-faint)' }}>{segment.time}</span>
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--ink-body)', textWrap: 'pretty' }}>{segment.text}</div>
      </div>
    </div>
  )
}

export function TranscriptList({ segments }: TranscriptListProps) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 700 }}>
      {segments.map((segment, i) => (
        <Segment key={i} segment={segment} />
      ))}
    </div>
  )
}
