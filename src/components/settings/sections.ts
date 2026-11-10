export const SETTINGS_SECTIONS = [
  { id: 'recording', label: 'Recording' },
  { id: 'summaries', label: 'Summaries' },
  { id: 'speakers', label: 'Speakers' },
  { id: 'models', label: 'Models' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'storage', label: 'Storage' },
  { id: 'about', label: 'About' },
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']
