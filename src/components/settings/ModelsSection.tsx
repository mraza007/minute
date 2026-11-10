import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { BrowseKind, Hardware, ModelStatus, Recommendation } from '../../ipc/types'
import { formatBytes, type DownloadProgressState } from '../../state/adapters'
import { buildModelCatalog, formatAge, type CatalogGroup, type CatalogRow } from '../../state/modelCatalog'
import type { BrowseState, HuggingFaceBrowse } from '../../state/useModelManager'
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
  downloadModel: (id: string, allowUnknownPublisher?: boolean) => void
  cancelDownload: (id: string) => void
  deleteModel: (id: string) => void
  huggingFace: HuggingFaceBrowse
}

/**
 * How each kind lays out its downloadable models. Transcription lists the
 * official whisper.cpp files beside the tested ones; Summaries gives Hugging
 * Face its own subgroup with a search.
 */
const GROUPS: Record<BrowseKind, { title: string; purpose: string; radioLabel: string; availableLabel: string; searchable: boolean }> = {
  stt: {
    title: 'Transcription',
    purpose: 'Turns speech into text while you record. Bigger models catch more names and accents, and take longer.',
    radioLabel: 'Transcription model',
    availableLabel: 'Available to download',
    searchable: false,
  },
  llm: {
    title: 'Summaries and Ask',
    purpose: 'Writes the summary, decisions, and action items, and answers questions. Larger models follow long meetings better.',
    radioLabel: 'Summary model',
    availableLabel: 'Tested by Minute',
    searchable: true,
  },
}

/** What a downloadable row can do. */
interface DownloadActions {
  downloadModel: (id: string, allowUnknownPublisher?: boolean) => void
  cancelDownload: (id: string) => void
  /** The one row whose unknown-publisher confirm is open, page-wide. */
  consentId: string | null
  setConsentId: (id: string | null) => void
}

/** Remove needs a second click within four seconds, since the system confirm dialog does not fit the app. */
function RemoveButton({ model, deleteModel }: { model: ModelStatus; deleteModel: (id: string) => void }) {
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
          deleteModel(model.id)
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

function ModelText({ row }: { row: CatalogRow }) {
  return (
    <span className="st-model-text">
      <span className="st-model-name">{row.model.displayName}</span>
      <span className="st-model-sub">{row.detail}</span>
    </span>
  )
}

interface InstalledRowsProps {
  label: string
  rows: CatalogRow[]
  onSelect: (id: string) => void
  deleteModel: (id: string) => void
}

/** "On this Mac": a radio group with a roving tabindex. Up and Down move focus and the selection. */
function InstalledRows({ label, rows, onSelect, deleteModel }: InstalledRowsProps) {
  const groupRef = useRef<HTMLDivElement>(null)
  const ids = rows.map(row => row.model.id)
  const rovingId = rows.find(row => row.selected)?.model.id ?? ids[0]

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const currentIndex = ids.indexOf((event.target as HTMLElement).getAttribute('data-model-id') ?? '')
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const nextId = ids[(currentIndex + delta + ids.length) % ids.length]
    onSelect(nextId)
    const radios = groupRef.current?.querySelectorAll<HTMLElement>('[data-model-id]') ?? []
    Array.from(radios).find(radio => radio.getAttribute('data-model-id') === nextId)?.focus()
  }

  if (rows.length === 0) return <p className="st-model-note">Nothing downloaded yet.</p>

  return (
    <div ref={groupRef} role="radiogroup" aria-label={label} className="st-model-list" onKeyDown={handleKeyDown}>
      {rows.map(row => (
        <div key={row.model.id} className="st-model-row" data-selected={row.selected ? 'true' : undefined}>
          <div
            role="radio"
            className="st-model-pick"
            aria-checked={row.selected}
            tabIndex={row.model.id === rovingId ? 0 : -1}
            data-model-id={row.model.id}
            onClick={() => onSelect(row.model.id)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect(row.model.id)
              }
            }}
          >
            <span className="st-radio-slot"><span className="st-radio" /></span>
            <ModelText row={row} />
            <ModelFit result={row.fit} />
          </div>
          <div className="st-model-action">
            {row.selected ? (
              <span className="st-swap">
                <span className="st-swap-rest">In use</span>
                <RemoveButton model={row.model} deleteModel={deleteModel} />
              </span>
            ) : (
              <RemoveButton model={row.model} deleteModel={deleteModel} />
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

interface ConsentConfirmProps {
  publisher: string
  onCancel: () => void
  onConfirm: () => void
}

/** The inline "Download anyway" check for a publisher Minute has not checked. Opens with focus on Cancel; Escape cancels. */
function ConsentConfirm({ publisher, onCancel, onConfirm }: ConsentConfirmProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const messageId = useId()
  useEffect(() => cancelRef.current?.focus(), [])

  return (
    <div
      className="st-consent"
      role="group"
      aria-labelledby={messageId}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
    >
      <p id={messageId} className="st-consent-text">
        Minute has not checked files from {publisher}. A damaged or hostile model file can crash the app. Download only if you trust this publisher.
      </p>
      <div className="st-consent-actions">
        <button ref={cancelRef} type="button" className="st-link" data-tone="muted" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="st-link" data-tone="accent" onClick={onConfirm}>
          Download anyway
        </button>
      </div>
    </div>
  )
}

function AvailableRow({ row, downloadModel, cancelDownload, consentId, setConsentId }: { row: CatalogRow } & DownloadActions) {
  const { model, unknownPublisher } = row
  const consentPublisher = consentId === model.id ? unknownPublisher : null
  const consentOpen = consentPublisher !== null
  const actionRef = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)

  // When the confirm closes, focus would fall to the page. Put it back on the
  // row's action instead: Download after Cancel, the download's Cancel after
  // "Download anyway". Opening another row's confirm keeps its own focus.
  useEffect(() => {
    if (wasOpen.current && !consentOpen && (document.activeElement === null || document.activeElement === document.body)) {
      actionRef.current?.querySelector<HTMLElement>('button')?.focus()
    }
    wasOpen.current = consentOpen
  }, [consentOpen])

  return (
    <>
      <div className="st-model-row" data-model-row={model.id}>
        <span className="st-radio-slot" />
        <ModelText row={row} />
        <ModelFit result={row.fit} />
        <div className="st-model-action" ref={actionRef}>
          {row.status === 'downloading' && row.progress ? (
            <DownloadProgressBar
              downloaded={row.progress.downloaded}
              total={row.progress.total}
              compact
              action={
                <span>
                  {/* A flex item drops a leading plain space. */}
                  {'\u00a0· '}
                  <button
                    type="button"
                    className="st-link st-link-small"
                    data-tone="accent"
                    aria-label={`Cancel downloading ${model.displayName}`}
                    onClick={() => cancelDownload(model.id)}
                  >
                    Cancel
                  </button>
                </span>
              }
            />
          ) : (
            !consentOpen && (
              <button
                type="button"
                className="st-link"
                data-tone="accent"
                aria-label={`Download ${model.displayName}, ${formatBytes(model.sizeBytes)}`}
                onClick={() => (unknownPublisher === null ? downloadModel(model.id) : setConsentId(model.id))}
              >
                Download
              </button>
            )
          )}
        </div>
      </div>
      {consentPublisher !== null && (
        <ConsentConfirm
          publisher={consentPublisher}
          onCancel={() => setConsentId(null)}
          onConfirm={() => {
            setConsentId(null)
            downloadModel(model.id, true)
          }}
        />
      )}
    </>
  )
}

function AvailableRows({ rows, ...actions }: { rows: CatalogRow[] } & DownloadActions) {
  if (rows.length === 0) return null
  return (
    <div className="st-model-list">
      {rows.map(row => (
        <AvailableRow key={row.model.id} row={row} {...actions} />
      ))}
    </div>
  )
}

/** The right side of the Hugging Face label: how fresh the list is, and the way to fetch it again. */
function BrowseStatus({ browse, onRefresh }: { browse: BrowseState; onRefresh: () => void }) {
  const age = browse.result?.fetchedAt ? formatAge(browse.result.fetchedAt, new Date()) : null
  return (
    <span className="st-model-label-meta" aria-live="polite">
      {browse.loading ? (
        'Checking…'
      ) : (
        <>
          {browse.result?.error ? 'Not updated · ' : age ? `Updated ${age} · ` : null}
          <button type="button" className="st-link st-link-small" data-tone="accent" onClick={onRefresh}>
            {browse.result?.error ? 'Try again' : 'Refresh'}
          </button>
        </>
      )}
    </span>
  )
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

interface BrowseNotesProps {
  browse: BrowseState
  /** How many Hugging Face rows are on screen. */
  shown: number
  /**
   * Summaries has its own Hugging Face subgroup, whose label carries Try
   * again. Transcription mixes the files into its download list, so its
   * notes stay quiet until something fails and carry Try again themselves.
   */
  searchable: boolean
  onRetry: () => void
}

/** Quiet lines under a Hugging Face list: still loading, unreachable, nothing found, or files this version cannot run. */
function BrowseNotes({ browse, shown, searchable, onRetry }: BrowseNotesProps) {
  const { result, loading, query } = browse
  const notes: ReactNode[] = []
  if (searchable && loading && !result) notes.push('Checking Hugging Face for newer models…')
  if (!loading && result?.error) {
    const age = result.fetchedAt ? formatAge(result.fetchedAt, new Date()) : null
    notes.push(
      <>
        {searchable ? 'Could not reach Hugging Face. ' : 'Could not reach Hugging Face for more transcription models. '}
        {age ? `This list is from ${age}.` : 'Models on this Mac keep working.'}
        {!searchable && (
          <>
            {' '}
            <button type="button" className="st-link st-link-small" data-tone="accent" onClick={onRetry}>
              Try again
            </button>
          </>
        )}
      </>,
    )
  }
  if (searchable && !loading && result && !result.error && shown === 0) {
    notes.push(query.trim() ? `No models match “${query.trim()}”.` : 'No newer models fit this Mac right now.')
  }
  if (result && result.unsupportedCount > 0) {
    notes.push(`${plural(result.unsupportedCount, 'newer model needs', 'newer models need')} a Minute update.`)
  }
  return notes.map((note, index) => (
    <p key={index} className="st-model-note">
      {note}
    </p>
  ))
}

/** A subgroup's small label, such as "On this Mac", with optional status on the right. */
function SubgroupLabel({ text, spaced = false, meta }: { text: string; spaced?: boolean; meta?: ReactNode }) {
  return (
    <div className="st-model-label" data-spaced={spaced ? 'true' : undefined}>
      <h3 className="st-model-label-text">{text}</h3>
      {meta}
    </div>
  )
}

interface SearchFieldProps {
  query: string
  onChange: (query: string) => void
  onSubmit: () => void
}

function SearchField({ query, onChange, onSubmit }: SearchFieldProps) {
  return (
    <label className="st-model-search">
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M9.25 9.25L12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        placeholder="Search any model on Hugging Face"
        aria-label="Search any model on Hugging Face"
        value={query}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onSubmit()
          }
        }}
      />
    </label>
  )
}

/** Rows folded away until asked for. A closed fold still shows a row that is downloading, so its progress never hides. */
function Fold({ rows, label, ...actions }: { rows: CatalogRow[]; label: string } & DownloadActions) {
  const [open, setOpen] = useState(false)
  if (rows.length === 0) return null
  const visible = open ? rows : rows.filter(row => row.status === 'downloading')
  return (
    <>
      <button type="button" className="st-model-fold" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className="st-radio-slot">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" data-open={open ? 'true' : undefined}>
            <path d="M4.5 3L7.5 6L4.5 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="st-model-fold-text">{label}</span>
        <span className="st-model-fold-action">{open ? 'Hide' : 'Show'}</span>
      </button>
      {visible.length > 0 && <AvailableRows rows={visible} {...actions} />}
    </>
  )
}

interface ModelGroupProps extends DownloadActions {
  deleteModel: (id: string) => void
  kind: BrowseKind
  group: CatalogGroup
  onSelect: (id: string) => void
  huggingFace: HuggingFaceBrowse
}

function ModelGroup({ kind, group, onSelect, huggingFace, deleteModel, ...actions }: ModelGroupProps) {
  const config = GROUPS[kind]
  const browse = huggingFace.state[kind]
  const retry = () => huggingFace.refresh(kind)
  const headingId = useId()

  return (
    <section className="st-model-group" aria-labelledby={headingId}>
      <header className="st-model-group-head">
        <h2 id={headingId} className="st-model-group-title">{config.title}</h2>
        <p className="st-model-group-purpose">{config.purpose}</p>
      </header>

      <SubgroupLabel text="On this Mac" />
      <InstalledRows label={config.radioLabel} rows={group.onThisMac} onSelect={onSelect} deleteModel={deleteModel} />

      {config.searchable ? (
        <>
          {group.tested.length > 0 && (
            <>
              <SubgroupLabel text={config.availableLabel} spaced />
              <AvailableRows rows={group.tested} {...actions} />
            </>
          )}
          <SubgroupLabel text="Newer on Hugging Face" spaced meta={<BrowseStatus browse={browse} onRefresh={retry} />} />
          <SearchField query={browse.query} onChange={query => huggingFace.setQuery(kind, query)} onSubmit={() => huggingFace.search(kind)} />
          <AvailableRows rows={group.huggingFace} {...actions} />
        </>
      ) : (
        <>
          <SubgroupLabel text={config.availableLabel} spaced />
          <AvailableRows rows={group.tested} {...actions} />
          <Fold rows={group.huggingFace} label={`${plural(group.huggingFace.length, 'more file', 'more files')} from whisper.cpp on Hugging Face`} {...actions} />
        </>
      )}
      <BrowseNotes browse={browse} shown={group.huggingFace.length} searchable={config.searchable} onRetry={retry} />

      <Fold rows={group.tooLarge} label={`${plural(group.tooLarge.length, 'more needs', 'more need')} more memory than this Mac has`} {...actions} />
    </section>
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
  huggingFace,
}: ModelsSectionProps) {
  const [consentId, setConsentId] = useState<string | null>(null)
  const { open } = huggingFace

  // Opening the page is one of the three moments Minute may contact Hugging Face.
  useEffect(() => open(), [open])

  const catalog = buildModelCatalog({
    listed: models,
    browsed: huggingFace.models,
    hardware,
    recommendation,
    downloads,
    selected: { stt: sttModel, llm: llmModel },
    now: new Date(),
  })
  const actions = { downloadModel, cancelDownload, deleteModel, consentId, setConsentId, huggingFace }

  return (
    <div className="st-content st-models">
      <SettingsHeading title="Models" lede={<HardwareSummary hardware={hardware} />} />
      <ModelGroup kind="stt" group={catalog.stt} onSelect={setSttModel} {...actions} />
      <ModelGroup kind="llm" group={catalog.llm} onSelect={setLlmModel} {...actions} />
    </div>
  )
}
