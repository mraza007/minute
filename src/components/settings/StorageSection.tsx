import type { StorageStats } from '../../ipc/types'
import { formatBytes } from '../../state/adapters'
import { SettingSelect, SettingSwitch, SettingsHeading, SettingRow } from './controls'
import { storageBarSegments } from './storageBar'

export interface StorageSectionProps {
  storage: StorageStats | null
  noteCount: number
  /** Where the notes library lives, with the home folder shortened. `null` until loaded. */
  libraryPath: string | null
  /** The full path, for the hover tooltip. */
  libraryTitle: string | null
  /** True while a library move is under way. */
  movingLibrary: boolean
  onChangeLibraryFolder: () => Promise<void>
  /** Delete the original audio 30 days after transcription. */
  tDel: boolean
  toggleDel: () => void
  /** Days after which older audio becomes AAC (.m4a). `null` means off. */
  compressAudioAfterDays: number | null
  setCompressAudioAfterDays: (days: number | null) => void
  onExportDiagnostics: () => Promise<void>
}

const COMPRESS_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'Off' },
  { value: 7, label: 'After 7 days' },
  { value: 14, label: 'After 14 days' },
  { value: 30, label: 'After 30 days' },
]

const LEGEND = [
  { key: 'audio', label: 'Audio', color: 'var(--accent)' },
  { key: 'models', label: 'Models', color: 'var(--speaker-3)' },
  { key: 'notes', label: 'Notes and transcripts', color: 'var(--ok-text)' },
] as const

export function StorageSection({
  storage,
  noteCount,
  libraryPath,
  libraryTitle,
  movingLibrary,
  onChangeLibraryFolder,
  tDel,
  toggleDel,
  compressAudioAfterDays,
  setCompressAudioAfterDays,
  onExportDiagnostics,
}: StorageSectionProps) {
  const modelsBytes = storage?.modelsBytes ?? 0
  const audioBytes = storage?.audioBytes ?? 0
  const notesBytes = storage?.notesBytes ?? 0
  const bytes = { audio: audioBytes, models: modelsBytes, notes: notesBytes }

  return (
    <div className="st-content">
      <SettingsHeading title="Storage" />

      <div className="st-field">
        <div className="st-usage-head">
          <h2 className="st-label st-tabular">{formatBytes(modelsBytes + audioBytes + notesBytes)} on this Mac</h2>
          <span className="st-list-meta">{noteCount} notes</span>
        </div>
        <div className="st-usage" aria-hidden="true">
          {storageBarSegments(modelsBytes, audioBytes, notesBytes)
            .filter(segment => segment.pct > 0)
            .map(segment => (
              <span key={segment.key} style={{ flex: `${segment.pct} 1 0`, background: segment.color }} />
            ))}
        </div>
        <ul className="st-legend st-tabular">
          {LEGEND.map(item => (
            <li key={item.key}>
              <i style={{ background: item.color }} />
              {item.label} {formatBytes(bytes[item.key])}
            </li>
          ))}
        </ul>
      </div>

      <div className="st-group" data-ruled="true">
        <SettingRow title="Compress older audio" description="Converts WAV to AAC (.m4a). Playback and timestamps keep working. The original WAV is removed.">
          <SettingSelect
            label="Compress older audio"
            options={COMPRESS_OPTIONS}
            value={compressAudioAfterDays}
            onChange={setCompressAudioAfterDays}
            width={150}
          />
        </SettingRow>
        <SettingSwitch
          title="Delete audio after 30 days"
          description="Notes and transcripts stay. You cannot play or re-transcribe a note without its audio."
          on={tDel}
          onToggle={toggleDel}
        />
      </div>

      <div className="st-list">
        <div className="st-line st-library-line" data-tall="true">
          <div className="st-row-text st-library-text">
            <div className="st-row-title">Library location</div>
            <div className="st-row-desc st-library-path" title={libraryTitle ?? undefined}>{libraryPath ?? '—'}</div>
            <div className="st-row-desc">Recordings, transcripts, and notes move to the folder you choose. Models stay in app data. Your library inherits FileVault full-disk encryption.</div>
          </div>
          <button type="button" className="st-btn" disabled={movingLibrary} onClick={() => void onChangeLibraryFolder()}>
            {movingLibrary ? 'Moving…' : 'Change…'}
          </button>
        </div>
        <div className="st-line st-library-line" data-tall="true">
          <div className="st-row-text st-library-text">
            <div className="st-row-title">Diagnostics</div>
            <div className="st-row-desc">
              A local report for bug reports. It never includes note titles, transcript text, note identifiers, filenames, or filesystem paths.
            </div>
          </div>
          <button type="button" className="st-btn" aria-label="Export diagnostics" onClick={() => void onExportDiagnostics()}>
            Export…
          </button>
        </div>
      </div>
    </div>
  )
}
