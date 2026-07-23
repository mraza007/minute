import type { ReactNode } from 'react'
import { demoMarkdown } from '../data/demo'
import { mdTint } from './mdTint'

function MarkdownBody() {
  const lines = demoMarkdown.split('\n')
  const nodes: ReactNode[] = []

  lines.forEach((line, lineIdx) => {
    mdTint(line).forEach((token, tokenIdx) => {
      if (token.text === '') return
      if (token.color || token.fontWeight) {
        nodes.push(
          <span key={`${lineIdx}-${tokenIdx}`} style={{ color: token.color, fontWeight: token.fontWeight }}>
            {token.text}
          </span>,
        )
      } else {
        nodes.push(token.text)
      }
    })
    if (lineIdx < lines.length - 1) nodes.push('\n')
  })

  return <>{nodes}</>
}

export function MarkdownCard() {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '20px 32px 28px', minHeight: 0 }}>
      <div
        style={{
          maxWidth: 720,
          background: '#fff',
          border: '1px solid rgba(0,0,0,.08)',
          borderRadius: 14,
          boxShadow: '0 1px 4px rgba(0,0,0,.05)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 16px',
            borderBottom: '1px solid rgba(0,0,0,.07)',
            background: '#faf9f7',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6d675f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"></path>
            <path d="M15 3v6h6"></path>
          </svg>
          <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, fontWeight: 600, color: '#33302c' }}>
            client-call-acme.md
          </span>
          <span style={{ fontSize: 11, color: '#9a938c' }}>4.2 KB · saved locally</span>
          <div style={{ flex: 1 }} />
          <button
            className="btn-light"
            style={{
              padding: '5px 12px',
              border: '1px solid rgba(0,0,0,.12)',
              borderRadius: 7,
              background: '#fff',
              fontFamily: 'inherit',
              fontSize: 11.5,
              fontWeight: 600,
              color: '#1c1a18',
              cursor: 'pointer',
            }}
          >
            Copy
          </button>
          <button
            className="btn-dark-accent"
            style={{
              padding: '5px 12px',
              border: 'none',
              borderRadius: 7,
              background: '#1c1a18',
              color: '#fff',
              fontFamily: 'inherit',
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
            padding: '20px 24px',
            fontFamily: 'ui-monospace, Menlo, monospace',
            fontSize: 12.5,
            lineHeight: 1.8,
            color: '#44403a',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'break-word',
          }}
        >
          <MarkdownBody />
        </div>
      </div>
    </div>
  )
}
