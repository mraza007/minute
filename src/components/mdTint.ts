export interface MdToken {
  text: string
  color?: string
  fontWeight?: number
}

const HEADING_RE = /^#{1,6}\s/
const ACTION_ITEM_RE = /^- \[[ xX]\]/
const INLINE_RE = /(\*\*[^*]+\*\*)|( \(\d{1,2}:\d{2}\))|( ★ highlight)/g

/**
 * Pure per-line tokenizer that maps a line of markdown to styled tokens,
 * matching the coloring used in the notetaker-v2 markdown-tab mock:
 * - heading lines are entirely red + bold
 * - leading list markers (`- [x]`, `- [ ]`, `-`) are grey, rest default
 * - `**bold**` runs are bold, asterisks kept visible
 * - trailing ` (HH:MM)` timestamps are grey
 * - the ` ★ highlight` marker is red
 */
export function mdTint(line: string): MdToken[] {
  if (HEADING_RE.test(line)) {
    return [{ text: line, color: '#b3200c', fontWeight: 700 }]
  }

  const tokens: MdToken[] = []
  let rest = line

  const actionMatch = rest.match(ACTION_ITEM_RE)
  if (actionMatch) {
    tokens.push({ text: actionMatch[0], color: '#9a938c' })
    rest = rest.slice(actionMatch[0].length)
  } else if (rest.startsWith('- ')) {
    tokens.push({ text: '-', color: '#9a938c' })
    rest = rest.slice(1)
  }

  let lastIndex = 0
  let match: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  while ((match = INLINE_RE.exec(rest))) {
    if (match.index > lastIndex) {
      tokens.push({ text: rest.slice(lastIndex, match.index) })
    }
    if (match[1]) {
      tokens.push({ text: match[1], fontWeight: 700 })
    } else if (match[2]) {
      tokens.push({ text: match[2], color: '#9a938c' })
    } else if (match[3]) {
      tokens.push({ text: match[3], color: '#b3200c' })
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < rest.length) {
    tokens.push({ text: rest.slice(lastIndex) })
  }

  return tokens.length > 0 ? tokens : [{ text: rest }]
}
