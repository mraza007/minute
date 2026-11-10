import { SETTINGS_SECTIONS, type SettingsSectionId } from './sections'
import './settings.css'

interface SettingsNavProps {
  section: SettingsSectionId
  onSelect: (section: SettingsSectionId) => void
  onBack: () => void
  /** The elapsed time of a recording that is still running, or `null`. A running recording keeps a way back to it here. */
  recordingTime?: string | null
  onReturnToRecording?: () => void
}

/** The sidebar while Settings is open: a way back to the notes, then the seven sections. */
export function SettingsNav({ section, onSelect, onBack, recordingTime = null, onReturnToRecording }: SettingsNavProps) {
  return (
    <nav aria-label="Settings sections" className="library-sidebar settings-nav">
      <div className="sidebar-top" data-tauri-drag-region="" />
      <button type="button" className="settings-back" aria-label="Back to notes" onClick={onBack}>
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Notes
      </button>
      {recordingTime !== null && (
        <div className="settings-nav-rec">
          <button type="button" className="sidebar-record" data-recording="true" aria-label="Return to recording" onClick={onReturnToRecording}>
            <span className="sidebar-record-lead">
              <span className="sidebar-record-dot blink-dot" />
              <span>Recording</span>
            </span>
            <span className="sidebar-record-time">{recordingTime}</span>
          </button>
        </div>
      )}
      <ul className="settings-nav-list">
        {SETTINGS_SECTIONS.map(item => (
          <li key={item.id}>
            <button
              type="button"
              className="settings-nav-item"
              aria-current={item.id === section ? 'page' : undefined}
              onClick={() => onSelect(item.id)}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
