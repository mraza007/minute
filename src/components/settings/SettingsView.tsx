import { AboutSection, type AboutSectionProps } from './AboutSection'
import { IntegrationsSection, type IntegrationsSectionProps } from './IntegrationsSection'
import { ModelsSection, type ModelsSectionProps } from './ModelsSection'
import { RecordingSection, type RecordingSectionProps } from './RecordingSection'
import { SpeakersSection, type SpeakersSectionProps } from './SpeakersSection'
import { StorageSection, type StorageSectionProps } from './StorageSection'
import { SummariesSection, type SummariesSectionProps } from './SummariesSection'
import type { SettingsSectionId } from './sections'
import './settings.css'

export type SettingsViewProps = { section: SettingsSectionId } & RecordingSectionProps &
  SummariesSectionProps &
  SpeakersSectionProps &
  ModelsSectionProps &
  IntegrationsSectionProps &
  StorageSectionProps &
  AboutSectionProps

/** The page for the section chosen in the left nav. Each section owns its own layout and settings. */
export function SettingsView(props: SettingsViewProps) {
  return (
    <main className="settings-page">
      <div className="settings-page-inner">
        {props.section === 'recording' && <RecordingSection {...props} />}
        {props.section === 'summaries' && <SummariesSection {...props} />}
        {props.section === 'speakers' && <SpeakersSection {...props} />}
        {props.section === 'models' && <ModelsSection {...props} />}
        {props.section === 'integrations' && <IntegrationsSection {...props} />}
        {props.section === 'storage' && <StorageSection {...props} />}
        {props.section === 'about' && <AboutSection {...props} />}
      </div>
    </main>
  )
}
