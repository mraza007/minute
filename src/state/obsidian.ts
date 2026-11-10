import type { ObsidianSettings } from '../ipc/types'

/** Mirrors `settings::ObsidianSettings::default()` on the Rust side. */
export const DEFAULT_OBSIDIAN_SETTINGS: ObsidianSettings = {
  enabled: false,
  vaultPath: '',
  folder: 'Meetings',
  fileNameTemplate: '{date} - {title}',
  addProperties: true,
  includeTranscript: false,
}
