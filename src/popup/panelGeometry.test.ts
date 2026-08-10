import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const popupRs = readFileSync(path.resolve(here, '../../src-tauri/src/popup.rs'), 'utf8')
const pillTsx = readFileSync(path.resolve(here, 'Pill.tsx'), 'utf8')

function rustConst(name: string): number {
  const match = popupRs.match(new RegExp(`const ${name}: f64 = ([\\d.]+);`))
  if (!match) throw new Error(`popup.rs no longer declares \`const ${name}: f64 = …;\` — update this test's extraction`)
  return Number(match[1])
}

function pillStyle(name: string): number {
  // First occurrence wins: the pill dialog's own style object is the first
  // width/height/margin in the file (the icon's 32x32 comes later).
  const match = pillTsx.match(new RegExp(`\\b${name}: (\\d+),`))
  if (!match) throw new Error(`Pill.tsx no longer sets \`${name}: <number>,\` inline — update this test's extraction`)
  return Number(match[1])
}

describe('meeting popup panel geometry', () => {
  it('reads the sizes this test depends on', () => {
    // Loud canary: if either file's shape drifts, fail here with a clear
    // message instead of comparing garbage below.
    expect(pillStyle('width')).toBeGreaterThan(0)
    expect(pillStyle('height')).toBeGreaterThan(0)
    expect(pillStyle('margin')).toBeGreaterThan(0)
    expect(rustConst('PANEL_WIDTH')).toBeGreaterThan(0)
    expect(rustConst('PANEL_HEIGHT')).toBeGreaterThan(0)
  })

  it('sizes the native window to the pill plus its margin on every side', () => {
    // The pill draws inside `margin` px of breathing room for its shadow.
    // The native window must include that footprint, or the pill's right and
    // bottom edges (border, shadow, countdown bar) get clipped flat — the
    // shipped-since-v1 bug behind issue #23's "clickable area is off".
    expect(rustConst('PANEL_WIDTH')).toBe(pillStyle('width') + 2 * pillStyle('margin'))
    expect(rustConst('PANEL_HEIGHT')).toBe(pillStyle('height') + 2 * pillStyle('margin'))
  })
})
