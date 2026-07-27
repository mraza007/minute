interface ErrorBannerProps {
  message: string | null
}

/**
 * Fixed bottom-center toast surfacing `useAppState`'s `lastError` — until
 * this existed, `lastError` was tracked in state and auto-cleared after 5s
 * but never actually rendered anywhere, so failures (a rejected IPC call,
 * the initial load failing, ...) were silently invisible to the user.
 */
export function ErrorBanner({ message }: ErrorBannerProps) {
  if (!message) return null

  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 24,
        transform: 'translateX(-50%)',
        maxWidth: 480,
        padding: '11px 16px',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--error-tint)',
        border: '1px solid rgba(var(--accent-rgb), .3)',
        // A heavier rule down the leading edge — the same margin-marker
        // device used for selection and for the recording top edge, so an
        // error reads as annotated onto the page rather than pasted over it.
        borderLeft: '2px solid var(--accent)',
        color: 'var(--error-text-strong)',
        fontFamily: 'var(--serif)',
        fontSize: 13.5,
        lineHeight: 1.5,
        boxShadow: '0 4px 20px rgba(0,0,0,.12)',
        zIndex: 1000,
      }}
    >
      {message}
    </div>
  )
}
