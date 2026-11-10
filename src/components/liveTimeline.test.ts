import { liveTimeline } from './liveTimeline'

const turn = (start: number, text: string) => ({ speaker: 'You', start, end: start + 5, text })

function labels(items: ReturnType<typeof liveTimeline>) {
  return items.map(item => (item.kind === 'turn' ? item.group.text : `marker:${item.marker.label}`))
}

describe('liveTimeline', () => {
  it('places each marker after the last turn that started before it', () => {
    const items = liveTimeline(
      [turn(10, 'a'), turn(30, 'b'), turn(60, 'c')],
      [{ seconds: 45, label: 'mid' }, { seconds: 5, label: 'early' }],
    )
    expect(labels(items)).toEqual(['marker:early', 'a', 'b', 'marker:mid', 'c'])
  })

  it('keeps a marker ahead of the transcript at the end until later turns arrive', () => {
    const marker = [{ seconds: 50, label: 'follow up' }]
    expect(labels(liveTimeline([turn(10, 'a')], marker))).toEqual(['a', 'marker:follow up'])
    expect(labels(liveTimeline([turn(10, 'a'), turn(70, 'b')], marker))).toEqual(['a', 'marker:follow up', 'b'])
  })

  it('keeps each marker tied to its saved position', () => {
    const items = liveTimeline([], [{ seconds: 40, label: 'second' }, { seconds: 20, label: 'first' }])
    expect(items).toEqual([
      { kind: 'marker', marker: { seconds: 20, label: 'first' }, index: 1 },
      { kind: 'marker', marker: { seconds: 40, label: 'second' }, index: 0 },
    ])
  })
})
