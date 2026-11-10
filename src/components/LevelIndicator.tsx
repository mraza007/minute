import { memo } from 'react'

export type LevelIndicatorState = 'live' | 'paused' | 'idle'

const BARS = Array.from({ length: 5 }, (_, index) => ({
  index,
  animation: `wf ${(0.7 + (index % 5) * 0.14).toFixed(2)}s ease-in-out ${(index * 0.09).toFixed(2)}s infinite`,
}))

/**
 * A small sign that audio is flowing, beside the health line. It moves only
 * while the microphone is delivering sound: paused holds the bars where they
 * are, and idle (no input yet, silence, a lost device) rests them flat.
 */
export const LevelIndicator = memo(function LevelIndicator({ state }: { state: LevelIndicatorState }) {
  return (
    <span data-testid="level-indicator" className="level-indicator" data-state={state} aria-hidden="true">
      {BARS.map(bar => (
        <span
          key={bar.index}
          className="wf-bar"
          style={state === 'idle' ? undefined : { animation: bar.animation, animationPlayState: state === 'paused' ? 'paused' : undefined }}
        />
      ))}
    </span>
  )
})
