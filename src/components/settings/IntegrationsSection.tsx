import { useEffect, useId, useState } from 'react'
import type { ObsidianPatch, ObsidianSettings } from '../../ipc/types'
import { describeSavedAt, localDay, previewObsidianPath } from '../../state/obsidian'
import { SettingSwitch, SettingsHeading } from './controls'

type SettingKey = keyof ObsidianSettings

export interface IntegrationsSectionProps {
  obsidian: ObsidianSettings
  /** Saves a partial change. Resolves `null` on success or the reason it was refused. */
  onSaveObsidian: (patch: ObsidianPatch) => Promise<string | null>
  /** Resolves `null` when the path is an existing folder, else the reason. */
  onCheckObsidianVault: (path: string) => Promise<string | null>
  /** Opens the folder picker. Resolves `null` when cancelled. A rejection shows under the Vault field. */
  onChooseObsidianVault: () => Promise<string | null>
  /** The newest saved note, for the "Last saved" line. */
  obsidianLastSave: { title: string; savedAt: string } | null
  /** A real note the file name preview is built from. */
  obsidianPreviewNote: { title: string; createdAt: string } | null
}

const SAMPLE_TITLE = 'Weekly sync'

interface DraftInputProps {
  id: string
  value: string
  onDraft?: (draft: string) => void
  onCommit: (draft: string) => void
  placeholder?: string
  invalid?: boolean
  describedBy?: string
}

/** A text field that saves on Enter or when it loses focus, and reports each keystroke for the live preview. */
function DraftInput({ id, value, onDraft, onCommit, placeholder, invalid, describedBy }: DraftInputProps) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      id={id}
      className="st-input"
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      aria-invalid={invalid ? true : undefined}
      aria-describedby={describedBy}
      onChange={event => {
        setDraft(event.target.value)
        onDraft?.(event.target.value)
      }}
      onBlur={() => {
        if (draft !== value) onCommit(draft)
      }}
      onKeyDown={event => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}

export function IntegrationsSection({
  obsidian,
  onSaveObsidian,
  onCheckObsidianVault,
  onChooseObsidianVault,
  obsidianLastSave,
  obsidianPreviewNote,
}: IntegrationsSectionProps) {
  const id = useId()
  const [errors, setErrors] = useState<Partial<Record<SettingKey, string>>>({})
  const [checkedVault, setCheckedVault] = useState<{ path: string; message: string | null } | null>(null)
  const [folderDraft, setFolderDraft] = useState(obsidian.folder)
  const [templateDraft, setTemplateDraft] = useState(obsidian.fileNameTemplate)
  useEffect(() => setFolderDraft(obsidian.folder), [obsidian.folder])
  useEffect(() => setTemplateDraft(obsidian.fileNameTemplate), [obsidian.fileNameTemplate])

  // The vault can move or vanish after it was chosen. Say so while the
  // integration is on, instead of waiting for a save to fail.
  useEffect(() => {
    if (!obsidian.enabled || obsidian.vaultPath.trim() === '') return
    let cancelled = false
    void onCheckObsidianVault(obsidian.vaultPath).then(message => {
      if (!cancelled) setCheckedVault({ path: obsidian.vaultPath, message })
    })
    return () => {
      cancelled = true
    }
  }, [obsidian.enabled, obsidian.vaultPath, onCheckObsidianVault])
  const vaultProblem = obsidian.enabled && checkedVault?.path === obsidian.vaultPath ? checkedVault.message : null

  async function save(key: SettingKey, patch: ObsidianPatch) {
    const message = await onSaveObsidian(patch)
    setErrors(current => ({ ...current, [key]: message ?? undefined }))
  }

  async function chooseVault() {
    let picked: string | null
    try {
      picked = await onChooseObsidianVault()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      setErrors(current => ({ ...current, vaultPath: `The folder picker did not open. ${reason}` }))
      return
    }
    if (picked !== null) await save('vaultPath', { vaultPath: picked })
  }

  // The saved file is named for the local day of the recording, so the preview is too.
  const previewDate = localDay(obsidianPreviewNote ? new Date(obsidianPreviewNote.createdAt) : new Date())
  const preview = previewObsidianPath(
    { folder: folderDraft, fileNameTemplate: templateDraft },
    obsidianPreviewNote?.title ?? SAMPLE_TITLE,
    previewDate,
  )
  const vaultError = errors.vaultPath ?? vaultProblem
  const folderError = errors.folder ?? (preview === null ? 'The folder cannot contain “..”.' : undefined)

  return (
    <div className="st-content">
      <SettingsHeading title="Integrations" />

      <div className="st-list">
        <div className="st-policy-switch" data-roomy="true">
          <SettingSwitch
            title="Save summaries to Obsidian"
            description="Minute writes one Markdown file to your vault after each summary."
            on={obsidian.enabled}
            onToggle={() => void save('enabled', { enabled: !obsidian.enabled })}
          />
          {errors.enabled && <p className="st-help st-field-error" data-tone="error" role="alert">{errors.enabled}</p>}
        </div>

        <div className="st-line st-field-line">
          <label htmlFor={`${id}-vault`}>Vault</label>
          <div className="st-field-body">
            <DraftInput
              id={`${id}-vault`}
              value={obsidian.vaultPath}
              placeholder="Choose your vault folder"
              invalid={Boolean(vaultError)}
              describedBy={vaultError ? `${id}-vault-error` : undefined}
              onCommit={path => void save('vaultPath', { vaultPath: path })}
            />
            <button type="button" className="st-btn" onClick={() => void chooseVault()}>
              Choose…
            </button>
          </div>
        </div>
        {vaultError && <p id={`${id}-vault-error`} className="st-help st-field-error" data-tone="error" role="alert">{vaultError}</p>}

        <div className="st-line st-field-line">
          <label htmlFor={`${id}-folder`}>Folder</label>
          <div className="st-field-body">
            <DraftInput
              id={`${id}-folder`}
              value={obsidian.folder}
              placeholder="Vault root"
              invalid={Boolean(folderError)}
              describedBy={folderError ? `${id}-folder-error` : undefined}
              onDraft={setFolderDraft}
              onCommit={folder => void save('folder', { folder })}
            />
          </div>
        </div>
        {folderError && <p id={`${id}-folder-error`} className="st-help st-field-error" data-tone="error" role="alert">{folderError}</p>}

        <div className="st-line st-field-line">
          <label htmlFor={`${id}-template`}>File name</label>
          <div className="st-field-body">
            <DraftInput
              id={`${id}-template`}
              value={obsidian.fileNameTemplate}
              invalid={Boolean(errors.fileNameTemplate)}
              describedBy={errors.fileNameTemplate ? `${id}-template-error` : undefined}
              onDraft={setTemplateDraft}
              onCommit={fileNameTemplate => void save('fileNameTemplate', { fileNameTemplate })}
            />
          </div>
        </div>
        {errors.fileNameTemplate && (
          <p id={`${id}-template-error`} className="st-help st-field-error" data-tone="error" role="alert">{errors.fileNameTemplate}</p>
        )}

        <div className="st-line st-field-line st-preview-line">
          <span className="st-field-name">Preview</span>
          <span className="st-line-meta" data-testid="obsidian-preview">{preview ?? '—'}</span>
        </div>
      </div>

      <div className="st-group">
        <SettingSwitch
          title="Add properties"
          description="Date, title, duration, and speakers as YAML frontmatter."
          on={obsidian.addProperties}
          onToggle={() => void save('addProperties', { addProperties: !obsidian.addProperties })}
        />
        <SettingSwitch
          title="Include the transcript"
          description="Adds the full transcript below the summary."
          on={obsidian.includeTranscript}
          onToggle={() => void save('includeTranscript', { includeTranscript: !obsidian.includeTranscript })}
        />
      </div>

      {obsidianLastSave && (
        <div className="st-status" data-tone="ok">
          <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Last saved: {obsidianLastSave.title}, {describeSavedAt(obsidianLastSave.savedAt)}</span>
        </div>
      )}
    </div>
  )
}
