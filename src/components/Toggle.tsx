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
      type="button"
      className="toggle-control"
      role="switch"
      aria-checked={on}
      aria-disabled={disabled}
      data-state={on ? 'on' : 'off'}
      onClick={disabled ? undefined : onToggle}
    >
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" data-testid="toggle-knob" />
      </span>
      <span className="toggle-label">{label}</span>
    </button>
  )
}
