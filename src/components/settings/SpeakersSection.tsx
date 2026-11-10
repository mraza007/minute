import type { ModelStatus, VoiceProfile } from '../../ipc/types'
import type { DownloadProgressState } from '../../state/adapters'
import { DownloadProgressBar } from '../DownloadProgressBar'
import { SettingSwitch, SettingsHeading } from './controls'

export interface SpeakersSectionProps {
  models: ModelStatus[]
  downloads: Record<string, DownloadProgressState>
  downloadModel: (id: string) => void
  /** The local diarization pass after each recording. */
  detectSpeakers: boolean
  /** Also downloads the two diarization models when turned on. */
  toggleDetectSpeakers: () => void
  /** Issue #22: remember named speakers' voices and suggest names later. */
  speakerProfiles: boolean
  toggleSpeakerProfiles: () => void
  /** Issue #32: write confident voice matches into the transcript on its own. */
  autoApplySpeakerNames: boolean
  toggleAutoApplySpeakerNames: () => void
  voiceProfiles: VoiceProfile[]
  onDeleteVoiceProfile: (name: string) => void
}

export function SpeakersSection({
  models,
  downloads,
  downloadModel,
  detectSpeakers,
  toggleDetectSpeakers,
  speakerProfiles,
  toggleSpeakerProfiles,
  autoApplySpeakerNames,
  toggleAutoApplySpeakerNames,
  voiceProfiles,
  onDeleteVoiceProfile,
}: SpeakersSectionProps) {
  // The diarization pair never appears in the model lists. This section
  // starts its download and reports its state.
  const diarModels = models.filter(m => m.kind === 'diarization')
  const diarInstalled = diarModels.length > 0 && diarModels.every(m => m.state === 'installed')
  const diarDownloading = diarModels.filter(m => downloads[m.id])

  return (
    <div className="st-content">
      <SettingsHeading title="Speakers" />

      <div className="st-group">
        <SettingSwitch
          title="Detect speakers"
          description="Labels each turn as Speaker 1, Speaker 2, and so on. Runs on this Mac with two small models (about 34 MB) that download when you turn this on."
          on={detectSpeakers}
          onToggle={toggleDetectSpeakers}
        />
        {diarDownloading.map(m => (
          <DownloadProgressBar key={m.id} downloaded={downloads[m.id].downloaded} total={downloads[m.id].total} />
        ))}
        {detectSpeakers && !diarInstalled && diarDownloading.length === 0 && (
          <div className="st-actions">
            <span className="st-help">The speaker models aren’t downloaded yet.</span>
            <button
              type="button"
              className="st-btn"
              onClick={() => diarModels.filter(m => m.state !== 'installed').forEach(m => downloadModel(m.id))}
            >
              Download models
            </button>
          </div>
        )}
        {detectSpeakers && diarInstalled && <p className="st-help" data-tone="ok">Speaker models installed. New recordings are labeled automatically.</p>}

        {detectSpeakers && (
          <SettingSwitch
            title="Remember named speakers"
            description="When you rename a speaker, Minute saves that voice on this Mac. Voices never leave it."
            on={speakerProfiles}
            onToggle={toggleSpeakerProfiles}
          />
        )}
        {detectSpeakers && speakerProfiles && (
          <SettingSwitch
            title="Use remembered names automatically"
            description="On: a clear match is written in before the summary runs, with an Undo. Off: Minute suggests the name and you confirm it."
            on={autoApplySpeakerNames}
            onToggle={toggleAutoApplySpeakerNames}
            nested
          />
        )}
      </div>

      {detectSpeakers && speakerProfiles && (
        <div className="st-list">
          <div className="st-list-head">
            <h2 className="st-label">Remembered voices</h2>
            {voiceProfiles.length > 0 && (
              <span className="st-list-meta">
                {voiceProfiles.length === 1 ? '1 voice' : `${voiceProfiles.length} voices`} · stored on this Mac
              </span>
            )}
          </div>
          {voiceProfiles.length > 0 ? (
            <ul aria-label="Saved voice profiles" className="st-list st-bare-list">
              {voiceProfiles.map((profile, i) => (
                <li key={profile.name} className="st-line st-voice-line">
                  <span className="st-voice-dot" style={{ background: `var(--speaker-${((i + 1) % 6) + 1})` }} aria-hidden="true" />
                  <span className="st-line-name">{profile.name}</span>
                  <span className="st-voice-times">{profile.samples === 1 ? 'heard once' : `heard ${profile.samples} times`}</span>
                  <span className="st-voice-action">
                    <button
                      type="button"
                      className="st-link"
                      data-tone="danger"
                      aria-label={`Forget ${profile.name}`}
                      onClick={() => onDeleteVoiceProfile(profile.name)}
                    >
                      Forget
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="st-help">No voices saved yet. Rename a speaker in any transcript to save the first one.</p>
          )}
        </div>
      )}
    </div>
  )
}
