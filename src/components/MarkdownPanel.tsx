import { useEffect, useRef, useState } from 'react'
import { formatBytes } from '../state/adapters'

export interface MarkdownPanelProps {
  /** The note's `note.md` as it is on disk, or `null` while the note still loads. */
  markdown: string | null
  /** Copies the Markdown. Resolves `false` when the clipboard refused; the caller reports why. */
  onCopy: () => Promise<boolean>
  onReveal: () => void
  onClose: () => void
}

const COPIED_MS = 2000

/**
 * "View Markdown" from the note menu: the note's `note.md`, read-only, with
 * its size. A non-modal dialog like the Ask panel. Escape or the close
 * button dismisses it.
 */
export function MarkdownPanel({ markdown, onCopy, onReveal, onClose }: MarkdownPanelProps) {
  const copyRef = useRef<HTMLButtonElement>(null)
  const [copied, setCopied] = useState(false)
  const copiedTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    copyRef.current?.focus()
    return () => clearTimeout(copiedTimeout.current)
  }, [])

  function copy() {
    void onCopy().then(ok => {
      if (!ok) return
      setCopied(true)
      clearTimeout(copiedTimeout.current)
      copiedTimeout.current = setTimeout(() => setCopied(false), COPIED_MS)
    })
  }

  return (
    <div
      className="markdown-panel"
      role="dialog"
      aria-label="Markdown"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }}
    >
      <div className="ask-panel-head">
        <h2>
          note.md
          {markdown !== null && (
            <span className="markdown-panel-size">{formatBytes(new TextEncoder().encode(markdown).length)}</span>
          )}
        </h2>
        <button type="button" className="icon-btn ask-panel-close" aria-label="Close Markdown" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      {/* Focusable so the keyboard can scroll it. */}
      <pre className="markdown-panel-body" tabIndex={0} aria-label="note.md contents">
        {markdown ?? 'Loading…'}
      </pre>
      <div className="markdown-panel-foot">
        <span role="status" className="visually-hidden">{copied ? 'Copied' : ''}</span>
        <button type="button" className="toolbar-btn" onClick={onReveal}>Show in Finder</button>
        <button ref={copyRef} type="button" className="toolbar-btn" data-variant="primary" disabled={markdown === null} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}
