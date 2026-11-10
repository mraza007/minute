import { SettingSwitch, SettingsHeading } from './controls'

export interface AboutSectionProps {
  appVersion: string
  autoUpdateCheck: boolean
  toggleAutoUpdateCheck: () => void
  updateAvailable: { version: string } | null
  updateInstalling: boolean
  updateCheckStatus: 'idle' | 'checking' | 'upToDate' | 'error'
  onCheckForUpdates: () => void
  onInstallUpdate: () => void
}

/** Every shortcut the app handles today. */
const KEYBOARD_SHORTCUTS = [
  { label: 'Search notes and transcripts', keys: '⌘K or ⌘F' },
  { label: 'Show this list', keys: '⌘/' },
  { label: 'Pause or resume a recording', keys: 'Space' },
  { label: 'Add a marker while recording', keys: '⌘⇧M' },
  { label: 'Stop and transcribe', keys: '⌘↵' },
  { label: 'Previous or next transcript turn', keys: '↑ ↓' },
  { label: 'Close a sheet', keys: 'Esc' },
] as const

function Check() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function AboutSection({
  appVersion,
  autoUpdateCheck,
  toggleAutoUpdateCheck,
  updateAvailable,
  updateInstalling,
  updateCheckStatus,
  onCheckForUpdates,
  onInstallUpdate,
}: AboutSectionProps) {
  return (
    <div className="st-content">
      <SettingsHeading
        title={`Minute ${appVersion || '—'}`}
        lede="Audio, transcripts, and summaries stay on this Mac. Minute uses the network only to download models and to check for updates."
      />

      <div className="st-group">
        <SettingSwitch
          title="Check for updates automatically"
          description="One request to GitHub at launch and every few hours. It sends nothing about you or your notes. Updates install only when you click."
          on={autoUpdateCheck}
          onToggle={toggleAutoUpdateCheck}
        />
        <div className="st-status-row">
          <div className="st-status" data-tone={updateCheckStatus === 'upToDate' && !updateAvailable ? 'ok' : undefined} role="status">
            {updateCheckStatus === 'upToDate' && !updateAvailable && (
              <>
                <Check />
                <span>You’re on the latest version.</span>
              </>
            )}
            {updateCheckStatus === 'error' && <span>Couldn’t reach GitHub — try again later.</span>}
            {updateAvailable && <span>Minute {updateAvailable.version} is ready to install.</span>}
          </div>
          {updateAvailable ? (
            <button type="button" className="st-btn" data-variant="primary" disabled={updateInstalling} onClick={onInstallUpdate}>
              {updateInstalling ? 'Installing…' : `Update to ${updateAvailable.version} & restart`}
            </button>
          ) : (
            <button type="button" className="st-btn" disabled={updateCheckStatus === 'checking'} onClick={onCheckForUpdates}>
              {updateCheckStatus === 'checking' ? 'Checking…' : 'Check now'}
            </button>
          )}
        </div>
      </div>

      <div className="st-list">
        <h2 className="st-label st-list-title">Keyboard shortcuts</h2>
        <ul className="st-bare-list" aria-label="Keyboard shortcuts">
          {KEYBOARD_SHORTCUTS.map(shortcut => (
            <li key={shortcut.label} className="st-key-line">
              <span>{shortcut.label}</span>
              <kbd>{shortcut.keys}</kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
