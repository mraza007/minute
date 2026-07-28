import { memo } from 'react'

interface WaveformProps {
  paused?: boolean
}

const WAVEFORM_BARS = Array.from({ length: 56 }, (_, index) => ({
  index,
  animation: `wf ${(0.7 + (index % 5) * 0.14).toFixed(2)}s ease-in-out ${(index * 0.05).toFixed(2)}s infinite`,
}))

export const Waveform = memo(function Waveform({ paused }: WaveformProps) {
  return (
    <div
      data-testid="waveform-bars"
      className="waveform"
      data-paused={paused ? 'true' : 'false'}
      aria-hidden="true"
      style={{ display: 'flex', gap: 2.5, alignItems: 'center', height: 26, flex: 1, minWidth: 120, overflow: 'hidden' }}
    >
      {WAVEFORM_BARS.map(bar => (
        <span
          key={bar.index}
          className="wf-bar"
          style={{
            width: 2.5,
            height: 22,
            flex: 'none',
            borderRadius: 1,
            background: 'var(--accent)',
            animation: bar.animation,
            ...(paused ? { animationPlayState: 'paused' as const } : {}),
          }}
        />
      ))}
    </div>
  )
})
