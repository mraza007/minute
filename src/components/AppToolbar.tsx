import type { ReactNode, RefObject } from 'react'

interface AppToolbarProps {
  /** Controls at the left edge. Present only while the sidebar is hidden. */
  lead?: ReactNode
  /** The view's own controls, right-aligned. */
  children?: ReactNode
}

/**
 * The strip across the top of the main area. Its empty space is the
 * window's drag handle, so the controls sit in it without a spacer element
 * that would swallow the drag.
 */
export function AppToolbar({ lead, children }: AppToolbarProps) {
  return (
    <div className="app-toolbar" data-tauri-drag-region="" data-lead={lead ? 'true' : undefined}>
      {lead}
      {children && <div className="toolbar-actions">{children}</div>}
    </div>
  )
}

interface SidebarReopenProps {
  isRecording: boolean
  /** The "Notes" button. Focus lands on it when the sidebar is collapsed from inside. */
  showNotesButtonRef?: RefObject<HTMLButtonElement | null>
  onShowNotes: () => void
  onStartRecording: () => void
  onReturnToRecording: () => void
}

/**
 * What the toolbar shows while the sidebar is hidden: a "Notes" button that
 * brings the sidebar back, and a compact record button so a recording can
 * still be started (or returned to) without it.
 */
export function SidebarReopen({ isRecording, showNotesButtonRef, onShowNotes, onStartRecording, onReturnToRecording }: SidebarReopenProps) {
  return (
    <>
      <button ref={showNotesButtonRef} type="button" className="toolbar-btn" aria-label="Show notes" title="Show the notes list" onClick={onShowNotes}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
        Notes
      </button>
      {isRecording ? (
        <button type="button" className="toolbar-record" data-recording="true" aria-label="Return to recording" title="Return to recording" onClick={onReturnToRecording}>
          <span className="toolbar-record-dot blink-dot" />
        </button>
      ) : (
        <button type="button" className="toolbar-record" aria-label="New recording" title="New recording" onClick={onStartRecording}>
          <span className="toolbar-record-dot" />
        </button>
      )}
    </>
  )
}
