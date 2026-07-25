import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { ModelStatus, StorageStats } from '../ipc/types'
import { formatBytes, modelStatusToSttInfo, type DownloadProgressState } from '../state/adapters'
import { DownloadProgressBar } from './DownloadProgressBar'
import { Toggle } from './Toggle'

const REMOVE_CONFIRM_TIMEOUT_MS = 4000

export interface SettingsViewProps {
  models: ModelStatus[]
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
}

const cardStyle: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border-soft)',
  borderRadius: 'var(--radius-md)',
  boxShadow: '0 1px 3px rgba(0,0,0,.04)',
  overflow: 'hidden',
}

const cardHeaderStyle: CSSProperties = {
  margin: 0,
  padding: '16px 20px 4px',
  fontWeight: 700,
  fontSize: 14,
}

const secondaryBtnStyle: CSSProperties = {
  flex: 'none',
  padding: '6px 12px',
  border: '1px solid var(--border-strong)',
  borderRadius: 999,
  background: 'var(--card)',
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--ink)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const dangerBtnStyle: CSSProperties = {
  ...secondaryBtnStyle,
  border: '1px solid rgba(var(--accent-rgb), .35)',
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
function SelectableModelRow({ entry, downloads, selected, onSelect, roving, downloadModel, cancelDownload, deleteModel }: SelectableModelRowProps) {
  const info = modelStatusToSttInfo(entry, selected ? entry.id : '', downloads)
  const progress = downloads[entry.id]
  // Only an installed model can actually be selected as the in-use STT
  // model — a not-yet-downloaded or still-downloading row shows its state
  // but the radio itself is inert until the download finishes (the
  // Download/Cancel button, unaffected by this, is how you act on it).
  const selectable = info.state === 'installed'

  return (
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
      className="model-card"
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        width: '100%',
        boxSizing: 'border-box',
        border: selected ? '1.5px solid var(--accent)' : '1px solid var(--border)',
        background: selected ? 'var(--selected-tint)' : 'var(--card)',
        borderRadius: 'var(--radius-md)',
        padding: selected ? '11.5px 13.5px' : '12px 14px',
        cursor: selectable ? 'pointer' : 'default',
        fontSize: 13,
        lineHeight: 1.5,
        transition: 'border-color .15s, background .15s',
        fontFamily: 'inherit',
        textAlign: 'left',
        color: 'inherit',
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          flex: 'none',
          marginTop: 2,
          borderRadius: '50%',
          boxSizing: 'border-box',
          background: 'var(--card)',
          border: selected ? '5px solid var(--accent)' : '1.5px solid var(--control-border)',
          transition: 'border .15s',
        }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        <b>{info.displayName}</b> — {info.desc}
        <br />
        <span style={{ fontSize: 12, color: selected ? 'var(--accent-text)' : 'var(--ink-faint)', fontWeight: selected ? 600 : 400 }}>{info.sub}</span>
        {info.state === 'downloading' && progress && <DownloadProgressBar downloaded={progress.downloaded} total={progress.total} />}
      </span>
      <span style={{ flex: 'none' }}>
        <ModelSecondaryAction entry={entry} downloads={downloads} downloadModel={downloadModel} cancelDownload={cancelDownload} deleteModel={deleteModel} />
      </span>
    </div>
  )
}

export function SettingsView({
  models,
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
    <main style={{ flex: 1, overflow: 'auto', background: 'var(--surface-soft)' }}>
      <div style={{ maxWidth: 760, padding: '28px 36px 40px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <h1 style={{ margin: 0, fontWeight: 700, fontSize: 21, letterSpacing: '-.02em' }}>Settings</h1>

        <div style={{ background: 'var(--banner-bg)', color: 'var(--banner-text)', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-lg)', padding: '24px 28px', boxShadow: '0 2px 8px rgba(0,0,0,.15)' }}>
          <div style={{ fontWeight: 700, fontSize: 17, letterSpacing: '-.02em' }}>Nothing leaves this machine.</div>
          <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.6, color: 'var(--banner-text-muted)', maxWidth: 520 }}>
            No account. No cloud. No network permission. Transcription and summarization run entirely on your hardware — pull the Wi-Fi and everything still works.
          </div>
        </div>

        <div style={cardStyle}>
          <h2 style={cardHeaderStyle}>Transcription model</h2>
          <div
            ref={sttGroupRef}
            role="radiogroup"
            aria-label="Transcription model"
            onKeyDown={e => handleRadiogroupKeyDown(e, selectableSttIds, setSttModel, sttGroupRef.current)}
            style={{ padding: '12px 20px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            {sttModels.map(m => (
              <SelectableModelRow
                key={m.id}
                entry={m}
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
        </div>

        <div style={cardStyle}>
          <h2 style={cardHeaderStyle}>Summary model</h2>
          <div style={{ padding: '4px 20px 4px', fontSize: 12, color: 'var(--ink-faint)' }}>Powers summaries, decisions & action items.</div>
          <div
            ref={llmGroupRef}
            role="radiogroup"
            aria-label="Summary model"
            onKeyDown={e => handleRadiogroupKeyDown(e, selectableLlmIds, setLlmModel, llmGroupRef.current)}
            style={{ padding: '8px 20px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            {llmModels.map(m => (
              <SelectableModelRow
                key={m.id}
                entry={m}
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
        </div>

        <div style={cardStyle}>
          <h2 style={cardHeaderStyle}>Storage</h2>
          <div style={{ padding: '12px 20px 18px' }}>
            <div style={{ display: 'flex', height: 12, borderRadius: 999, overflow: 'hidden', background: 'var(--panel-warm)', maxWidth: 520 }}>
              <div style={{ width: `${pct(modelsBytes)}%`, background: 'var(--ink)' }} />
              <div style={{ width: `${pct(audioBytes)}%`, background: 'var(--accent)' }} />
              <div style={{ width: `${pct(notesBytes)}%`, background: 'var(--ink-faint)' }} />
            </div>
            <div style={{ display: 'flex', gap: 18, marginTop: 8, fontSize: 12, color: 'var(--ink-muted)', flexWrap: 'wrap' }}>
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
            <div style={{ marginTop: 16 }}>
              <Toggle on={tDel} onToggle={toggleDel} label="Delete original audio 30 days after transcription" />
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--ink-faint)' }}>
              Your library inherits FileVault full-disk encryption.
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
