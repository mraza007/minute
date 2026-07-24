import { useAppState } from './state/useAppState'
import { ErrorBanner } from './components/ErrorBanner'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { NoteView } from './components/NoteView'
import { OnboardingView } from './components/OnboardingView'
import { RecordingView } from './components/RecordingView'
import { SettingsView } from './components/SettingsView'

export default function App() {
  const s = useAppState()

  if (s.view === 'loading') {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f2f0ee', fontSize: 13, color: '#8d867f' }}>
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
      <div style={{ height: '100vh', minWidth: 1180, display: 'flex', flexDirection: 'column', fontSize: 13.5, lineHeight: 1.5, background: '#f2f0ee' }}>
        <TitleBar isRecording={s.isRecording} recTime={s.recTime} onStartRec={s.startRec} onReturnToRecording={s.goRecording} />
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <Sidebar
            notes={s.sidebarNotes}
            sel={s.sel}
            onSelect={s.selectNote}
            view={s.view}
            onGoNotes={s.goNotes}
            onGoSettings={s.goSettings}
            statsLine={s.statsLine}
          />
          {s.view === 'notes' && <NoteView state={s} />}
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
              tEnc={s.tEnc}
              toggleEnc={s.toggleEnc}
            />
          )}
        </div>
      </div>
      <ErrorBanner message={s.lastError} />
    </>
  )
}
