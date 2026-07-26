import { useEffect } from 'react'
import { useAppState } from './state/useAppState'
import { ErrorBanner } from './components/ErrorBanner'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { NoteView } from './components/NoteView'
import { OnboardingView } from './components/OnboardingView'
import { RecordingView } from './components/RecordingView'
import { SettingsView } from './components/SettingsView'
import { SearchPalette } from './components/SearchPalette'

export default function App() {
  const s = useAppState()

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
      if (s.searchOpen) {
        s.closeSearch()
      } else {
        s.openSearch()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // Deliberately depends on the three fields this effect actually reads/
    // calls, not the whole `s` object — `s` is a fresh object every
    // useAppState render, and depending on it would resubscribe the
    // listener constantly instead of only when open state actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.searchOpen, s.openSearch, s.closeSearch])

  // The selected note's list-level metadata — the same "notes[sel], falling
  // back to notes[0]" rule NoteView used to apply internally before its
  // narrow-props refactor (Stage 3 Task 5); computed once here since
  // several of the props below (summaryStatus/summaryError) key off its id.
  const selectedNoteMeta = s.notes[s.sel] ?? s.notes[0] ?? null

  // NoteView/AiNotesPanel only distinguish 'idle' | 'running' | 'error' —
  // `summaryStatus`'s `'done'` (and "no event seen this session") both
  // collapse to 'idle' here, since 'done' carries no special UI once it's
  // landed (the panel just shows the real summary at that point).
  const rawSummaryEventState = selectedNoteMeta ? s.summaryStatus[selectedNoteMeta.id] : undefined
  const selectedSummaryStatus = rawSummaryEventState === 'running' || rawSummaryEventState === 'error' ? rawSummaryEventState : 'idle'

  if (s.view === 'loading') {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--panel)', fontSize: 13, color: 'var(--ink-muted)' }}>
        Loading…
      </div>
    )
  }

  if (s.view === 'onboarding') {
    return (
      <>
        <OnboardingView
          models={s.models}
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
      {/* minWidth mirrors src-tauri/tauri.conf.json's windows[0].minWidth — keep both in sync, they can't reference each other across the JS/Rust boundary. */}
      <div style={{ height: '100vh', minWidth: 1180, display: 'flex', flexDirection: 'column', fontSize: 13, lineHeight: 1.5, background: 'var(--panel)' }}>
        <TitleBar isRecording={s.isRecording} recTime={s.recTime} onStartRec={s.startRec} onReturnToRecording={s.goRecording} />
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <Sidebar
            notes={s.sidebarNotes}
            selectedNoteId={s.selectedNoteId}
            onSelect={s.selectNoteById}
            view={s.view}
            onGoNotes={s.goNotes}
            onGoSettings={s.goSettings}
            statsLine={s.statsLine}
            searchQuery={s.sidebarQuery}
            onSearchQueryChange={s.setSidebarQuery}
            matchedNoteIds={s.sidebarMatchedIds}
            onOpenPalette={s.openSearch}
          />
          {s.view === 'notes' && (
            <NoteView
              meta={selectedNoteMeta}
              selectedMeta={s.selectedMeta}
              selectedTranscript={s.selectedTranscript}
              selectedSummary={s.selectedSummary}
              selectedMarkdown={s.selectedMarkdown}
              selectedAudioPath={s.selectedAudioPath}
              transcriptLoading={s.transcriptLoading}
              pendingSeek={s.pendingSeek}
              onPendingSeekApplied={s.clearPendingSeek}
              noteTab={s.noteTab}
              setNoteTab={s.setNoteTab}
              sttStatus={s.sttStatus}
              sttStatusNoteId={s.sttStatusNoteId}
              summaryStatus={selectedSummaryStatus}
              summaryError={selectedNoteMeta ? s.summaryError[selectedNoteMeta.id] : undefined}
              llmInstalled={s.llmInstalled}
              llmModelName={s.llmModelDisplayName}
              askHistory={s.askHistory}
              askStatus={s.askStatus}
              llmBusy={s.llmBusy}
              onRename={s.renameNote}
              onDelete={s.deleteNote}
              onReveal={s.revealNote}
              onCopyError={s.reportError}
              onToggleActionItem={s.toggleActionItem}
              onRegenerateSummary={s.regenerateSummary}
              onAsk={s.askQuestion}
              onGoSettings={s.goSettings}
            />
          )}
          {s.view === 'recording' && (
            <RecordingView
              liveSegments={s.liveSegments}
              paused={s.paused}
              togglePause={s.togglePause}
              stopRec={s.stopRec}
              stopping={s.stopping}
              sttStatus={s.sttStatus}
              sttError={s.sttError}
              modelName={s.sttModelDisplayName}
              systemAudioActive={s.systemAudioActive}
            />
          )}
          {s.view === 'settings' && (
            <SettingsView
              models={s.models}
              downloads={s.downloads}
              sttModel={s.sttModel}
              setSttModel={s.setSttModel}
              llmModel={s.llmModel}
              setLlmModel={s.setLlmModel}
              downloadModel={s.downloadModel}
              cancelDownload={s.cancelDownload}
              deleteModel={s.deleteModel}
              storage={s.storage}
              noteCount={s.notes.length}
              tDel={s.tDel}
              toggleDel={s.toggleDel}
              meetingDetection={s.tMeetingDetection}
              toggleMeetingDetection={s.toggleMeetingDetection}
              captureSystemAudio={s.tCaptureSystemAudio}
              toggleCaptureSystemAudio={s.toggleCaptureSystemAudio}
              sysAudioAvailability={s.sysAudioAvailability}
              onRequestSysAudioPermission={s.requestSysAudioPermission}
            />
          )}
        </div>
      </div>
      {s.searchOpen && (
        <SearchPalette
          notes={s.notes}
          search={s.searchNotes}
          onClose={s.closeSearch}
          onOpenTitleHit={noteId => {
            s.selectNoteById(noteId)
            s.closeSearch()
          }}
          onOpenTranscriptHit={(noteId, seconds) => {
            s.requestSeek(noteId, seconds)
            s.closeSearch()
          }}
        />
      )}
      <ErrorBanner message={s.lastError} />
    </>
  )
}
