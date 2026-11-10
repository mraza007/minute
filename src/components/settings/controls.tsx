import { useId, type ReactNode } from 'react'
import './settings.css'

interface SettingRowProps {
  title: string
  description?: ReactNode
  /** Indents the row under the switch it depends on. */
  nested?: boolean
  /** The id the control should reference, so the title names it. */
  titleId?: string
  descriptionId?: string
  children: ReactNode
}

/** A title and a line of help on the left, the control on the right. */
export function SettingRow({ title, description, nested = false, titleId, descriptionId, children }: SettingRowProps) {
  return (
    <div className="st-row" data-nested={nested ? 'true' : undefined}>
      <div className="st-row-text">
        <div className="st-row-title" id={titleId}>{title}</div>
        {description && <div className="st-row-desc" id={descriptionId}>{description}</div>}
      </div>
      {children}
    </div>
  )
}

interface SettingSwitchProps {
  title: string
  description?: ReactNode
  on: boolean
  onToggle: () => void
  nested?: boolean
  /** Inert but still visible — the precondition for turning it on is not met yet. */
  disabled?: boolean
  /** Sits to the left of the switch, for example a permission button. */
  aside?: ReactNode
}

/** A switch row. The title names the switch and the help text describes it. */
export function SettingSwitch({ title, description, on, onToggle, nested, disabled = false, aside }: SettingSwitchProps) {
  const id = useId()
  return (
    <SettingRow title={title} description={description} nested={nested} titleId={`${id}-title`} descriptionId={`${id}-desc`}>
      <div className="st-row-controls">
        {aside}
        <button
          type="button"
          role="switch"
          className="st-switch"
          aria-checked={on}
          aria-disabled={disabled}
          aria-labelledby={`${id}-title`}
          aria-describedby={description ? `${id}-desc` : undefined}
          data-state={on ? 'on' : 'off'}
          onClick={disabled ? undefined : onToggle}
        >
          <span className="st-switch-thumb" data-testid="toggle-knob" />
        </button>
      </div>
    </SettingRow>
  )
}

interface SelectOption<T> {
  value: T
  label: string
}

interface SettingSelectProps<T extends string | number | null> {
  label: string
  options: SelectOption<T>[]
  value: T
  onChange: (value: T) => void
  width?: number
  tone?: 'default' | 'active' | 'muted'
}

/** A native select drawn as the design's field with a chevron. Values round-trip through the option index so `null` works. */
export function SettingSelect<T extends string | number | null>({ label, options, value, onChange, width = 150, tone = 'default' }: SettingSelectProps<T>) {
  const index = Math.max(0, options.findIndex(option => Object.is(option.value, value)))
  return (
    <span className="st-select" data-tone={tone} style={{ width }}>
      <select aria-label={label} value={index} onChange={event => onChange(options[Number(event.target.value)].value)}>
        {options.map((option, i) => (
          <option key={option.label} value={i}>{option.label}</option>
        ))}
      </select>
      <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

interface SegmentedProps<T> {
  label: string
  options: SelectOption<T>[]
  value: T
  onChange: (value: T) => void
}

/** One-of-N picker with radio semantics, drawn as the design's segmented track. */
export function Segmented<T>({ label, options, value, onChange }: SegmentedProps<T>) {
  return (
    <div role="radiogroup" aria-label={label} className="st-seg">
      {options.map(option => {
        const selected = Object.is(option.value, value)
        return (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={selected}
            data-selected={selected ? 'true' : undefined}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export function SettingsHeading({ title, lede }: { title: string; lede?: ReactNode }) {
  return (
    <header className="st-head">
      <h1 className="st-title">{title}</h1>
      {lede && <div className="st-lede">{lede}</div>}
    </header>
  )
}
