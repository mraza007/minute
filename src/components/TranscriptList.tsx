import type { TranscriptSegment } from '../types'

interface TranscriptListProps {
  segments: TranscriptSegment[]
}

function avatarColors(segment: TranscriptSegment) {
  if (segment.isMe) return { background: '#1c1a18', color: '#fff' }
  if (segment.initials === 'TR' || segment.speaker.startsWith('Tom')) {
    return { background: '#fde8e4', color: '#b3200c' }
  }
  return { background: '#eceae7', color: '#6d675f' }
}

function Segment({ segment }: { segment: TranscriptSegment }) {
  const { background, color } = avatarColors(segment)
  const isTr = segment.initials === 'TR' || segment.speaker.startsWith('Tom')

  const content = (
    <>
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: '50%',
          background,
          color,
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
          <b style={isTr ? { color: '#b3200c' } : undefined}>{segment.speaker}</b>
          <span style={{ color: segment.highlight ? '#c4938a' : '#b0a9a2' }}>{segment.time}</span>
          {segment.highlight && (
            <span
              style={{
                marginLeft: 'auto',
                padding: '2px 9px',
                borderRadius: 999,
                background: '#e04430',
                color: '#fff',
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: '.04em',
              }}
            >
              HIGHLIGHT
            </span>
          )}
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.65, color: '#33302c', textWrap: 'pretty' }}>{segment.text}</div>
      </div>
    </>
  )

  if (!segment.highlight) {
    return <div style={{ display: 'flex', gap: 12 }}>{content}</div>
  }

  return (
    <div
      style={{
        border: '1px solid rgba(224,68,48,.3)',
        background: '#fff4f1',
        borderRadius: 12,
        padding: '14px 18px',
        boxShadow: '0 1px 3px rgba(0,0,0,.04)',
        display: 'flex',
        gap: 12,
      }}
    >
      {content}
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
