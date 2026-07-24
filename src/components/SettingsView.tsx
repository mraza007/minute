import { useEffect, useRef, useState, type CSSProperties } from 'react'
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
  tEnc: boolean
  toggleEnc: () => void
}

const cardStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid rgba(0,0,0,.07)',
  borderRadius: 14,
  boxShadow: '0 1px 3px rgba(0,0,0,.04)',
  overflow: 'hidden',
}

const cardHeaderStyle: CSSProperties = {
  padding: '16px 20px 4px',
  fontWeight: 700,
  fontSize: 14,
}

const secondaryBtnStyle: CSSProperties = {
  flex: 'none',
  padding: '6px 12px',
  border: '1px solid rgba(0,0,0,.12)',
  borderRadius: 999,
  background: '#fff',
  fontFamily: 'inherit',
  fontSize: 11.5,
  fontWeight: 600,
  color: '#1c1a18',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const dangerBtnStyle: CSSProperties = {
  ...secondaryBtnStyle,
  border: '1px solid rgba(224,68,48,.35)',
  color: '#b3200c',
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
        style={{ ...secondaryBtnStyle, border: 'none', background: '#e04430', color: '#fff' }}
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
  )
}

interface SelectableModelRowProps extends ModelRowAction {
  selected: boolean
  onSelect: () => void
}

/**
 * One radio-style model row, shared by both the Transcription and Summary
 * model sections: a selected/installed model shows the filled radio dot and
 * "Installed · in use"; a not-yet-installed or still-downloading row shows
 * its Download/Cancel affordance but the radio itself stays inert (not
 * `selectable`) until the model actually finishes installing.
 */
function SelectableModelRow({ entry, downloads, selected, onSelect, downloadModel, cancelDownload, deleteModel }: SelectableModelRowProps) {
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
      tabIndex={selectable ? 0 : -1}
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
        border: selected ? '1.5px solid #e04430' : '1px solid rgba(0,0,0,.1)',
        background: selected ? '#fff6f4' : '#fff',
        borderRadius: 10,
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
          background: '#fff',
          border: selected ? '5px solid #e04430' : '1.5px solid #b0a9a2',
          transition: 'border .15s',
        }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        <b>{info.displayName}</b> — {info.desc}
        <br />
        <span style={{ fontSize: 12, color: selected ? '#b3200c' : '#9a938c', fontWeight: selected ? 600 : 400 }}>{info.sub}</span>
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
  tEnc,
  toggleEnc,
}: SettingsViewProps) {
  const sttModels = models.filter(m => m.kind === 'stt')
  const llmModels = models.filter(m => m.kind === 'llm')

  const modelsBytes = storage?.modelsBytes ?? 0
  const audioBytes = storage?.audioBytes ?? 0
  const notesBytes = storage?.notesBytes ?? 0
  const totalBytes = modelsBytes + audioBytes + notesBytes
  const pct = (n: number) => (totalBytes > 0 ? (n / totalBytes) * 100 : 0)

  return (
    <div style={{ flex: 1, overflow: 'auto', background: '#f7f6f4' }}>
      <div style={{ maxWidth: 760, padding: '28px 36px 40px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <h1 style={{ margin: 0, fontWeight: 700, fontSize: 22, letterSpacing: '-.02em' }}>Settings</h1>

        <div style={{ background: '#1c1a18', color: '#fff', borderRadius: 16, padding: '24px 28px', boxShadow: '0 2px 8px rgba(0,0,0,.15)' }}>
          <div style={{ fontWeight: 700, fontSize: 19, letterSpacing: '-.01em' }}>Nothing leaves this machine.</div>
          <div style={{ marginTop: 6, fontSize: 13.5, lineHeight: 1.6, color: 'rgba(255,255,255,.75)', maxWidth: 520 }}>
            No account. No cloud. No network permission. Transcription and summarization run entirely on your hardware — pull the Wi-Fi and everything still works.
          </div>
        </div>

        <div style={cardStyle}>
          <div style={cardHeaderStyle}>Transcription model</div>
          <div
            role="radiogroup"
            aria-label="Transcription model"
            style={{ padding: '12px 20px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            {sttModels.map(m => (
              <SelectableModelRow
                key={m.id}
                entry={m}
                downloads={downloads}
                selected={sttModel === m.id}
                onSelect={() => setSttModel(m.id)}
                downloadModel={downloadModel}
                cancelDownload={cancelDownload}
                deleteModel={deleteModel}
              />
            ))}
          </div>
        </div>

        <div style={cardStyle}>
          <div style={cardHeaderStyle}>Summary model</div>
          <div style={{ padding: '4px 20px 4px', fontSize: 12, color: '#9a938c' }}>Powers summaries, decisions & action items.</div>
          <div
            role="radiogroup"
            aria-label="Summary model"
            style={{ padding: '8px 20px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            {llmModels.map(m => (
              <SelectableModelRow
                key={m.id}
                entry={m}
                downloads={downloads}
                selected={llmModel === m.id}
                onSelect={() => setLlmModel(m.id)}
                downloadModel={downloadModel}
                cancelDownload={cancelDownload}
                deleteModel={deleteModel}
              />
            ))}
          </div>
        </div>

        <div style={cardStyle}>
          <div style={cardHeaderStyle}>Storage</div>
          <div style={{ padding: '12px 20px 18px' }}>
            <div style={{ display: 'flex', height: 12, borderRadius: 999, overflow: 'hidden', background: '#eceae7', maxWidth: 520 }}>
              <div style={{ width: `${pct(modelsBytes)}%`, background: '#1c1a18' }} />
              <div style={{ width: `${pct(audioBytes)}%`, background: '#e04430' }} />
              <div style={{ width: `${pct(notesBytes)}%`, background: '#b0a9a2' }} />
            </div>
            <div style={{ display: 'flex', gap: 18, marginTop: 8, fontSize: 12, color: '#8d867f', flexWrap: 'wrap' }}>
              <span>
                <b style={{ color: '#1c1a18' }}>●</b> Models {formatBytes(modelsBytes)}
              </span>
              <span>
                <b style={{ color: '#e04430' }}>●</b> Audio {formatBytes(audioBytes)}
              </span>
              <span>
                <b style={{ color: '#b0a9a2' }}>●</b> Notes {formatBytes(notesBytes)}
              </span>
              <span>{noteCount} notes</span>
            </div>
            <div style={{ marginTop: 16 }}>
              <Toggle on={tDel} onToggle={toggleDel} label="Delete original audio 30 days after transcription" />
            </div>
            <div style={{ marginTop: 10 }}>
              <Toggle on={tEnc} onToggle={toggleEnc} label="Encrypt note library with FileVault key" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
