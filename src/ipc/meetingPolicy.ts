import type { MeetingApp, MeetingPolicies, MeetingPolicy } from './types'

/** The apps the detector tells apart, in the order a settings list shows them. */
export const MEETING_APPS: ReadonlyArray<{ id: MeetingApp; label: string }> = [
  { id: 'zoom', label: 'Zoom' },
  { id: 'teams', label: 'Microsoft Teams' },
  { id: 'webex', label: 'Webex' },
  { id: 'slack', label: 'Slack' },
  { id: 'faceTime', label: 'FaceTime' },
  { id: 'discord', label: 'Discord' },
  { id: 'browser', label: 'Calls in a browser' },
]

export const MEETING_POLICY_LABELS: Record<MeetingPolicy, string> = {
  ask: 'Ask',
  record: 'Record automatically',
  ignore: 'Do nothing',
}

/** What a settings file from before per-app policies means: ask for every app. */
export const ASK_FOR_EVERY_APP: MeetingPolicies = {
  zoom: 'ask',
  teams: 'ask',
  webex: 'ask',
  slack: 'ask',
  faceTime: 'ask',
  discord: 'ask',
  browser: 'ask',
}
