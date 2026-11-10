import { assignSpeakerColors, speakerColorStyle } from './speakerColors'

describe('assignSpeakerColors', () => {
  it('keeps blue for You wherever You first speaks', () => {
    const colors = assignSpeakerColors(['Marcus Chen', 'You', 'Speaker 3'])
    expect(colors.get('You')).toBe(1)
    expect(colors.get('Marcus Chen')).toBe(2)
    expect(colors.get('Speaker 3')).toBe(3)
  })

  it('never gives another speaker blue, even without You', () => {
    const colors = assignSpeakerColors(['Speaker 1', 'Speaker 2'])
    expect([...colors.values()]).toEqual([2, 3])
  })

  it('reuses colours in order once there are more speakers than colours', () => {
    const speakers = ['You', ...Array.from({ length: 7 }, (_, index) => `Speaker ${index + 2}`)]
    const colors = assignSpeakerColors(speakers)
    expect(speakers.map(speaker => colors.get(speaker))).toEqual([1, 2, 3, 4, 5, 6, 2, 3])
  })

  it('exposes the colour and its tint as CSS variables', () => {
    const colors = assignSpeakerColors(['You', 'Marcus Chen'])
    expect(speakerColorStyle(colors, 'Marcus Chen')).toEqual({
      '--speaker-color': 'var(--speaker-2)',
      '--speaker-tint': 'var(--speaker-2-tint)',
    })
  })
})
