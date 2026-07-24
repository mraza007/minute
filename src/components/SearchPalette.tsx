import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { NoteMeta, SearchHit } from '../ipc/types'
import { formatMmSs, splitHighlight } from '../state/adapters'

export interface SearchPaletteProps {
  /** The full note list — used only to look up a title hit's date label (search hits don't carry `createdAt`; the frontend already has this). */
  notes: NoteMeta[]
  /** `search_notes`, injected (rather than imported from `ipc/commands` directly) so this component can be tested with a plain stub — see `useAppState`'s `searchNotes`. */
  search: (query: string) => Promise<SearchHit[]>
  onClose: () => void
  /** Enter/click on a title hit — opens that note. */
  onOpenTitleHit: (noteId: string) => void
  /** Enter/click on a transcript hit — opens that note and seeks playback to the matched segment's start. */
  onOpenTranscriptHit: (noteId: string, segmentStart: number) => void
}

const SEARCH_DEBOUNCE_MS = 150

function dateLabelFor(notes: NoteMeta[], noteId: string): string {
  const note = notes.find(n => n.id === noteId)
  if (!note) return ''
  return new Date(note.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

/** Renders `splitHighlight`'s segments, bolding the matched substring in the app's accent color rather than a default `<mark>` yellow — keeps the palette inside the paper-and-ink palette instead of introducing a new color. */
function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitHighlight(text, query).map((segment, i) =>
        segment.match ? (
          <strong key={i} style={{ color: 'var(--accent-text)', fontWeight: 700 }}>
            {segment.text}
          </strong>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  )
}

/**
 * ⌘K / ⌘F command palette — the one deliberately-justified overlay in the
 * app (see .impeccable.md's "paper, not glass"; `--scrim` in index.css is
 * the plain dim backdrop this uses). Combobox/listbox ARIA pattern: the
 * `<input>` (role="combobox") keeps real DOM focus for the whole time the
 * palette is open — arrow keys move a *visual* + `aria-activedescendant`
 * selection over the results (role="listbox"/"option"), never actual DOM
 * focus, which is also what makes this "focus trap" trivial: there is
 * exactly one focusable control inside the panel, and Tab/Shift-Tab (see
 * `handlePanelKeyDown`) simply keep it there rather than letting focus
 * escape to whatever's behind the overlay.
 */
export function SearchPalette({ notes, search, onClose, onOpenTitleHit, onOpenTranscriptHit }: SearchPaletteProps) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)
  const requestSeq = useRef(0)

  // Autofocus on mount; restore focus to whatever had it before the palette
  // opened once it unmounts (App.tsx only mounts this while `searchOpen`,
  // so unmount here always means "the palette just closed").
  useEffect(() => {
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    inputRef.current?.focus()
    return () => {
      previouslyFocused.current?.focus()
    }
  }, [])

  // Debounced search — a blank/whitespace query clears results immediately
  // without ever calling `search` (matches the backend's own short-circuit;
  // see `store::Store::search_notes`'s docs). `requestSeq` guards against a
  // slow response to an abandoned query landing after a newer one already
  // resolved.
  useEffect(() => {
    const trimmed = query.trim()
    setActiveIndex(0)
    // Bumped unconditionally — including the blank-query clear branch below
    // — so a response for whatever query was previously in flight can never
    // land after this effect ran, even though the clear branch itself
    // doesn't start a new debounced search. Without this, clearing the
    // input while a search is still in flight would leave that stale
    // request's id current, and its eventual `.then`/`.catch` would
    // repopulate `hits` right after this effect just cleared them.
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

  // Keeps the roving keyboard selection visible as it moves — with up to
  // [`SEARCH_HIT_CAP`]-worth of results in a `maxHeight`-capped listbox,
  // arrowing past the fold would otherwise only move
  // `aria-activedescendant` (and the visual highlight) on a row that's
  // scrolled out of view, with nothing on screen to show it happened.
  // `block: 'nearest'` scrolls the minimum amount needed to bring the row
  // into view — never re-centers or over-scrolls a row that's already
  // visible.
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
      e.preventDefault()
      const hit = hits[activeIndex]
      if (hit) selectHit(hit)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  // Focus trap: the input is the only real tab stop inside the panel (see
  // the component's docs above), so Tab/Shift-Tab both just keep focus on
  // it rather than letting it escape to whatever's behind the overlay.
  function handlePanelKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab') return
    e.preventDefault()
    inputRef.current?.focus()
  }

  function handleOverlayMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose()
  }

  const trimmedQuery = query.trim()
  const activeId = hits[activeIndex] ? `search-hit-${activeIndex}` : undefined

  let resultsAnnouncement = ''
  if (trimmedQuery && !loading) {
    resultsAnnouncement = searchError ? 'Search failed' : `${hits.length} result${hits.length === 1 ? '' : 's'}`
  }

  return (
    <div
      onMouseDown={handleOverlayMouseDown}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingTop: '12vh',
        zIndex: 1000,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search notes"
        onKeyDown={handlePanelKeyDown}
        style={{
          width: '100%',
          maxWidth: 560,
          maxHeight: '68vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          boxShadow: '0 20px 48px rgba(0,0,0,.22)',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '4px 16px', borderBottom: '1px solid var(--border-soft)', flex: 'none' }}>
          <input
            ref={inputRef}
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
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '14px 4px',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontFamily: 'inherit',
              fontSize: 16,
              color: 'var(--ink)',
            }}
          />
        </div>
        <div id="search-palette-listbox" role="listbox" aria-label="Search results" style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
          {trimmedQuery === '' && (
            <div style={{ padding: '20px 14px', fontSize: 13, color: 'var(--ink-muted)' }}>
              Search note titles and transcripts.
            </div>
          )}
          {trimmedQuery !== '' && searchError && (
            <div style={{ padding: '20px 14px', fontSize: 13, color: 'var(--ink-muted)' }}>Search failed: {searchError}</div>
          )}
          {trimmedQuery !== '' && !searchError && !loading && hits.length === 0 && (
            <div style={{ padding: '20px 14px', fontSize: 13, color: 'var(--ink-muted)' }}>No matches for “{trimmedQuery}”.</div>
          )}
          {hits.map((hit, i) => (
            <div
              key={`${hit.noteId}-${hit.kind}-${i}`}
              id={`search-hit-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActiveIndex(i)}
              onMouseDown={e => {
                // Prevent the overlay's onMouseDown (click-outside-closes)
                // from treating this as "outside" — the row is inside the
                // panel, but the panel's own onMouseDown doesn't stop
                // propagation on purpose (it only closes on the overlay
                // background itself, per `handleOverlayMouseDown`'s
                // `e.target === e.currentTarget` check) — this just commits
                // the selection on mousedown rather than waiting for click.
                e.preventDefault()
                selectHit(hit)
              }}
              style={{
                padding: '8px 10px',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                background: i === activeIndex ? 'var(--surface-soft)' : 'transparent',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {hit.title}
              </div>
              {hit.kind === 'title' ? (
                <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 1 }}>{dateLabelFor(notes, hit.noteId)}</div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2 }}>
                  <span
                    style={{
                      flex: 'none',
                      padding: '1px 6px',
                      borderRadius: 5,
                      border: '1px solid var(--border-strong)',
                      background: 'var(--surface-softer)',
                      fontSize: 11,
                      fontWeight: 600,
                      color: 'var(--ink-faint)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {formatMmSs(hit.segmentStart ?? 0)}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <Highlighted text={hit.snippet} query={trimmedQuery} />
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
        <span role="status" className="visually-hidden">
          {resultsAnnouncement}
        </span>
      </div>
    </div>
  )
}
