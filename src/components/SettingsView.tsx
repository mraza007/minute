import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import type { Hardware, ModelStatus, Recommendation, StorageStats, SummaryStyle, SysAudioAvailability, VoiceProfile } from '../ipc/types'
import { formatBytes, modelStatusToSttInfo, type DownloadProgressState } from '../state/adapters'
import { DownloadProgressBar } from './DownloadProgressBar'
import { assessModelSuitability } from '../state/modelSuitability'
import { HardwareSummary, ModelSuitabilityLine } from './ModelSuitability'
import { Toggle } from './Toggle'

const REMOVE_CONFIRM_TIMEOUT_MS = 4000

export interface SettingsViewProps {
  models: ModelStatus[]
  hardware: Hardware | null
  recommendation: Recommendation | null
  downloads: Record<string, DownloadProgressState>
  sttModel: string
  setSttModel: (id: string) => void
  llmModel: string | null
  setLlmModel: (id: string) => void
  downloadModel: (id: string) => void
  cancelDownload: (id: string) => void
  deleteModel: (id: string) => void
  storage: StorageStats | null
  /** Where the notes library currently lives, home-abbreviated (`library_info.displayPath`) — `null` until loaded. */
  libraryPath: string | null
  /** Full absolute library path for the row's hover tooltip — `null` until loaded. */
  libraryTitle: string | null
  /** True while a library move is in flight — disables the Change… button. */
  movingLibrary: boolean
  /** Opens the native folder picker, then moves the library — see `useAppState.changeLibraryFolder`. */
  onChangeLibraryFolder: () => Promise<void>
  noteCount: number
  tDel: boolean
  toggleDel: () => void
  /** Issue #16: days after which older recordings' audio.wav gets compressed to AAC (.m4a); `null` = off. */
  compressAudioAfterDays: number | null
  setCompressAudioAfterDays: (days: number | null) => void
  meetingDetection: boolean
  toggleMeetingDetection: () => void
  /** Stage 5 Task 5: the "Capture system audio" default for the *next* recording — see the "Recording" card below. */
  captureSystemAudio: boolean
  toggleCaptureSystemAudio: () => void
  /** Screen Recording permission/macOS-version gate for the toggle above — see `sysAudioStatus`'s docs for what each state means. */
  sysAudioAvailability: SysAudioAvailability
  onRequestSysAudioPermission: () => void
  /** "Detect speakers" — the local diarization pass after each recording (issue #6's speaker half). */
  detectSpeakers: boolean
  /** Also downloads the two diarization models on enable — see `useAppState.toggleDetectSpeakers`. */
  toggleDetectSpeakers: () => void
  /** Auto-stop (issue #9): stop & transcribe after prolonged silence (on by default). */
  autoStopRecording: boolean
  toggleAutoStopRecording: () => void
  /** Issue #22: remember named speakers' voices and suggest names on later recordings (opt-in). */
  speakerProfiles: boolean
  toggleSpeakerProfiles: () => void
  /** Saved voice profiles, shown (with delete) while the toggle above is on. */
  voiceProfiles: VoiceProfile[]
  onDeleteVoiceProfile: (name: string) => void
  onExportDiagnostics: () => Promise<void>
  /** Settings' summary style — adjusts prompt guidance and response length backend-side. */
  summaryStyle: SummaryStyle
  setSummaryStyle: (style: SummaryStyle) => void
  /** Summarizer context-window override in tokens; `null` = automatic (RAM-tiered). */
  llmContextTokens: number | null
  setLlmContextTokens: (tokens: number | null) => void
  /** Free-text instructions appended to the summary prompt; committed via the section's Save button. */
  summaryInstructions: string
  setSummaryInstructions: (text: string) => void
  /** Auto-update (issue #4) — see useAppState's update-check machinery for all of these. */
  appVersion: string
  autoUpdateCheck: boolean
  toggleAutoUpdateCheck: () => void
  updateAvailable: { version: string } | null
  updateInstalling: boolean
  updateCheckStatus: 'idle' | 'checking' | 'upToDate' | 'error'
  onCheckForUpdates: () => void
  onInstallUpdate: () => void
}

/**
 * A settings section, set the same way the AI-notes leaf sets its sections:
 * a micro label with a hairline running out to the column edge. Settings
 * used to be a column of raised, shadowed cards — the same widget-stack
 * pattern the notes rail had, and equally at odds with a page that's meant
 * to read as paper. The rule divides; nothing needs to be raised.
 */
function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 34 }}>
      <div className="sec-head" style={{ marginBottom: hint ? 7 : 14 }}>
        <h3 className="mlab" style={{ margin: 0 }}>
          {title}
        </h3>
      </div>
      {hint && (
        <p style={{ margin: '0 0 14px', fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink-muted)', lineHeight: 1.55 }}>
          {hint}
        </p>
      )}
      {children}
    </section>
  )
}

/**
 * A top-level settings group — the page's three chapters (Models,
 * Recording, Data), each holding the [`Section`]s that used to sit in one
 * flat run. A serif chapter heading over a full-strength rule; the sections
 * inside keep their micro-label + hairline treatment, so the hierarchy
 * reads like a printed document's chapters and subheads.
 */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} style={{ marginBottom: 46 }}>
      <h2
        style={{
          margin: '0 0 22px',
          fontFamily: 'var(--serif)',
          fontWeight: 400,
          fontSize: 19,
          lineHeight: 1.2,
          letterSpacing: '-.012em',
          paddingBottom: 8,
          borderBottom: '1px solid var(--ink)',
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  )
}

/**
 * A one-of-N picker rendered as a squared segmented control — radio
 * semantics (`radiogroup`/`radio` + `aria-checked`), paper styling (ink
 * fill for the selected segment, hairline separators). Generic over the
 * option value so the context-window picker can carry `number | null`.
 */
function SegmentedControl<T>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'inline-flex', border: '1px solid var(--rule)' }}>
      {options.map((option, i) => {
        const selected = Object.is(option.value, value)
        return (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            style={{
              padding: '5px 13px',
              fontSize: 12,
              fontFamily: 'inherit',
              letterSpacing: '.01em',
              border: 'none',
              borderLeft: i > 0 ? '1px solid var(--rule)' : 'none',
              background: selected ? 'var(--ink)' : 'transparent',
              color: selected ? 'var(--panel)' : 'var(--ink-muted)',
              cursor: 'pointer',
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** Label beside a segmented control — the row's left column. */
const pickerLabelStyle: CSSProperties = { fontSize: 12.5, fontWeight: 600, minWidth: 118 }

/** Every non-zero category keeps at least this share of the storage bar —
 *  see `storageBarSegments`. */
const MIN_STORAGE_SLICE_PCT = 1.5

/**
 * The storage bar's segments, as percentages that always sum to ≤ 100.
 * Proportional to bytes, except every non-zero category is floored at
 * [`MIN_STORAGE_SLICE_PCT`] (with the others scaled down to fit): true
 * proportions render audio/notes invisibly thin next to multi-GB models —
 * 3.2 GB of models vs 7 MB of audio is a 99.8%/0.2% split — and a bar that
 * looks single-colored reads as broken rather than as "models dominate".
 * Exported for tests.
 */
export function storageBarSegments(
  modelsBytes: number,
  audioBytes: number,
  notesBytes: number,
): { key: string; pct: number; color: string }[] {
  const total = modelsBytes + audioBytes + notesBytes
  const raw = [
    { key: 'models', bytes: modelsBytes, color: 'var(--ink)' },
    { key: 'audio', bytes: audioBytes, color: 'var(--accent)' },
    { key: 'notes', bytes: notesBytes, color: 'var(--ink-faint)' },
  ]
  if (total <= 0) return raw.map(({ key, color }) => ({ key, color, pct: 0 }))

  // Tiny-but-present categories are pinned at the floor; the remaining
  // width is split among the rest in proportion to their true sizes — so
  // the floor never gets scaled back under itself.
  const rawPct = (bytes: number) => (bytes / total) * 100
  const isFloored = (bytes: number) => bytes > 0 && rawPct(bytes) < MIN_STORAGE_SLICE_PCT
  const flooredTotal = raw.filter(s => isFloored(s.bytes)).length * MIN_STORAGE_SLICE_PCT
  const unflooredRawTotal = raw
    .filter(s => !isFloored(s.bytes))
    .reduce((acc, s) => acc + rawPct(s.bytes), 0)
  const scale = unflooredRawTotal > 0 ? (100 - flooredTotal) / unflooredRawTotal : 0

  return raw.map(({ key, color, bytes }) => ({
    key,
    color,
    pct: bytes <= 0 ? 0 : isFloored(bytes) ? MIN_STORAGE_SLICE_PCT : rawPct(bytes) * scale,
  }))
}

/** Body copy under a control — serif, because it's explanatory prose about
 *  what the setting does, not a UI label. */
const noteTextStyle: CSSProperties = {
  marginTop: 10,
  fontFamily: 'var(--serif)',
  fontSize: 12.8,
  lineHeight: 1.55,
  color: 'var(--ink-muted)',
}

const fineTextStyle: CSSProperties = {
  marginTop: 5,
  fontFamily: 'var(--serif)',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--ink-faint)',
}

const secondaryBtnStyle: CSSProperties = {
  flex: 'none',
  padding: '6px 12px',
  border: '1px solid var(--rule-strong)',
  borderRadius: 'var(--radius-sm)',
  background: 'transparent',
  fontFamily: 'var(--sans)',
  fontSize: 11.5,
  fontWeight: 600,
  color: 'var(--ink)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const dangerBtnStyle: CSSProperties = {
  ...secondaryBtnStyle,
  border: '1px solid rgba(var(--accent-rgb), .4)',
  color: 'var(--accent-text)',
}

interface ModelRowAction {
  entry: ModelStatus
  downloads: Record<string, DownloadProgressState>
  downloadModel: (id: string) => void
  cancelDownload: (id: string) => void
  deleteModel: (id: string) => void
}

function ModelSecondaryAction({ entry, downloads, downloadModel, cancelDownload, deleteModel }: ModelRowAction) {
  const info = modelStatusToSttInfo(entry, '', downloads)

  // Unstyled window.confirm() is off the table (per design conventions) —
  // this is the minimal in-place substitute: first click arms a 4s
  // confirmation window, second click (while armed) actually deletes.
  // Scoped per-row (own state), so it can't bleed into a different model's
  // button, and it auto-disarms if the user doesn't follow through.
  const [confirming, setConfirming] = useState(false)
  const confirmTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => clearTimeout(confirmTimeout.current), [])

  if (info.state === 'notInstalled') {
    return (
      <button
        className="btn-rec"
        onClick={e => {
          e.stopPropagation()
          downloadModel(entry.id)
        }}
        style={{ ...secondaryBtnStyle, border: 'none', background: 'var(--accent-solid)', color: 'var(--text-on-accent)' }}
      >
        Download ({formatBytes(entry.sizeBytes)})
      </button>
    )
  }
  if (info.state === 'downloading') {
    return (
      <button
        className="btn-light"
        onClick={e => {
          e.stopPropagation()
          cancelDownload(entry.id)
        }}
        style={secondaryBtnStyle}
      >
        Cancel
      </button>
    )
  }
  return (
    <>
      <button
        className="icon-btn-danger"
        onClick={e => {
          e.stopPropagation()
          if (!confirming) {
            setConfirming(true)
            confirmTimeout.current = setTimeout(() => setConfirming(false), REMOVE_CONFIRM_TIMEOUT_MS)
            return
          }
          clearTimeout(confirmTimeout.current)
          setConfirming(false)
          deleteModel(entry.id)
        }}
        style={dangerBtnStyle}
      >
        {confirming ? 'Confirm removal?' : 'Remove'}
      </button>
      <span role="status" className="visually-hidden">
        {confirming ? 'Press again to confirm removal' : ''}
      </span>
    </>
  )
}

interface SelectableModelRowProps extends ModelRowAction {
  hardware: Hardware | null
  recommendation: Recommendation | null
  selected: boolean
  onSelect: () => void
  /** True iff this is the single row that owns the radiogroup's tab stop right now (roving tabindex) — see `rovingSttId`/`rovingLlmId` in `SettingsView`. */
  roving: boolean
}

/**
 * One radio-style model row, shared by both the Transcription and Summary
 * model sections: a selected/installed model shows the filled radio dot and
 * "Installed · in use"; a not-yet-installed or still-downloading row shows
 * its Download/Cancel affordance but the radio itself stays inert (not
 * `selectable`) until the model actually finishes installing.
 */
function SelectableModelRow({
  entry,
  hardware,
  recommendation,
  downloads,
  selected,
  onSelect,
  roving,
  downloadModel,
  cancelDownload,
  deleteModel,
}: SelectableModelRowProps) {
  const info = modelStatusToSttInfo(entry, selected ? entry.id : '', downloads)
  const progress = downloads[entry.id]
  const suitability = assessModelSuitability(entry, hardware, recommendation)
  // Only an installed model can actually be selected as the in-use STT
  // model — a not-yet-downloaded or still-downloading row shows its state
  // but the radio itself is inert until the download finishes (the
  // Download/Cancel button, unaffected by this, is how you act on it).
  const selectable = info.state === 'installed'

  return (
    <div
      className="model-card"
      // A ruled row, selected by a margin marker — the same selection
      // language the sidebar and search palette use, rather than a card
      // that grows a coloured border.
      style={{
        display: 'flex',
        gap: 13,
        alignItems: 'flex-start',
        width: '100%',
        boxSizing: 'border-box',
        borderLeft: `2px solid ${selected ? 'var(--accent)' : 'transparent'}`,
        borderBottom: '1px solid var(--rule)',
        background: selected ? 'var(--selected-tint)' : 'transparent',
        padding: '13px 14px',
        lineHeight: 1.5,
        transition: 'background .15s',
        fontFamily: 'inherit',
        textAlign: 'left',
        color: 'inherit',
      }}
    >
      <div
        role="radio"
        aria-checked={selected}
        aria-disabled={!selectable}
        // Roving tabindex: only one selectable row is ever a Tab stop at a
        // time (the selected one, or the first selectable row if none is
        // selected yet) — Up/Down (handled by the radiogroup container) moves
        // both focus and selection among selectable rows, same as the native
        // <input type="radio"> group pattern.
        tabIndex={selectable ? (roving ? 0 : -1) : -1}
        data-model-id={entry.id}
        onClick={selectable ? onSelect : undefined}
        onKeyDown={
          selectable
            ? e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect()
                }
              }
            : undefined
        }
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 13,
          minWidth: 0,
          flex: 1,
          cursor: selectable ? 'pointer' : 'default',
        }}
      >
        <span
          style={{
            width: 15,
            height: 15,
            flex: 'none',
            marginTop: 3,
            borderRadius: '50%',
            boxSizing: 'border-box',
            background: 'transparent',
            border: selected ? '4.5px solid var(--accent)' : '1.5px solid var(--control-border)',
            transition: 'border .15s',
          }}
        />
        <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--serif)', fontSize: 13.5 }}>
          <b style={{ fontWeight: 700 }}>{info.displayName}</b> — {info.desc}
          <br />
          <span
            style={{
              fontFamily: 'var(--sans)',
              fontSize: 11,
              color: selected ? 'var(--accent-text)' : 'var(--ink-faint)',
              fontWeight: selected ? 600 : 400,
            }}
          >
            {info.sub}
          </span>
          <ModelSuitabilityLine result={suitability} />
          {info.state === 'downloading' && progress && <DownloadProgressBar downloaded={progress.downloaded} total={progress.total} />}
        </span>
      </div>
      <span style={{ flex: 'none' }}>
        <ModelSecondaryAction entry={entry} downloads={downloads} downloadModel={downloadModel} cancelDownload={cancelDownload} deleteModel={deleteModel} />
      </span>
    </div>
  )
}

export function SettingsView({
  models,
  hardware,
  recommendation,
  downloads,
  sttModel,
  setSttModel,
  llmModel,
  setLlmModel,
  downloadModel,
  cancelDownload,
  deleteModel,
  storage,
  libraryPath,
  libraryTitle,
  movingLibrary,
  onChangeLibraryFolder,
  noteCount,
  tDel,
  toggleDel,
  compressAudioAfterDays,
  setCompressAudioAfterDays,
  meetingDetection,
  toggleMeetingDetection,
  captureSystemAudio,
  toggleCaptureSystemAudio,
  sysAudioAvailability,
  onRequestSysAudioPermission,
  detectSpeakers,
  toggleDetectSpeakers,
  autoStopRecording,
  toggleAutoStopRecording,
  speakerProfiles,
  toggleSpeakerProfiles,
  voiceProfiles,
  onDeleteVoiceProfile,
  onExportDiagnostics,
  summaryStyle,
  setSummaryStyle,
  llmContextTokens,
  setLlmContextTokens,
  summaryInstructions,
  setSummaryInstructions,
  appVersion,
  autoUpdateCheck,
  toggleAutoUpdateCheck,
  updateAvailable,
  updateInstalling,
  updateCheckStatus,
  onCheckForUpdates,
  onInstallUpdate,
}: SettingsViewProps) {
  // Local draft for the custom-instructions textarea — committed by its
  // explicit Save button (not per keystroke, which would write
  // settings.json per character; not on blur, which saves invisibly).
  // Re-seeded if the persisted value changes underneath (e.g. initial load
  // finishing after this view mounted).
  const [instructionsDraft, setInstructionsDraft] = useState(summaryInstructions)
  useEffect(() => setInstructionsDraft(summaryInstructions), [summaryInstructions])
  const sttModels = models.filter(m => m.kind === 'stt')
  const llmModels = models.filter(m => m.kind === 'llm')
  // The diarization pair behind "Detect speakers" — never listed in the
  // model pickers above; the Speakers section drives their download and
  // reports their state instead.
  const diarModels = models.filter(m => m.kind === 'diarization')
  const diarModelsInstalled = diarModels.length > 0 && diarModels.every(m => m.state === 'installed')

  const sttGroupRef = useRef<HTMLDivElement>(null)
  const llmGroupRef = useRef<HTMLDivElement>(null)

  const selectableSttIds = sttModels.filter(m => modelStatusToSttInfo(m, '', downloads).state === 'installed').map(m => m.id)
  const selectableLlmIds = llmModels.filter(m => modelStatusToSttInfo(m, '', downloads).state === 'installed').map(m => m.id)
  // The roving tab stop: the selected row if it's actually selectable, else
  // the first selectable row, else nothing (no installed models yet).
  const rovingSttId = selectableSttIds.includes(sttModel) ? sttModel : selectableSttIds[0]
  const rovingLlmId = llmModel && selectableLlmIds.includes(llmModel) ? llmModel : selectableLlmIds[0]

  /** Shared Up/Down roving-focus handler for both model radiogroups — moves focus and selection together among selectable (installed) rows only, wrapping at the ends. */
  function handleRadiogroupKeyDown(e: KeyboardEvent<HTMLDivElement>, ids: string[], onSelect: (id: string) => void, groupEl: HTMLDivElement | null) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    if (ids.length === 0) return
    e.preventDefault()
    const currentId = (e.target as HTMLElement).getAttribute('data-model-id')
    const currentIndex = currentId ? ids.indexOf(currentId) : -1
    const delta = e.key === 'ArrowDown' ? 1 : -1
    const nextId = ids[(currentIndex + delta + ids.length) % ids.length]
    onSelect(nextId)
    groupEl?.querySelector<HTMLElement>(`[data-model-id="${nextId}"]`)?.focus()
  }

  const modelsBytes = storage?.modelsBytes ?? 0
  const audioBytes = storage?.audioBytes ?? 0
  const notesBytes = storage?.notesBytes ?? 0

  return (
    <main style={{ flex: 1, minWidth: 0, overflow: 'auto', background: 'var(--panel)' }}>
      <div style={{ maxWidth: 720, padding: '30px 34px 48px' }}>
        <h1 style={{ margin: '0 0 28px', fontFamily: 'var(--serif)', fontWeight: 400, fontSize: 28, lineHeight: 1.14, letterSpacing: '-.014em' }}>
          Settings
        </h1>

        <Group title="Models">
        <HardwareSummary hardware={hardware} />

        <Section title="Transcription model">
          <div
            ref={sttGroupRef}
            role="radiogroup"
            aria-label="Transcription model"
            onKeyDown={e => handleRadiogroupKeyDown(e, selectableSttIds, setSttModel, sttGroupRef.current)}
            style={{ borderTop: '1px solid var(--rule)' }}
          >
            {sttModels.map(m => (
              <SelectableModelRow
                key={m.id}
                entry={m}
                hardware={hardware}
                recommendation={recommendation}
                downloads={downloads}
                selected={sttModel === m.id}
                roving={m.id === rovingSttId}
                onSelect={() => setSttModel(m.id)}
                downloadModel={downloadModel}
                cancelDownload={cancelDownload}
                deleteModel={deleteModel}
              />
            ))}
          </div>
        </Section>

        <Section title="Summary model" hint="Powers summaries, decisions & action items.">
          <div
            ref={llmGroupRef}
            role="radiogroup"
            aria-label="Summary model"
            onKeyDown={e => handleRadiogroupKeyDown(e, selectableLlmIds, setLlmModel, llmGroupRef.current)}
            style={{ borderTop: '1px solid var(--rule)' }}
          >
            {llmModels.map(m => (
              <SelectableModelRow
                key={m.id}
                entry={m}
                hardware={hardware}
                recommendation={recommendation}
                downloads={downloads}
                selected={llmModel === m.id}
                roving={m.id === rovingLlmId}
                onSelect={() => setLlmModel(m.id)}
                downloadModel={downloadModel}
                cancelDownload={cancelDownload}
                deleteModel={deleteModel}
              />
            ))}
          </div>
        </Section>

        <Section title="Summary behavior" hint="Applies to the next summary you generate — Regenerate an existing note to restyle it.">
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={pickerLabelStyle}>Summary style</div>
            <SegmentedControl
              label="Summary style"
              value={summaryStyle}
              onChange={setSummaryStyle}
              options={[
                { value: 'short', label: 'Short' },
                { value: 'standard', label: 'Standard' },
                { value: 'detailed', label: 'Detailed' },
              ]}
            />
          </div>
          <div style={noteTextStyle}>
            Short keeps it to the essentials. Detailed adds a section-by-section breakdown of every
            topic discussed, alongside the usual decisions and follow-ups.
          </div>
          <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={pickerLabelStyle}>Context window</div>
            <SegmentedControl
              label="Context window"
              value={llmContextTokens}
              onChange={setLlmContextTokens}
              options={[
                { value: null, label: 'Auto' },
                { value: 8_192, label: '8k' },
                { value: 16_384, label: '16k' },
                { value: 32_768, label: '32k' },
              ]}
            />
          </div>
          <div style={noteTextStyle}>
            How much transcript the summarizer reads at once. Auto picks the largest window that fits this Mac’s
            memory; a larger window summarizes longer meetings whole but uses more memory while generating.
          </div>
          <div style={{ marginTop: 18, maxWidth: 520 }}>
            <label htmlFor="summary-custom-instructions" style={{ ...pickerLabelStyle, display: 'block', marginBottom: 8 }}>
              Custom instructions
            </label>
            <textarea
              id="summary-custom-instructions"
              value={instructionsDraft}
              maxLength={2000}
              rows={3}
              placeholder="e.g. Write the summary in German. Focus on engineering decisions and deadlines."
              onChange={e => setInstructionsDraft(e.target.value)}
              style={{
                width: '100%',
                resize: 'vertical',
                padding: '8px 10px',
                fontFamily: 'inherit',
                fontSize: 12.5,
                lineHeight: 1.5,
                color: 'var(--ink)',
                background: 'transparent',
                border: '1px solid var(--rule)',
              }}
            />
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                type="button"
                className="btn-light"
                style={{ ...secondaryBtnStyle, flex: 'none' }}
                disabled={instructionsDraft === summaryInstructions}
                onClick={() => setSummaryInstructions(instructionsDraft)}
              >
                Save
              </button>
              {instructionsDraft === summaryInstructions && summaryInstructions !== '' && (
                <span style={{ fontSize: 11.5, color: 'var(--ink-muted)' }}>Saved</span>
              )}
            </div>
          </div>
          <div style={noteTextStyle}>
            Added to the summarizer’s prompt — steer language, tone, or focus. The summary’s structure (overview,
            decisions, action items) always stays intact.
          </div>
        </Section>
        </Group>

        <Group title="Recording">
        <Section title="Meeting detection">
          <Toggle on={meetingDetection} onToggle={toggleMeetingDetection} label="Offer to record when a meeting starts" />
          <div style={noteTextStyle}>
            When another app starts using the microphone, Minute shows a small prompt. Detection is fully local and never listens to audio.
          </div>
          <div style={fineTextStyle}>Zoom, Teams, Webex, Slack, FaceTime, Discord, and browser calls.</div>
        </Section>

        {/*
          Placement decision (Stage 5 Task 5): its own section, not folded
          into "Meeting detection" above — system audio applies to every
          recording (manually started or popup-triggered), not just
          meeting-detected ones, so nesting it under that section would
          misleadingly imply a dependency between the two features that
          doesn't exist. (Titled "System audio" since the settings page
          gained its grouped chapters — the group itself is "Recording".)
        */}
        <Section title="System audio">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Toggle
              on={captureSystemAudio}
              onToggle={toggleCaptureSystemAudio}
              label="Capture system audio"
              disabled={sysAudioAvailability !== 'ready'}
            />
            {sysAudioAvailability === 'notGranted' && (
              <button className="btn-light" onClick={onRequestSysAudioPermission} style={{ ...secondaryBtnStyle, flex: 'none' }}>
                Grant permission…
              </button>
            )}
          </div>
          <div style={noteTextStyle}>
            Include what you hear — the other side of calls — in recordings and transcripts. Requires Screen Recording
            permission.
          </div>
          {sysAudioAvailability === 'unsupported' && <div style={fineTextStyle}>Requires macOS 13 or later.</div>}
          {sysAudioAvailability === 'notGranted' && (
            <div style={fineTextStyle}>A freshly granted permission may need Minute to restart before it takes effect.</div>
          )}
        </Section>

        <Section title="Auto-stop">
          <Toggle
            on={autoStopRecording}
            onToggle={toggleAutoStopRecording}
            label="Stop automatically when the meeting seems over"
          />
          <div style={noteTextStyle}>
            If nothing transcribable has been said for 3 minutes, Minute shows a warning with a 2-minute countdown,
            then stops and transcribes on its own. When the meeting ends with a goodbye, the warning appears after 1
            minute instead. New speech, or one click, keeps it going. Saves a forgotten recording from running
            overnight.
          </div>
        </Section>

        <Section title="Speakers">
          <Toggle on={detectSpeakers} onToggle={toggleDetectSpeakers} label="Detect speakers" />
          <div style={noteTextStyle}>
            After each recording, label who spoke when — turns get names like “Speaker 1” and “Speaker 2” you can
            rename or merge from the transcript. Runs entirely on this Mac using two small models (~34 MB), downloaded
            when you turn this on.
          </div>
          {diarModels.some(m => downloads[m.id]) && (
            <div style={{ marginTop: 4, maxWidth: 520 }}>
              {diarModels
                .filter(m => downloads[m.id])
                .map(m => (
                  <DownloadProgressBar key={m.id} downloaded={downloads[m.id].downloaded} total={downloads[m.id].total} />
                ))}
            </div>
          )}
          {detectSpeakers && !diarModelsInstalled && !diarModels.some(m => downloads[m.id]) && (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={fineTextStyle}>The speaker models aren’t downloaded yet.</span>
              <button
                type="button"
                className="btn-light"
                style={{ ...secondaryBtnStyle, flex: 'none' }}
                onClick={() => diarModels.filter(m => m.state !== 'installed').forEach(m => downloadModel(m.id))}
              >
                Download models
              </button>
            </div>
          )}
          {detectSpeakers && diarModelsInstalled && (
            <div style={fineTextStyle}>Speaker models installed. New recordings are labeled automatically.</div>
          )}
          {detectSpeakers && (
            <div style={{ marginTop: 14 }}>
              <Toggle
                on={speakerProfiles}
                onToggle={toggleSpeakerProfiles}
                label="Remember named speakers"
              />
              <div style={noteTextStyle}>
                When you rename a speaker, Minute saves that voice locally and suggests the name the next time it
                hears them. Voice profiles never leave this Mac, live in your library folder, and can be deleted
                below at any time.
              </div>
              {speakerProfiles && voiceProfiles.length > 0 && (
                <ul aria-label="Saved voice profiles" style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, maxWidth: 520 }}>
                  {voiceProfiles.map(profile => (
                    <li
                      key={profile.name}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--hairline)' }}
                    >
                      <span style={{ flex: 1 }}>{profile.name}</span>
                      <span style={fineTextStyle}>
                        {profile.samples === 1 ? 'heard once' : `heard ${profile.samples} times`}
                      </span>
                      <button
                        type="button"
                        className="btn-light"
                        style={{ ...secondaryBtnStyle, flex: 'none' }}
                        onClick={() => onDeleteVoiceProfile(profile.name)}
                      >
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {speakerProfiles && voiceProfiles.length === 0 && (
                <div style={fineTextStyle}>
                  No voices saved yet. Rename a speaker in any transcript to save the first one.
                </div>
              )}
            </div>
          )}
        </Section>
        </Group>

        <Group title="Data">
        <Section title="Storage">
          {/* Square-cut, flush to the measure — a printed bar chart rather
              than a rounded progress pill. True proportions would render
              audio/notes invisible next to multi-GB models (99.8% vs
              slivers thinner than a pixel), so every non-zero category
              gets a small minimum slice — see `storageBarSegments`. */}
          <div style={{ display: 'flex', height: 10, overflow: 'hidden', background: 'var(--control-track)', maxWidth: 520 }}>
            {storageBarSegments(modelsBytes, audioBytes, notesBytes).map((segment, i) => (
              <div
                key={segment.key}
                style={{
                  width: `${segment.pct}%`,
                  background: segment.color,
                  borderLeft: i > 0 && segment.pct > 0 ? '1px solid var(--panel)' : 'none',
                }}
              />
            ))}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 18,
              marginTop: 10,
              fontSize: 11.5,
              color: 'var(--ink-muted)',
              flexWrap: 'wrap',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <span>
              <b style={{ color: 'var(--ink)' }}>●</b> Models {formatBytes(modelsBytes)}
            </span>
            <span>
              <b style={{ color: 'var(--accent)' }}>●</b> Audio {formatBytes(audioBytes)}
            </span>
            <span>
              <b style={{ color: 'var(--ink-faint)' }}>●</b> Notes {formatBytes(notesBytes)}
            </span>
            <span>{noteCount} notes</span>
          </div>
          <div style={{ marginTop: 18 }}>
            <Toggle on={tDel} onToggle={toggleDel} label="Delete original audio 30 days after transcription" />
          </div>
          <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={pickerLabelStyle}>Compress audio to AAC after</div>
            <SegmentedControl
              label="Compress audio to AAC after"
              value={compressAudioAfterDays}
              onChange={setCompressAudioAfterDays}
              options={[
                { value: null, label: 'Off' },
                { value: 7, label: '7 days' },
                { value: 14, label: '14 days' },
                { value: 30, label: '30 days' },
              ]}
            />
          </div>
          <div style={noteTextStyle}>
            Converts older recordings to compact AAC (.m4a). Playback keeps working; the original WAV is removed.
          </div>
          <div style={{ marginTop: 18, display: 'flex', alignItems: 'baseline', gap: 12, maxWidth: 520 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>Library location</div>
              <div
                style={{ fontSize: 11.5, color: 'var(--ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={libraryTitle ?? undefined}
              >
                {libraryPath ?? '—'}
              </div>
            </div>
            <button
              type="button"
              className="btn-light"
              style={{ ...secondaryBtnStyle, flex: 'none' }}
              disabled={movingLibrary}
              onClick={() => void onChangeLibraryFolder()}
            >
              {movingLibrary ? 'Moving…' : 'Change…'}
            </button>
          </div>
          <div style={noteTextStyle}>
            Recordings, transcripts, and notes move to the folder you choose. Models stay in app data.
          </div>
          <div style={fineTextStyle}>Your library inherits FileVault full-disk encryption.</div>
        </Section>

        <Section title="Updates">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
              Minute {appVersion || '—'}
            </span>
            {updateAvailable ? (
              <button
                type="button"
                className="btn"
                style={{ flex: 'none' }}
                disabled={updateInstalling}
                onClick={onInstallUpdate}
              >
                {updateInstalling ? 'Installing…' : `Update to ${updateAvailable.version} & restart`}
              </button>
            ) : (
              <button
                type="button"
                className="btn-light"
                style={{ ...secondaryBtnStyle, flex: 'none' }}
                disabled={updateCheckStatus === 'checking'}
                onClick={onCheckForUpdates}
              >
                {updateCheckStatus === 'checking' ? 'Checking…' : 'Check now'}
              </button>
            )}
            {updateCheckStatus === 'upToDate' && !updateAvailable && (
              <span style={{ fontSize: 11.5, color: 'var(--ink-muted)' }}>You’re on the latest version.</span>
            )}
            {updateCheckStatus === 'error' && (
              <span style={{ fontSize: 11.5, color: 'var(--ink-muted)' }}>Couldn’t reach GitHub — try again later.</span>
            )}
          </div>
          <div style={{ marginTop: 14 }}>
            <Toggle on={autoUpdateCheck} onToggle={toggleAutoUpdateCheck} label="Check for updates automatically" />
          </div>
          <div style={noteTextStyle}>
            Checks GitHub for new Minute releases at launch and every few hours. Only release metadata is fetched —
            nothing about you or your notes is ever sent. Updates install only when you click.
          </div>
        </Section>

        <Section title="Diagnostics">
          <button type="button" className="btn-light" style={secondaryBtnStyle} onClick={() => void onExportDiagnostics()}>
            Export diagnostics
          </button>
          <div style={noteTextStyle}>
            Creates a local JSON report with app, platform, status counts, and storage totals for troubleshooting.
          </div>
          <div style={fineTextStyle}>
            Never includes note titles, transcript text, note identifiers, filenames, or filesystem paths.
          </div>
        </Section>
        </Group>
      </div>
    </main>
  )
}
