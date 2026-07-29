import { performance } from 'node:perf_hooks'
import { renderToString } from 'react-dom/server'
import type { NoteMeta } from '../ipc/types'
import { notesToSidebarItems } from '../state/adapters'
import { Sidebar } from '../components/Sidebar'

const noop = () => {}
const noopAsync = async () => {}

describe('large synthetic library', () => {
  it('adapts and renders 2,000 notes within a reviewable budget', () => {
    const notes: NoteMeta[] = Array.from({ length: 2_000 }, (_, index) => ({
      id: `synthetic-${index.toString().padStart(4, '0')}`,
      title: `Synthetic meeting ${index.toString().padStart(4, '0')}`,
      createdAt: new Date(Date.UTC(2026, 6, 27) - index * 60_000).toISOString(),
      durationSec: 300 + index,
      model: 'whisper-small',
      status: index % 4 === 0 ? 'ready' : 'transcribed',
      speakers: index % 7 + 1,
      audioDeleted: index % 5 === 0,
      sources: index % 3 === 0 ? ['mic', 'system'] : ['mic'],
      pinned: index % 50 === 0,
    }))

    const started = performance.now()
    const items = notesToSidebarItems(notes, new Date('2026-07-27T18:00:00Z'))
    const html = renderToString(
      <Sidebar
        notes={items}
        selectedNoteId={items[0].id}
        onSelect={noop}
        view="notes"
        onGoNotes={noop}
        onGoSettings={noop}
        statsLine="2,000 notes"
        searchQuery=""
        onSearchQueryChange={noop}
        matchedNoteIds={null}
        onOpenPalette={noop}
        onStartRecording={noop}
        onTogglePinned={noop}
        onOpenShortcuts={noop}
        onBulkExport={noopAsync}
        onBulkDelete={noopAsync}
        onRenameNote={noop}
        onRevealNote={noop}
      />,
    )
    const elapsedMs = performance.now() - started

    expect(items).toHaveLength(2_000)
    expect(html).toContain('Synthetic meeting 0000')
    expect(html).toContain('Synthetic meeting 1999')
    expect(elapsedMs).toBeLessThan(5_000)
  })
})
