import { memo, useMemo, type ReactNode } from 'react'
import { mdTint } from './mdTint'

interface MarkdownCardProps {
  filename: string
  subtitle: string
  markdown: string
  /** Reveal-in-Finder click handler — the caller owns the actual `revealNote` IPC call. */
  onReveal: () => void
  /**
   * Called when `navigator.clipboard.writeText` rejects (e.g. no clipboard
   * permission) so the caller can surface it (typically into the app's
   * `lastError` banner). Optional — a caller that doesn't care about copy
   * failures can omit it; the rejection is still caught either way, so it
   * never becomes an unhandled promise rejection.
   */
  onCopyError?: (err: unknown) => void
}

function MarkdownBody({ markdown }: { markdown: string }) {
  // Re-tokenizing every line on every render is wasted work once `markdown`
  // itself hasn't changed (e.g. a parent re-render for an unrelated reason)
  // — keyed on `markdown` alone, same as everything else this derives from.
  const nodes = useMemo(() => {
    const lines = markdown.split('\n')
    const out: ReactNode[] = []

    lines.forEach((line, lineIdx) => {
      mdTint(line).forEach((token, tokenIdx) => {
        if (token.text === '') return
        if (token.color || token.fontWeight) {
          out.push(
            <span key={`${lineIdx}-${tokenIdx}`} style={{ color: token.color, fontWeight: token.fontWeight }}>
              {token.text}
            </span>,
          )
        } else {
          out.push(token.text)
        }
      })
      if (lineIdx < lines.length - 1) out.push('\n')
    })

    return out
  }, [markdown])

  return <>{nodes}</>
}

// Memoized — NoteView passes this the same `markdown` string across
// re-renders that don't actually touch the Markdown tab (e.g. the transcript
// tab's own state), so there's no reason to re-run MarkdownBody's tokenizer.
export const MarkdownCard = memo(function MarkdownCard({ filename, subtitle, markdown, onReveal, onCopyError }: MarkdownCardProps) {
  function handleCopy() {
    if (!navigator.clipboard) {
      onCopyError?.(new Error('Clipboard unavailable'))
      return
    }
    navigator.clipboard.writeText(markdown).catch(err => onCopyError?.(err))
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '26px 34px 34px', minHeight: 0 }}>
      {/* A drawn frame, not a raised card — this block represents a file on
          disk, so a border earns its place here in a way the app's other
          former cards didn't. Square corners, hairline rule, no shadow.
          The body stays monospace: it's literal file source, the one place
          in the app where the characters themselves are the subject. */}
      <div style={{ maxWidth: 760, border: '1px solid var(--rule-strong)', overflow: 'hidden' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '9px 14px',
            borderBottom: '1px solid var(--rule)',
            background: 'var(--panel-warm)',
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ink-faint)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"></path>
            <path d="M15 3v6h6"></path>
          </svg>
          <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5, fontWeight: 600, color: 'var(--ink-body)' }}>
            {filename}
          </span>
          <span style={{ fontSize: 10.5, color: 'var(--ink-faint)' }}>{subtitle}</span>
          <div style={{ flex: 1 }} />
          <button
            onClick={handleCopy}
            className="btn-outline"
            style={{ padding: '5px 11px', fontSize: 11.5 }}
          >
            Copy
          </button>
          <button
            onClick={onReveal}
            className="btn-dark-accent"
            style={{
              padding: '6px 12px',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--btn-ink-bg)',
              color: 'var(--btn-ink-fg)',
              fontFamily: 'var(--sans)',
              fontSize: 11.5,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reveal in Finder
          </button>
        </div>
        <div
          style={{
            padding: '20px 22px',
            fontFamily: 'ui-monospace, Menlo, monospace',
            fontSize: 12.5,
            lineHeight: 1.8,
            color: 'var(--ink-body)',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'break-word',
            userSelect: 'text',
            cursor: 'auto',
          }}
        >
          <MarkdownBody markdown={markdown} />
        </div>
      </div>
    </div>
  )
})
