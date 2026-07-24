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
          width: 36,
          height: 22,
          boxSizing: 'border-box',
          borderRadius: 999,
          background: on ? 'var(--accent)' : '#d8d4cf',
          border: on ? 'none' : '1px solid var(--control-border)',
          position: 'relative',
          flex: 'none',
          display: 'inline-block',
          transition: 'background .18s',
        }}
      >
        <span
          data-testid="toggle-knob"
          style={{
            position: 'absolute',
            top: 2,
            left: on ? 16 : 2,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: 'var(--card)',
            boxShadow: '0 1px 3px rgba(0,0,0,.25)',
            transition: 'left .18s',
          }}
        />
      </span>
      {label}
    </button>
  )
}
