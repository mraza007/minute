import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { NoteMeta, SearchHit } from '../ipc/types'
import { formatMmSs, splitHighlight } from '../state/adapters'
import './searchPalette.css'

export interface SearchPaletteProps {
  /** The full note list. Search hits carry no date or length, so a title hit looks them up here. */
  notes: NoteMeta[]
  /** `search_notes`, passed in so tests can use a plain stub (see `useAppState`'s `searchNotes`). */
  search: (query: string) => Promise<SearchHit[]>
  onClose: () => void
  /** Enter or click on a title hit opens that note. */
  onOpenTitleHit: (noteId: string) => void
  /** Enter or click on a transcript hit opens that note and plays from the matched moment. */
  onOpenTranscriptHit: (noteId: string, segmentStart: number) => void
}

const SEARCH_DEBOUNCE_MS = 150

const DAY_MS = 86_400_000

/** "Today · 28 min", "Yesterday · 5 min", or "Jul 22, 2026 · 21 min". */
function noteWhen(notes: NoteMeta[], noteId: string, now: Date = new Date()): string {
  const note = notes.find(n => n.id === noteId)
  if (!note) return ''
  const created = new Date(note.createdAt)
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const daysAgo = Math.round((startOfDay(now) - startOfDay(created)) / DAY_MS)
  const day =
    daysAgo === 0
      ? 'Today'
      : daysAgo === 1
        ? 'Yesterday'
        : created.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${day} · ${Math.max(1, Math.round(note.durationSec / 60))} min`
}

/** Bolds the matched text, so the match reads without a second highlight colour. */
function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitHighlight(text, query).map((segment, i) =>
        segment.match ? <strong key={i}>{segment.text}</strong> : <span key={i}>{segment.text}</span>,
      )}
    </>
  )
}

/**
 * ⌘K / ⌘F search palette. Combobox and listbox pattern: the `<input>` keeps
 * DOM focus the whole time, and the arrow keys move a visual selection plus
 * `aria-activedescendant` over the results. That also makes the focus trap
 * simple, since the panel holds exactly one focusable control.
 */
export function SearchPalette({ notes, search, onClose, onOpenTitleHit, onOpenTranscriptHit }: SearchPaletteProps) {
  const [query, setQuery] = useState('')
  const [rawHits, setHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)
  const requestSeq = useRef(0)

  // Note hits come first, then transcript hits, so the arrow keys follow the
  // order on screen.
  const hits = useMemo(
    () => [...rawHits.filter(hit => hit.kind === 'title'), ...rawHits.filter(hit => hit.kind !== 'title')],
    [rawHits],
  )
  const titleCount = hits.filter(hit => hit.kind === 'title').length

  // Focus the input on mount and give focus back on unmount. App mounts this
  // only while search is open, so unmount always means it just closed.
  useEffect(() => {
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    inputRef.current?.focus()
    return () => {
      previouslyFocused.current?.focus()
    }
  }, [])

  // Debounced search. A blank query clears the results without calling
  // `search`, as the backend does. `requestSeq` stops a slow answer to an
  // abandoned query from landing after a newer one, including after a clear.
  useEffect(() => {
    const trimmed = query.trim()
    setActiveIndex(0)
    const requestId = ++requestSeq.current
    if (trimmed === '') {
      setHits([])
      setSearchError(null)
      setLoading(false)
      return
    }

    const timer = setTimeout(() => {
      setLoading(true)
      search(trimmed)
        .then(result => {
          if (requestSeq.current !== requestId) return
          setHits(result)
          setSearchError(null)
        })
        .catch(err => {
          if (requestSeq.current !== requestId) return
          setHits([])
          setSearchError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (requestSeq.current === requestId) setLoading(false)
        })
    }, SEARCH_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [query, search])

  // Keeps the keyboard selection in view. `block: 'nearest'` scrolls the
  // least it can and leaves a row that is already visible alone.
  useEffect(() => {
    if (hits.length === 0) return
    document.getElementById(`search-hit-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, hits.length])

  function selectHit(hit: SearchHit) {
    if (hit.kind === 'title') {
      onOpenTitleHit(hit.noteId)
    } else {
      onOpenTranscriptHit(hit.noteId, hit.segmentStart ?? 0)
    }
  }

  function handleInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (hits.length > 0) setActiveIndex(i => (i + 1) % hits.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (hits.length > 0) setActiveIndex(i => (i - 1 + hits.length) % hits.length)
    } else if (e.key === 'Enter') {
      // The Enter that confirms an IME composition finishes the text. It
      // does not ask to open the hit.
      if (e.nativeEvent.isComposing) return
      e.preventDefault()
      const hit = hits[activeIndex]
      if (hit) selectHit(hit)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  // The input is the only tab stop in the panel, so Tab keeps focus on it.
  function handlePanelKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab') return
    e.preventDefault()
    inputRef.current?.focus()
  }

  function handleOverlayMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose()
  }

  const trimmedQuery = query.trim()
  const activeHit = hits[activeIndex]
  const activeId = activeHit ? `search-hit-${activeIndex}` : undefined

  let resultsAnnouncement = ''
  if (trimmedQuery && !loading) {
    resultsAnnouncement = searchError ? 'Search failed' : `${hits.length} result${hits.length === 1 ? '' : 's'}`
  }

  function renderHit(hit: SearchHit, i: number) {
    const active = i === activeIndex
    return (
      <div
        key={`${hit.noteId}-${hit.kind}-${i}`}
        id={`search-hit-${i}`}
        role="option"
        aria-selected={active}
        className="sp-hit"
        data-kind={hit.kind === 'title' ? 'title' : 'transcript'}
        data-active={active ? 'true' : undefined}
        onMouseEnter={() => setActiveIndex(i)}
        onMouseDown={e => {
          // Selects on mouse down. The default action would blur the input,
          // and the overlay's own handler must not read this as an outside click.
          e.preventDefault()
          selectHit(hit)
        }}
      >
        {hit.kind === 'title' ? (
          <>
            <span className="sp-hit-title">{hit.title}</span>
            <span className="sp-hit-meta">{noteWhen(notes, hit.noteId)}</span>
          </>
        ) : (
          <>
            <span className="sp-hit-time">{formatMmSs(hit.segmentStart ?? 0)}</span>
            <span className="sp-hit-body">
              <span className="sp-hit-snippet">
                <Highlighted text={hit.snippet} query={trimmedQuery} />
              </span>
              <span className="sp-hit-meta">{hit.title}</span>
            </span>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="sp-overlay" onMouseDown={handleOverlayMouseDown}>
      <div className="sp-panel" role="dialog" aria-modal="true" aria-label="Search notes" onKeyDown={handlePanelKeyDown}>
        <div className="sp-input-row">
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M20 20l-3.5-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="sp-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="search-palette-listbox"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label="Search notes"
            placeholder="Search titles and transcripts…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          <span className="sp-esc" aria-hidden="true">esc</span>
        </div>
        <div id="search-palette-listbox" role="listbox" aria-label="Search results" className="sp-results">
          {trimmedQuery === '' && <div className="sp-empty">Search note titles and transcripts.</div>}
          {trimmedQuery !== '' && searchError && <div className="sp-empty">Search failed: {searchError}</div>}
          {trimmedQuery !== '' && !searchError && !loading && hits.length === 0 && (
            <div className="sp-empty">No matches for “{trimmedQuery}”.</div>
          )}
          {titleCount > 0 && (
            <div role="group" aria-labelledby="sp-group-notes">
              <div id="sp-group-notes" className="sp-group-label">Notes</div>
              {hits.slice(0, titleCount).map((hit, i) => renderHit(hit, i))}
            </div>
          )}
          {hits.length > titleCount && (
            <div role="group" aria-labelledby="sp-group-transcripts">
              <div id="sp-group-transcripts" className="sp-group-label">In transcripts</div>
              {hits.slice(titleCount).map((hit, i) => renderHit(hit, titleCount + i))}
            </div>
          )}
        </div>
        {hits.length > 0 && (
          <div className="sp-hints" aria-hidden="true">
            <span>↑↓ Move</span>
            <span>↵ {activeHit?.kind === 'transcript' ? 'Open and play from this moment' : 'Open'}</span>
          </div>
        )}
        <span role="status" className="visually-hidden">
          {resultsAnnouncement}
        </span>
      </div>
    </div>
  )
}
