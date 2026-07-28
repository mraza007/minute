import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import type { Hardware, ModelStatus, Recommendation, StorageStats, SysAudioAvailability } from '../ipc/types'
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
  noteCount: number
  tDel: boolean
  toggleDel: () => void
  meetingDetection: boolean
  toggleMeetingDetection: () => void
  /** Stage 5 Task 5: the "Capture system audio" default for the *next* recording — see the "Recording" card below. */
  captureSystemAudio: boolean
  toggleCaptureSystemAudio: () => void
  /** Screen Recording permission/macOS-version gate for the toggle above — see `sysAudioStatus`'s docs for what each state means. */
  sysAudioAvailability: SysAudioAvailability
  onRequestSysAudioPermission: () => void
  onExportDiagnostics: () => Promise<void>
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
        <h2 className="mlab" style={{ margin: 0 }}>
          {title}
        </h2>
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
  noteCount,
  tDel,
  toggleDel,
  meetingDetection,
  toggleMeetingDetection,
  captureSystemAudio,
  toggleCaptureSystemAudio,
  sysAudioAvailability,
  onRequestSysAudioPermission,
  onExportDiagnostics,
}: SettingsViewProps) {
  const sttModels = models.filter(m => m.kind === 'stt')
  const llmModels = models.filter(m => m.kind === 'llm')

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
  const totalBytes = modelsBytes + audioBytes + notesBytes
  const pct = (n: number) => (totalBytes > 0 ? (n / totalBytes) * 100 : 0)

  return (
    <main style={{ flex: 1, minWidth: 0, overflow: 'auto', background: 'var(--panel)' }}>
      <div style={{ maxWidth: 720, padding: '30px 34px 48px' }}>
        <h1 style={{ margin: '0 0 28px', fontFamily: 'var(--serif)', fontWeight: 400, fontSize: 28, lineHeight: 1.14, letterSpacing: '-.014em' }}>
          Settings
        </h1>

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

        <Section title="Meeting detection">
          <Toggle on={meetingDetection} onToggle={toggleMeetingDetection} label="Offer to record when a meeting starts" />
          <div style={noteTextStyle}>
            When another app starts using the microphone, Minute shows a small prompt. Detection is fully local and never listens to audio.
          </div>
          <div style={fineTextStyle}>Zoom, Teams, Webex, Slack, FaceTime, Discord, and browser calls.</div>
        </Section>

        {/*
          Placement decision (Stage 5 Task 5): its own "Recording" section,
          not folded into "Meeting detection" above — system audio applies
          to every recording (manually started or popup-triggered), not
          just meeting-detected ones, so nesting it under that section would
          misleadingly imply a dependency between the two features that
          doesn't exist. A dedicated section also leaves room for future
          recording-only settings without overloading either existing
          one's scope.
        */}
        <Section title="Recording">
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

        <Section title="Storage">
          {/* Square-cut, flush to the measure — a printed bar chart rather
              than a rounded progress pill. */}
          <div style={{ display: 'flex', height: 10, overflow: 'hidden', background: 'var(--control-track)', maxWidth: 520 }}>
            <div style={{ width: `${pct(modelsBytes)}%`, background: 'var(--ink)' }} />
            <div style={{ width: `${pct(audioBytes)}%`, background: 'var(--accent)' }} />
            <div style={{ width: `${pct(notesBytes)}%`, background: 'var(--ink-faint)' }} />
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
          <div style={noteTextStyle}>Your library inherits FileVault full-disk encryption.</div>
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
      </div>
    </main>
  )
}
