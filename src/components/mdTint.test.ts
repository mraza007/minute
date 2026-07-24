import { mdTint } from './mdTint'

describe('mdTint', () => {
  it('tints a heading line entirely red and bold', () => {
    const tokens = mdTint('# Client call — Acme')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toEqual({ text: '# Client call — Acme', color: 'var(--accent-text)', fontWeight: 700 })
  })

  it('tints a level-2 heading entirely red and bold', () => {
    const tokens = mdTint('## Summary')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toEqual({ text: '## Summary', color: 'var(--accent-text)', fontWeight: 700 })
  })

  it('greys out a checked action-item marker and leaves the rest default', () => {
    const tokens = mdTint('- [x] Send security documentation to Tom before procurement kickoff')
    expect(tokens[0]).toEqual({ text: '- [x]', color: 'var(--ink-faint)' })
    expect(tokens[1]).toEqual({ text: ' Send security documentation to Tom before procurement kickoff' })
  })

  it('greys out an unchecked action-item marker', () => {
    const tokens = mdTint('- [ ] Set up Markdown export matching Acme Monday digest template')
    expect(tokens[0]).toEqual({ text: '- [ ]', color: 'var(--ink-faint)' })
  })

  it('greys out a plain list dash marker and leaves the rest default', () => {
    const tokens = mdTint("- Pilot expands to 200 seats in Q3 if security review passes.")
    expect(tokens[0]).toEqual({ text: '-', color: 'var(--ink-faint)' })
    expect(tokens[1]).toEqual({ text: " Pilot expands to 200 seats in Q3 if security review passes." })
  })

  it('bolds a **label:** run while keeping the asterisks and leaves the rest default', () => {
    const tokens = mdTint('**Date:** May 21, 2026 · **Duration:** 48 min · **Speakers:** 4')
    expect(tokens[0]).toEqual({ text: '**Date:**', fontWeight: 700 })
    expect(tokens[1]).toEqual({ text: ' May 21, 2026 · ' })
    expect(tokens.some((t) => t.text === '**Duration:**' && t.fontWeight === 700)).toBe(true)
  })

  it('greys out a trailing timestamp after a bold speaker name', () => {
    const tokens = mdTint('**Tom Reyes — Acme** (00:41)')
    expect(tokens[0]).toEqual({ text: '**Tom Reyes — Acme**', fontWeight: 700 })
    expect(tokens[1]).toEqual({ text: ' (00:41)', color: 'var(--ink-faint)' })
  })

  it('reddens the trailing highlight marker', () => {
    const tokens = mdTint('**Tom Reyes — Acme** (01:34) ★ highlight')
    expect(tokens[0]).toEqual({ text: '**Tom Reyes — Acme**', fontWeight: 700 })
    expect(tokens[1]).toEqual({ text: ' (01:34)', color: 'var(--ink-faint)' })
    expect(tokens[2]).toEqual({ text: ' ★ highlight', color: 'var(--accent-text)' })
  })

  it('returns a single default token for a plain line', () => {
    const tokens = mdTint('Thanks for making time. Before we get into the roadmap, I want to flag')
    expect(tokens).toEqual([{ text: 'Thanks for making time. Before we get into the roadmap, I want to flag' }])
  })

  it('returns a single empty default token for a blank line', () => {
    const tokens = mdTint('')
    expect(tokens).toEqual([{ text: '' }])
  })

  it('leaves unclosed bold markers as a single plain token with literal asterisks', () => {
    const tokens = mdTint('**Date: May 21')
    expect(tokens).toEqual([{ text: '**Date: May 21' }])
  })

  it('pins current behavior for a marker-only unchecked action item line', () => {
    const tokens = mdTint('- [ ]')
    expect(tokens).toEqual([{ text: '- [ ]', color: 'var(--ink-faint)' }])
  })

  it('pins current behavior for a marker-only dash-bullet line', () => {
    const tokens = mdTint('- ')
    expect(tokens).toEqual([
      { text: '-', color: 'var(--ink-faint)' },
      { text: ' ' },
    ])
  })
})
