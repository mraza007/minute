import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppState } from './state/useAppState'
import { summaryWaitCause, type SummaryWait } from './state/adapters'
import { useSidebarCollapsed } from './state/useSidebarCollapsed'
import { AppToolbar, SidebarReopen } from './components/AppToolbar'
import { ErrorBanner } from './components/ErrorBanner'
import { Sidebar } from './components/Sidebar'
import { NoteView } from './components/NoteView'
import { OnboardingView } from './components/OnboardingView'
import { RecordingView } from './components/RecordingView'
import { RecordingPreflight } from './components/RecordingPreflight'
import { SettingsNav } from './components/settings/SettingsNav'
import { SettingsView } from './components/settings/SettingsView'
import type { SettingsSectionId } from './components/settings/sections'
import { SearchPalette } from './components/SearchPalette'
import { useFocusAfterCommit } from './components/useFocusAfterCommit'
import { transcriptionModeOptions } from './components/transcriptionModes'

export default function App() {
  const s = useAppState()
  const {
    openSearch: openSearchState,
    closeSearch: closeSearchState,
    openRecordingPreflight: openRecordingPreflightState,
    closeRecordingPreflight: closeRecordingPreflightState,
    startRec,
  } = s
  const { collapsed: sidebarCollapsed, setCollapsed: setSidebarCollapsed } = useSidebarCollapsed()
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('recording')
  const { goSettings } = s
  /** Opens Settings on `section`. Every link that names a setting goes to the section that holds it. */
  const openSettings = useCallback((section: SettingsSectionId) => {
    setSettingsSection(section)
    goSettings()
  }, [goSettings])
  // Hiding or showing the sidebar unmounts the control that was pressed, so
  // focus moves to the control that undoes it.
  const showNotesButtonRef = useRef<HTMLButtonElement>(null)
  const collapseSidebarButtonRef = useRef<HTMLButtonElement>(null)
  const requestFocus = useFocusAfterCommit()
  const setSidebarCollapsedByUser = useCallback((collapsed: boolean) => {
    requestFocus(() => (collapsed ? showNotesButtonRef.current : collapseSidebarButtonRef.current))
    setSidebarCollapsed(collapsed)
  }, [requestFocus, setSidebarCollapsed])
  const searchReturnFocusRef = useRef<HTMLElement | null>(null)
  const preflightReturnFocusRef = useRef<HTMLElement | null>(null)
  const openSearch = useCallback(() => {
    searchReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    openSearchState()
  }, [openSearchState])
  const closeSearch = useCallback(() => {
    closeSearchState()
    requestAnimationFrame(() => searchReturnFocusRef.current?.focus())
  }, [closeSearchState])
  const openRecordingPreflight = useCallback(() => {
    preflightReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    openRecordingPreflightState()
  }, [openRecordingPreflightState])
  const closeRecordingPreflight = useCallback(() => {
    closeRecordingPreflightState()
    requestAnimationFrame(() => preflightReturnFocusRef.current?.focus())
  }, [closeRecordingPreflightState])
  const { exportNotes, saveNoteToObsidian } = s
  const exportNote = useCallback((id: string) => {
    // A failure is already on the error banner.
    exportNotes([id]).catch(() => {})
  }, [exportNotes])
  const saveToObsidian = useCallback((id: string) => {
    void saveNoteToObsidian(id)
  }, [saveNoteToObsidian])
  const startRecording = useCallback((title: string | null) => {
    preflightReturnFocusRef.current = null
    startRec(title)
  }, [startRec])
  const transcriptionModes = useMemo(
    () => transcriptionModeOptions(s.models, s.sttModel, s.hardware, s.recommendation),
    [s.models, s.sttModel, s.hardware, s.recommendation],
  )

  // ⌘K / ⌘F anywhere opens the search palette — the palette steals focus
  // (autofocuses its input) rather than checking what's currently focused,
  // per .impeccable.md's "quiet by default" but still-discoverable search.
  // A second ⌘K/⌘F while it's already open toggles it closed again, same as
  // most command-palette conventions. Registered once at app-mount level
  // (not gated on `view`) so the shortcut works from every screen,
  // including mid-recording.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.metaKey || (e.key !== 'k' && e.key !== 'f')) return
      e.preventDefault()
      // The preflight owns focus while it is open. Mounting SearchPalette
      // behind a second aria-modal dialog would create two competing focus
      // traps even though the darker scrim makes only one visually obvious.
      if (s.recordingPreflightOpen) return
      if (s.searchOpen) {
        closeSearch()
      } else {
        openSearch()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // Deliberately depends on the three fields this effect actually reads/
    // calls, not the whole `s` object — `s` is a fresh object every
    // useAppState render, and depending on it would resubscribe the
    // listener constantly instead of only when open state actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeSearch, openSearch, s.searchOpen, s.recordingPreflightOpen])

  // Suppress the webview's own right-click menu ("Reload", …) everywhere
  // except editable fields, which keep the native cut/copy/paste menu. Note
  // rows offer their own menu (see Sidebar); this runs after that handler's
  // bubble phase, so both compose.
  useEffect(() => {
    function handleContextMenu(e: MouseEvent) {
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      e.preventDefault()
    }
    document.addEventListener('contextmenu', handleContextMenu)
    return () => document.removeEventListener('contextmenu', handleContextMenu)
  }, [])

  // ⌘/ opens the shortcut list, which lives under Settings > About. Not
  // before the app is open: Settings from onboarding would lead into an app
  // with no transcription model.
  const appOpen = s.view !== 'loading' && s.view !== 'onboarding'
  useEffect(() => {
    function handleShortcutList(event: KeyboardEvent) {
      if (!event.metaKey || event.key !== '/') return
      event.preventDefault()
      if (!appOpen || s.recordingPreflightOpen || s.searchOpen) return
      openSettings('about')
    }
    window.addEventListener('keydown', handleShortcutList)
    return () => window.removeEventListener('keydown', handleShortcutList)
  }, [appOpen, openSettings, s.recordingPreflightOpen, s.searchOpen])

  // `null` is the pick-a-note state: an empty library, or an explicit
  // deselect ("All notes", issue #24).
  const selectedNoteMeta = s.selectedNoteMeta

  // NoteView distinguishes 'idle' | 'queued' | 'running' |
  // 'error' — `summaryStatus`'s `'done'` (and "no event seen this session")
  // both collapse to 'idle' here, since 'done' carries no special UI once
  // it's landed (the note just shows the real summary at that point).
  // `'queued'` (issue #11) does pass through: a note waiting its turn looks
  // identical to an un-summarized one otherwise, and offering Generate for
  // work that's already scheduled is how you get it summarized twice.
  const rawSummaryEventState = selectedNoteMeta ? s.summaryStatus[selectedNoteMeta.id] : undefined
  const selectedSummaryStatus =
    rawSummaryEventState === 'queued' || rawSummaryEventState === 'running' || rawSummaryEventState === 'error'
      ? rawSummaryEventState
      : 'idle'
  const selectedSummaryWait: SummaryWait | null = selectedNoteMeta && selectedSummaryStatus === 'queued'
    ? {
        queuedAt: s.summaryQueuedAt[selectedNoteMeta.id] ?? null,
        style: s.tSummaryStyle,
        cause: summaryWaitCause(
          selectedNoteMeta.id,
          s.isRecording,
          s.summaryStatus,
          s.summaryStartsNext[selectedNoteMeta.id] === true,
        ),
      }
    : null

  // Same collapse for speaker detection (`diar-status`): 'done' and "no
  // event" are both 'idle' — a finished pass just shows the relabeled
  // transcript.
  const rawDiarEventState = selectedNoteMeta ? s.diarStatus[selectedNoteMeta.id] : undefined
  const selectedDiarStatus = rawDiarEventState === 'running' || rawDiarEventState === 'error' ? rawDiarEventState : 'idle'

  // The "Detect speakers" affordance only appears once both diarization
  // models are actually installed (the Settings toggle downloads the pair);
  // `every` alone would be vacuously true on a catalog without them.
  const diarModels = s.models.filter(m => m.kind === 'diarization')
  const canDetectSpeakers = diarModels.length > 0 && diarModels.every(m => m.state === 'installed')

  // The Obsidian file name preview uses the newest note, so it shows a name the user recognizes.
  const obsidianPreviewNote = s.notes.reduce<(typeof s.notes)[number] | null>(
    (newest, note) => (newest === null || note.createdAt > newest.createdAt ? note : newest),
    null,
  )

  // While the sidebar is hidden (a narrow window, or the manual collapse),
  // the toolbar carries the way back to it and the record button it held.
  const toolbarLead = sidebarCollapsed ? (
    <SidebarReopen
      isRecording={s.isRecording}
      showNotesButtonRef={showNotesButtonRef}
      onShowNotes={() => setSidebarCollapsedByUser(false)}
      onStartRecording={openRecordingPreflight}
      onReturnToRecording={s.goRecording}
    />
  ) : undefined

  if (s.view === 'loading') {
    return (
      <div
        className="app-paper"
        style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--panel)', fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-muted)' }}
      >
        Loading…
      </div>
    )
  }

  if (s.view === 'onboarding') {
    return (
      <>
        <OnboardingView
          models={s.models}
          hardware={s.hardware}
          recommendation={s.recommendation}
          downloads={s.downloads}
          onDownload={s.downloadModel}
          onCancel={s.cancelDownload}
          onStart={s.completeOnboarding}
        />
        <ErrorBanner message={s.lastError} />
      </>
    )
  }

  return (
    <>
      {/* The native window still enforces its 860px minimum. Capping the
          document minimum at 100vw lets browser zoom and enlarged-text
          layouts reflow instead of creating a second horizontal canvas. */}
      <div className="app-paper" style={{ height: '100vh', minWidth: 'min(860px, 100vw)', display: 'flex', fontSize: 13, lineHeight: 1.5, background: 'var(--panel)' }}>
        {/* "Quiet by default, loud when recording" (.impeccable.md), spent in
            one place: a single accent hairline along the very top edge of the
            window. It's visible from the corner of the eye no matter which
            view is open or where the window sits, and it costs no layout —
            which is what lets the rest of the recording UI stay calm. */}
        {s.isRecording && !s.stopping && <div className="rec-edge" aria-hidden="true" />}
        <Sidebar
          notes={s.sidebarNotes}
          selectedNoteId={s.selectedNoteId}
          onSelect={s.selectNoteById}
          view={s.view}
          onGoNotes={s.goNotes}
          onGoSettings={s.goSettings}
          statsLine={s.statsLine}
          onOpenPalette={openSearch}
          onStartRecording={openRecordingPreflight}
          isRecording={s.isRecording}
          stopping={s.stopping}
          recTime={s.recTime}
          onReturnToRecording={s.goRecording}
          summaryStatus={s.summaryStatus}
          onTogglePinned={s.setNotePinned}
          onBulkExport={s.exportNotes}
          onBulkDelete={s.deleteNotes}
          onRenameNote={s.renameNote}
          onRevealNote={s.revealNote}
          collapsed={sidebarCollapsed || s.view === 'settings'}
          onSetCollapsed={setSidebarCollapsedByUser}
          collapseButtonRef={collapseSidebarButtonRef}
        />
        {s.view === 'settings' && (
          <SettingsNav
            section={settingsSection}
            onSelect={setSettingsSection}
            onBack={s.backToNotes}
            recordingTime={s.isRecording ? s.recTime : null}
            onReturnToRecording={s.goRecording}
          />
        )}
        <div className="app-main">
          {s.view === 'settings' && <AppToolbar />}
          {s.view === 'notes' && (
            <NoteView
              meta={selectedNoteMeta}
              hasNotes={s.notes.length > 0}
              selectedMeta={s.selectedMeta}
              selectedTranscript={s.selectedTranscript}
              selectedSummary={s.selectedSummary}
              selectedMarkdown={s.selectedMarkdown}
              selectedAudioPath={s.selectedAudioPath}
              selectedNoteStorage={s.selectedNoteStorage}
              transcriptLoading={s.transcriptLoading}
              pendingSeek={s.pendingSeek}
              onPendingSeekApplied={s.clearPendingSeek}
              sttStatus={s.sttStatus}
              sttStatusNoteId={s.sttStatusNoteId}
              summaryStatus={selectedSummaryStatus}
              summaryError={selectedNoteMeta ? s.summaryError[selectedNoteMeta.id] : undefined}
              summaryWait={selectedSummaryWait}
              diarStatus={selectedDiarStatus}
              diarError={selectedNoteMeta ? s.diarError[selectedNoteMeta.id] : undefined}
              canDetectSpeakers={canDetectSpeakers}
              onDetectSpeakers={s.detectSpeakers}
              llmInstalled={s.llmInstalled}
              llmModelName={s.llmModelDisplayName}
              askHistory={s.askHistory}
              askStatus={s.askStatus}
              llmBusy={s.llmBusy}
              onRename={s.renameNote}
              onDelete={s.deleteNote}
              onReveal={s.revealNote}
              onExport={exportNote}
              obsidianEnabled={s.tObsidian.enabled}
              obsidianSaving={selectedNoteMeta !== null && s.obsidianSavingId === selectedNoteMeta.id}
              onSaveToObsidian={saveToObsidian}
              toolbarLead={toolbarLead}
              onCopyError={s.reportError}
              onToggleActionItem={s.toggleActionItem}
              onRegenerateSummary={s.regenerateSummary}
              onCancelSummary={s.cancelSummary}
              onSummarizeNow={s.summarizeNow}
              onAsk={s.askQuestion}
              onOpenSettings={openSettings}
              onSetPinned={s.setNotePinned}
              onAddMarker={s.addNoteMarker}
              onUpdateMarker={s.updateNoteMarker}
              onDeleteMarker={s.deleteNoteMarker}
              onRenameSpeaker={s.renameSpeaker}
              onDismissSpeakerSuggestion={s.dismissSpeakerSuggestion}
              onMergeSpeakers={s.mergeSpeakers}
              onMarkSpeakerUnknown={s.markSpeakerUnknown}
              onAssignUnknownTurns={s.assignUnknownTurns}
              onUndoSpeakerMerge={s.undoSpeakerMerge}
              onDeleteAudio={s.deleteSelectedNoteAudio}
              onStartRecording={openRecordingPreflight}
              processingFailure={s.processingFailure}
              onRetryProcessing={s.retryProcessingFailure}
              onDismissProcessing={s.dismissProcessingFailure}
              justRecorded={selectedNoteMeta !== null && selectedNoteMeta.id === s.lastRecordedNoteId}
              summaryStyle={s.tSummaryStyle}
            />
          )}
          {s.view === 'recording' && (
            <RecordingView
              liveSegments={s.liveSegments}
              paused={s.paused}
              togglePause={s.togglePause}
              stopRec={s.stopRec}
              stopping={s.stopping}
              processingStage={s.processingStage}
              sttStatus={s.sttStatus}
              sttError={s.sttError}
              modelName={s.sttModelDisplayName}
              systemAudioActive={s.systemAudioActive}
              microphoneName={s.microphoneName}
              captureHealth={s.captureHealth}
              elapsed={s.recElapsed}
              title={s.recordingTitle}
              renameTitle={s.renameActiveRecording}
              markers={s.recordingMarkers}
              addMarker={s.addRecordingMarker}
              processingFailure={s.processingFailure}
              onRetryProcessing={s.retryProcessingFailure}
              onDismissProcessingFailure={s.dismissProcessingFailure}
              autoStopSeconds={s.autoStopSeconds}
              onKeepRecording={s.keepRecording}
              quietSecs={s.quietSecs}
              canRestartWithSystemAudio={s.sysAudioAvailability === 'ready'}
              onRestartWithSystemAudio={s.restartWithSystemAudio}
              origin={s.recOrigin}
              onOpenSettings={openSettings}
              speakersExpected={s.tDetectSpeakers && canDetectSpeakers}
              summaryExpected={s.llmInstalled}
              summaryStyle={s.tSummaryStyle}
              toolbarLead={toolbarLead}
            />
          )}
          {s.view === 'settings' && (
            <SettingsView
              section={settingsSection}
              meetingPolicies={s.tMeetingPolicies}
              onSetMeetingPolicy={s.setMeetingPolicy}
              obsidian={s.tObsidian}
              onSaveObsidian={s.saveObsidianSettings}
              onCheckObsidianVault={s.checkObsidianVault}
              onChooseObsidianVault={s.chooseObsidianVault}
              obsidianLastSave={s.obsidianLastSave}
              obsidianPreviewNote={obsidianPreviewNote}
              models={s.models}
              hardware={s.hardware}
              recommendation={s.recommendation}
              downloads={s.downloads}
              sttModel={s.sttModel}
              setSttModel={s.setSttModel}
              llmModel={s.llmModel}
              setLlmModel={s.setLlmModel}
              downloadModel={s.downloadModel}
              cancelDownload={s.cancelDownload}
              deleteModel={s.deleteModel}
              huggingFace={s.huggingFace}
              storage={s.storage}
              libraryPath={s.libraryInfo?.displayPath ?? null}
              libraryTitle={s.libraryInfo?.path ?? null}
              movingLibrary={s.movingLibrary}
              onChangeLibraryFolder={s.changeLibraryFolder}
              noteCount={s.notes.length}
              tDel={s.tDel}
              toggleDel={s.toggleDel}
              compressAudioAfterDays={s.tCompressAudioAfterDays}
              setCompressAudioAfterDays={s.setCompressAudioAfterDays}
              meetingDetection={s.tMeetingDetection}
              toggleMeetingDetection={s.toggleMeetingDetection}
              captureSystemAudio={s.tCaptureSystemAudio}
              toggleCaptureSystemAudio={s.toggleCaptureSystemAudio}
              detectSpeakers={s.tDetectSpeakers}
              toggleDetectSpeakers={s.toggleDetectSpeakers}
              speakerProfiles={s.tSpeakerProfiles}
              toggleSpeakerProfiles={s.toggleSpeakerProfiles}
              autoApplySpeakerNames={s.tAutoApplySpeakerNames}
              toggleAutoApplySpeakerNames={s.toggleAutoApplySpeakerNames}
              voiceProfiles={s.voiceProfiles}
              onDeleteVoiceProfile={s.deleteVoiceProfile}
              autoStopRecording={s.tAutoStopRecording}
              toggleAutoStopRecording={s.toggleAutoStopRecording}
              sysAudioAvailability={s.sysAudioAvailability}
              onRequestSysAudioPermission={s.requestSysAudioPermission}
              onExportDiagnostics={s.exportDiagnostics}
              summaryStyle={s.tSummaryStyle}
              setSummaryStyle={s.setSummaryStyle}
              llmContextTokens={s.tLlmContextTokens}
              setLlmContextTokens={s.setLlmContextTokens}
              summaryInstructions={s.tSummaryInstructions}
              setSummaryInstructions={s.setSummaryInstructions}
              appVersion={s.appVersion}
              autoUpdateCheck={s.tAutoUpdateCheck}
              toggleAutoUpdateCheck={s.toggleAutoUpdateCheck}
              updateAvailable={s.updateAvailable}
              updateInstalling={s.updateInstalling}
              updateCheckStatus={s.updateCheckStatus}
              onCheckForUpdates={s.checkForUpdatesNow}
              onInstallUpdate={() => void s.installUpdate()}
            />
          )}
        </div>
      </div>
      {s.searchOpen && (
        <SearchPalette
          notes={s.notes}
          search={s.searchNotes}
          onClose={closeSearch}
          onOpenTitleHit={noteId => {
            s.selectNoteById(noteId)
            closeSearch()
          }}
          onOpenTranscriptHit={(noteId, seconds) => {
            s.requestSeek(noteId, seconds)
            closeSearch()
          }}
        />
      )}
      {s.recordingPreflightOpen && (
        <RecordingPreflight
          microphoneDevices={s.preflightMicrophoneDevices}
          selectedMicrophoneId={s.selectedPreflightMicrophoneId}
          microphoneLoading={s.preflightMicrophoneLoading}
          microphonePermission={s.preflightMicrophonePermission}
          requestingMicrophonePermission={s.requestingMicrophonePermission}
          transcriptionModes={transcriptionModes}
          systemAudioEnabled={s.tCaptureSystemAudio}
          sysAudioAvailability={s.sysAudioAvailability}
          starting={s.recordingStarting}
          onSelectMicrophone={s.selectPreflightMicrophone}
          onRequestMicrophonePermission={s.requestMicrophonePermission}
          onSelectTranscriptionModel={s.setSttModel}
          onOpenSettings={() => {
            closeRecordingPreflightState()
            openSettings('models')
          }}
          onToggleSystemAudio={s.toggleCaptureSystemAudio}
          onRequestSysAudioPermission={s.requestSysAudioPermission}
          onClose={closeRecordingPreflight}
          onStart={startRecording}
        />
      )}
      {s.deletedNoteUndo && (
        <div className="action-toast" role="status">
          <span>
            {s.deletedNoteUndo.length === 1
              ? `“${s.deletedNoteUndo[0].title}” moved to recovery.`
              : `${s.deletedNoteUndo.length} notes moved to recovery.`}
          </span>
          <button type="button" onClick={() => void s.undoDeletedNotes()}>Undo</button>
          <button type="button" className="icon-btn" aria-label="Dismiss undo" onClick={s.dismissDeletedNoteUndo}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      )}
      {!s.deletedNoteUndo && s.libraryNotice && (
        <div className="action-toast" role="status">
          <span>{s.libraryNotice}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss notification" onClick={s.dismissLibraryNotice}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      )}
      <ErrorBanner message={s.lastError} />
    </>
  )
}
