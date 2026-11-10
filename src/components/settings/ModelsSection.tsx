import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Hardware, ModelStatus, Recommendation } from '../../ipc/types'
import { formatBytes, modelStatusToSttInfo, type DownloadProgressState } from '../../state/adapters'
import { assessModelSuitability } from '../../state/modelSuitability'
import { DownloadProgressBar } from '../DownloadProgressBar'
import { HardwareSummary, ModelFit } from '../ModelSuitability'
import { SettingsHeading } from './controls'

const REMOVE_CONFIRM_TIMEOUT_MS = 4000

export interface ModelsSectionProps {
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
}

interface ModelActions {
  downloads: Record<string, DownloadProgressState>
  downloadModel: (id: string) => void
  cancelDownload: (id: string) => void
  deleteModel: (id: string) => void
}

interface ModelRowProps extends ModelActions {
  entry: ModelStatus
  hardware: Hardware | null
  recommendation: Recommendation | null
  selected: boolean
  onSelect: () => void
  /** The one row that owns the group's tab stop (roving tabindex). */
  roving: boolean
}

/** Remove needs a second click within four seconds, since the system confirm dialog does not fit the app. */
function RemoveButton({ entry, deleteModel }: { entry: ModelStatus; deleteModel: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false)
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timeout.current), [])

  return (
    <>
      <button
        type="button"
        className="st-link"
        data-tone="danger"
        data-armed={confirming ? 'true' : undefined}
        onClick={() => {
          if (!confirming) {
            setConfirming(true)
            timeout.current = setTimeout(() => setConfirming(false), REMOVE_CONFIRM_TIMEOUT_MS)
            return
          }
          clearTimeout(timeout.current)
          setConfirming(false)
          deleteModel(entry.id)
        }}
      >
        {confirming ? 'Confirm removal?' : 'Remove'}
      </button>
      <span role="status" className="visually-hidden">
        {confirming ? 'Press again to confirm removal' : ''}
      </span>
    </>
  )
}

function ModelRow({ entry, hardware, recommendation, downloads, selected, onSelect, roving, downloadModel, cancelDownload, deleteModel }: ModelRowProps) {
  const info = modelStatusToSttInfo(entry, selected ? entry.id : '', downloads)
  const progress = downloads[entry.id]
  const suitability = assessModelSuitability(entry, hardware, recommendation)
  // Only an installed model can be chosen. A model that is not downloaded
  // yet shows its state, and its radio stays inert until the download ends.
  const selectable = info.state === 'installed'

  return (
    <div className="st-model-row" data-selected={selected ? 'true' : undefined} data-model-row={entry.id}>
      <div
        role="radio"
        className="st-model-pick"
        aria-checked={selected}
        aria-disabled={!selectable}
        // Roving tabindex: one selectable row is a Tab stop, and Up/Down
        // moves focus and selection among the selectable rows.
        tabIndex={selectable ? (roving ? 0 : -1) : -1}
        data-model-id={entry.id}
        onClick={selectable ? onSelect : undefined}
        onKeyDown={
          selectable
            ? event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect()
                }
              }
            : undefined
        }
      >
        <span className="st-radio-slot"><span className="st-radio" /></span>
        <span className="st-model-text">
          <span className="st-model-name">{info.displayName}</span>
          <span className="st-model-sub">{info.desc}</span>
        </span>
        <ModelFit result={suitability} />
      </div>
      <div className="st-model-action">
        {info.state === 'notInstalled' && (
          <button
            type="button"
            className="st-link"
            data-tone="accent"
            aria-label={`Download ${entry.displayName} (${formatBytes(entry.sizeBytes)})`}
            onClick={() => downloadModel(entry.id)}
          >
            Download
          </button>
        )}
        {info.state === 'downloading' && progress && (
          <DownloadProgressBar
            downloaded={progress.downloaded}
            total={progress.total}
            compact
            action={
              <button type="button" className="st-link" data-tone="accent" onClick={() => cancelDownload(entry.id)}>
                Cancel
              </button>
            }
          />
        )}
        {info.state === 'installed' && !selected && <RemoveButton entry={entry} deleteModel={deleteModel} />}
        {info.state === 'installed' && selected && (
          <span className="st-swap">
            <span className="st-swap-rest">Installed</span>
            <RemoveButton entry={entry} deleteModel={deleteModel} />
          </span>
        )}
      </div>
    </div>
  )
}

interface ModelGroupProps extends ModelActions {
  title: string
  models: ModelStatus[]
  hardware: Hardware | null
  recommendation: Recommendation | null
  selectedId: string | null
  onSelect: (id: string) => void
}

function ModelGroup({ title, models, hardware, recommendation, downloads, selectedId, onSelect, downloadModel, cancelDownload, deleteModel }: ModelGroupProps) {
  const groupRef = useRef<HTMLDivElement>(null)
  const selectableIds = models.filter(m => modelStatusToSttInfo(m, '', downloads).state === 'installed').map(m => m.id)
  // The tab stop is the selected row if it can be chosen, else the first row that can.
  const rovingId = selectedId && selectableIds.includes(selectedId) ? selectedId : selectableIds[0]

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    if (selectableIds.length === 0) return
    event.preventDefault()
    const currentId = (event.target as HTMLElement).getAttribute('data-model-id')
    const currentIndex = currentId ? selectableIds.indexOf(currentId) : -1
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const nextId = selectableIds[(currentIndex + delta + selectableIds.length) % selectableIds.length]
    onSelect(nextId)
    groupRef.current?.querySelector<HTMLElement>(`[data-model-id="${nextId}"]`)?.focus()
  }

  return (
    <div className="st-list">
      <h2 className="st-label st-list-title">{title}</h2>
      <div ref={groupRef} role="radiogroup" aria-label={title === 'Transcription' ? 'Transcription model' : 'Summary model'} onKeyDown={handleKeyDown}>
        {models.map(entry => (
          <ModelRow
            key={entry.id}
            entry={entry}
            hardware={hardware}
            recommendation={recommendation}
            downloads={downloads}
            selected={selectedId === entry.id}
            roving={entry.id === rovingId}
            onSelect={() => onSelect(entry.id)}
            downloadModel={downloadModel}
            cancelDownload={cancelDownload}
            deleteModel={deleteModel}
          />
        ))}
      </div>
    </div>
  )
}

export function ModelsSection({
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
}: ModelsSectionProps) {
  const actions = { downloads, downloadModel, cancelDownload, deleteModel, hardware, recommendation }
  return (
    <div className="st-content">
      <SettingsHeading title="Models" lede={<HardwareSummary hardware={hardware} />} />
      <ModelGroup title="Transcription" models={models.filter(m => m.kind === 'stt')} selectedId={sttModel} onSelect={setSttModel} {...actions} />
      <ModelGroup title="Summaries and Ask" models={models.filter(m => m.kind === 'llm')} selectedId={llmModel} onSelect={setLlmModel} {...actions} />
    </div>
  )
}
