import { describe, expect, it } from 'vitest'
import { ASK_FOR_EVERY_APP, MEETING_APPS } from './meetingPolicy'

describe('meeting policy surface', () => {
  it('lists every app once and defaults each to ask', () => {
    const ids = MEETING_APPS.map(app => app.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(Object.keys(ASK_FOR_EVERY_APP).sort()).toEqual([...ids].sort())
    expect(Object.values(ASK_FOR_EVERY_APP).every(policy => policy === 'ask')).toBe(true)
  })
})
