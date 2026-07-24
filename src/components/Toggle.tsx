export interface ToggleProps {
  on: boolean
  onToggle: () => void
  label: string
}

export function Toggle({ on, onToggle, label }: ToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        background: 'transparent',
        border: 'none',
        padding: 0,
        fontFamily: 'inherit',
        fontSize: 13,
        color: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <span
        style={{
          width: 40,
          height: 24,
          boxSizing: 'border-box',
          borderRadius: 999,
          background: on ? 'var(--accent)' : '#d8d4cf',
          // Constant 1px border in both states (transparent when on, over
          // the accent fill) — a none↔1px border toggle shifts the
          // absolutely-positioned knob's padding-edge origin by 1px between
          // states, since `top`/`left` below are relative to the padding
          // box, not the border box. Keeping the border width fixed and
          // only swapping its color keeps that geometry identical.
          border: on ? '1px solid transparent' : '1px solid var(--control-border)',
          position: 'relative',
          flex: 'none',
          display: 'inline-block',
          transition: 'background .18s, border-color .18s',
        }}
      >
        <span
          data-testid="toggle-knob"
          style={{
            position: 'absolute',
            top: 2,
            // Constant `left` (the off position) + a `transform` for the
            // on/off delta (M12) — transform-based instead of animating
            // `left` itself, same geometry as before: off-left 2, on-left
            // 18 (track width 40 − knob 20 − inset 2).
            left: 2,
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: 'var(--card)',
            boxShadow: '0 1px 3px rgba(0,0,0,.25)',
            transform: on ? 'translateX(16px)' : 'translateX(0)',
            transition: 'transform .18s',
          }}
        />
      </span>
      {label}
    </button>
  )
}
