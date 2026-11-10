import { MEETING_APPS, MEETING_POLICY_LABELS } from '../../ipc/meetingPolicy'
import type { MeetingApp, MeetingPolicies, MeetingPolicy, SysAudioAvailability } from '../../ipc/types'
import { SettingSelect, SettingSwitch, SettingsHeading } from './controls'

export interface RecordingSectionProps {
  meetingDetection: boolean
  toggleMeetingDetection: () => void
  meetingPolicies: MeetingPolicies
  onSetMeetingPolicy: (app: MeetingApp, policy: MeetingPolicy) => void
  /** The "Capture system audio" default for the next recording. */
  captureSystemAudio: boolean
  toggleCaptureSystemAudio: () => void
  /** Screen Recording permission and macOS version gate for the switch above. */
  sysAudioAvailability: SysAudioAvailability
  onRequestSysAudioPermission: () => void
  /** Auto-stop (issue #9): stop and transcribe after a long silence. */
  autoStopRecording: boolean
  toggleAutoStopRecording: () => void
}

const POLICY_OPTIONS = (Object.keys(MEETING_POLICY_LABELS) as MeetingPolicy[]).map(policy => ({
  value: policy,
  label: MEETING_POLICY_LABELS[policy],
}))

const POLICY_TONE = { ask: 'default', record: 'active', ignore: 'muted' } as const

export function RecordingSection({
  meetingDetection,
  toggleMeetingDetection,
  meetingPolicies,
  onSetMeetingPolicy,
  captureSystemAudio,
  toggleCaptureSystemAudio,
  sysAudioAvailability,
  onRequestSysAudioPermission,
  autoStopRecording,
  toggleAutoStopRecording,
}: RecordingSectionProps) {
  return (
    <div className="st-content">
      <SettingsHeading title="Recording" />

      <div className="st-list">
        <div className="st-policy-switch">
          <SettingSwitch
            title="Detect meetings"
            description="Minute checks which apps use the microphone. It never listens to audio to do this."
            on={meetingDetection}
            onToggle={toggleMeetingDetection}
          />
        </div>
        {meetingDetection && (
          <>
            <div className="st-line st-policy-head">When a meeting starts in</div>
            {MEETING_APPS.map(app => {
              const policy = meetingPolicies[app.id]
              return (
                <div key={app.id} className="st-line st-policy-line">
                  <span className="st-line-name">{app.label}</span>
                  <SettingSelect
                    label={`When a meeting starts in ${app.label}`}
                    options={POLICY_OPTIONS}
                    value={policy}
                    onChange={next => onSetMeetingPolicy(app.id, next)}
                    width={196}
                    tone={POLICY_TONE[policy]}
                  />
                </div>
              )
            })}
          </>
        )}
      </div>

      <div className="st-group">
        <SettingSwitch
          title="Capture system audio"
          description="Records the other people on a call. Needs Screen Recording permission."
          on={captureSystemAudio}
          onToggle={toggleCaptureSystemAudio}
          disabled={sysAudioAvailability !== 'ready'}
          aside={
            sysAudioAvailability === 'notGranted' ? (
              <button type="button" className="st-btn" onClick={onRequestSysAudioPermission}>
                Grant permission…
              </button>
            ) : undefined
          }
        />
        {sysAudioAvailability === 'unsupported' && <p className="st-help st-help-tight">Requires macOS 13 or later.</p>}
        {sysAudioAvailability === 'notGranted' && (
          <p className="st-help st-help-tight">A freshly granted permission may need Minute to restart before it takes effect.</p>
        )}
        <SettingSwitch
          title="Stop when the meeting ends"
          description="After 2 quiet minutes Minute warns you, then stops and transcribes. A goodbye shortens the wait to 1 minute. New speech keeps it going."
          on={autoStopRecording}
          onToggle={toggleAutoStopRecording}
        />
      </div>
    </div>
  )
}
