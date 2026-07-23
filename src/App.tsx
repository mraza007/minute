import { useAppState } from './state/useAppState'
import { demoNotes } from './data/demo'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { NoteView } from './components/NoteView'
import { RecordingView } from './components/RecordingView'
import { SettingsView } from './components/SettingsView'

export default function App() {
  const s = useAppState()
  return (
    <div style={{ height: '100vh', minWidth: 1180, display: 'flex', flexDirection: 'column', fontSize: 13.5, lineHeight: 1.5, background: '#f2f0ee' }}>
      <TitleBar recording={s.view === 'recording'} recTime={s.recTime} onStartRec={s.startRec} />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Sidebar notes={demoNotes} sel={s.sel} onSelect={s.selectNote} view={s.view} onGoNotes={s.goNotes} onGoSettings={s.goSettings} />
        {s.view === 'notes' && <NoteView state={s} />}
        {s.view === 'recording' && <RecordingView paused={s.paused} togglePause={s.togglePause} stopRec={s.stopRec} />}
        {s.view === 'settings' && <SettingsView sttModel={s.sttModel} setSttModel={s.setSttModel} tDel={s.tDel} toggleDel={s.toggleDel} tEnc={s.tEnc} toggleEnc={s.toggleEnc} />}
      </div>
    </div>
  )
}
