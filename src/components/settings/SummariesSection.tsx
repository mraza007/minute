import { useEffect, useState } from 'react'
import type { SummaryStyle } from '../../ipc/types'
import { Segmented, SettingRow, SettingSelect, SettingsHeading } from './controls'

export interface SummariesSectionProps {
  /** Adjusts prompt guidance and response length backend-side. */
  summaryStyle: SummaryStyle
  setSummaryStyle: (style: SummaryStyle) => void
  /** Summarizer context window in tokens; `null` means automatic (sized to this Mac's memory). */
  llmContextTokens: number | null
  setLlmContextTokens: (tokens: number | null) => void
  /** Free text added to the summary prompt, saved with the Save button. */
  summaryInstructions: string
  setSummaryInstructions: (text: string) => void
}

const LENGTH_OPTIONS: { value: SummaryStyle; label: string }[] = [
  { value: 'short', label: 'Short' },
  { value: 'standard', label: 'Standard' },
  { value: 'detailed', label: 'Detailed' },
]

const CONTEXT_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'Automatic' },
  { value: 8_192, label: '8k tokens' },
  { value: 16_384, label: '16k tokens' },
  { value: 32_768, label: '32k tokens' },
]

export function SummariesSection({
  summaryStyle,
  setSummaryStyle,
  llmContextTokens,
  setLlmContextTokens,
  summaryInstructions,
  setSummaryInstructions,
}: SummariesSectionProps) {
  // Saved by the Save button, not per keystroke (one settings write per
  // character) or on blur (an invisible save). Reseeded when the stored
  // value changes underneath, for example when the first load finishes.
  const [draft, setDraft] = useState(summaryInstructions)
  useEffect(() => setDraft(summaryInstructions), [summaryInstructions])
  const unchanged = draft === summaryInstructions

  return (
    <div className="st-content">
      <SettingsHeading title="Summaries" />

      <div className="st-field">
        <h2 className="st-label">Length</h2>
        <Segmented label="Summary length" options={LENGTH_OPTIONS} value={summaryStyle} onChange={setSummaryStyle} />
        <p className="st-help">
          Short keeps the essentials. Detailed adds a section for each topic. A new length applies to the next summary.
          Regenerate a note to restyle it.
        </p>
      </div>

      <div className="st-field">
        <label className="st-label" htmlFor="summary-custom-instructions">Your instructions</label>
        <textarea
          id="summary-custom-instructions"
          className="st-textarea"
          value={draft}
          maxLength={2000}
          rows={3}
          placeholder="e.g. Write the summary in German. Focus on engineering decisions and deadlines."
          onChange={event => setDraft(event.target.value)}
        />
        <div className="st-actions">
          <button type="button" className="st-btn" disabled={unchanged} onClick={() => setSummaryInstructions(draft)}>
            Save
          </button>
          {unchanged && summaryInstructions !== '' && <span className="st-help">Saved</span>}
        </div>
        <p className="st-help">
          Minute adds this to every summary request. The structure (overview, decisions, action items) stays the same.
        </p>
      </div>

      <div className="st-group" data-ruled="true">
        <SettingRow
          title="Context size"
          description="Automatic fits the context window to this Mac's memory. A larger window reads longer meetings whole but uses more memory."
        >
          <SettingSelect
            label="Context size"
            options={CONTEXT_OPTIONS}
            value={llmContextTokens}
            onChange={setLlmContextTokens}
            width={140}
          />
        </SettingRow>
      </div>
    </div>
  )
}
