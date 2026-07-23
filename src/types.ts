export type View = 'loading' | 'onboarding' | 'notes' | 'recording' | 'settings'
export type NoteTab = 'transcript' | 'md'

export interface NoteListItem {
  title: string
  meta: string
  group?: string
}

export interface ActionItem {
  text: string
  done: boolean
}

export interface TranscriptSegment {
  initials: string
  speaker: string
  time: string
  text: string
  isMe?: boolean
  highlight?: boolean
}

export interface SttModelInfo {
  id: string
  name: string
  desc: string
  sub: string
  subOn: string
}
