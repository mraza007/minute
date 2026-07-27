export interface ToggleProps {
  on: boolean
  onToggle: () => void
  label: string
  /**
   * Inert but still visible/legible — for a toggle whose precondition isn't
   * met yet (e.g. Settings' "Capture system audio" before Screen Recording
   * permission is granted), same `aria-disabled` (not `disabled`) pattern
   * `SettingsView`'s `SelectableModelRow` already uses for an inert-but-
   * still-focusable-context row. Defaults to `false` — every existing call
   * site is unaffected.
   */
  disabled?: boolean
}

export function Toggle({ on, onToggle, label, disabled = false }: ToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-disabled={disabled}
      onClick={disabled ? undefined : onToggle}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        background: 'transparent',
        border: 'none',
        padding: 0,
        fontFamily: 'var(--serif)',
        fontSize: 13.5,
        color: 'inherit',
        textAlign: 'left',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        userSelect: 'none',
      }}
    >
      <span
        style={{
          width: 40,
          height: 24,
          boxSizing: 'border-box',
          borderRadius: 999,
          background: on ? 'var(--accent)' : 'var(--control-track)',
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
            // Paper-white knob rather than --card, so it stays legible
            // against both the accent fill (on) and the warm track (off) in
            // either appearance; the shadow is the one place a control is
            // allowed a lift, since the knob has to read as sitting *on* the
            // track.
            background: '#fff',
            boxShadow: '0 1px 2px rgba(0,0,0,.22)',
            transform: on ? 'translateX(16px)' : 'translateX(0)',
            transition: 'transform .18s',
          }}
        />
      </span>
      {label}
    </button>
  )
}
