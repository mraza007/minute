import { memo } from 'react'

interface WaveformProps {
  paused?: boolean
}

export const Waveform = memo(function Waveform({ paused }: WaveformProps) {
  return (
    <div
      data-testid="waveform-bars"
      style={{ display: 'flex', gap: 3, alignItems: 'center', height: 32, flex: 1, minWidth: 120, overflow: 'hidden' }}
    >
      {Array.from({ length: 56 }, (_, i) => (
        <span
          key={i}
          style={{
            width: 3,
            height: 24,
            flex: 'none',
            borderRadius: 2,
            background: 'var(--accent)',
            animation: `wf ${(0.7 + (i % 5) * 0.14).toFixed(2)}s ease-in-out ${(i * 0.05).toFixed(2)}s infinite`,
            ...(paused ? { animationPlayState: 'paused' as const } : {}),
          }}
        />
      ))}
    </div>
  )
})
