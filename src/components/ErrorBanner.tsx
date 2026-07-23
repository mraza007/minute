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
        padding: '10px 16px',
        borderRadius: 12,
        background: '#fff4f1',
        border: '1px solid rgba(224,68,48,.3)',
        color: '#b3200c',
        fontSize: 12.5,
        fontWeight: 600,
        lineHeight: 1.5,
        boxShadow: '0 4px 20px rgba(0,0,0,.12)',
        zIndex: 1000,
      }}
    >
      {message}
    </div>
  )
}
