import { useEffect, useRef, useState } from 'react'
import type { ActionItem, NoteTab, View } from '../types'
import { initialActions } from '../data/demo'

export function useAppState() {
  const [view, setView] = useState<View>('notes')
  const [sel, setSel] = useState(2)
  const [recSeconds, setRecSeconds] = useState(872)
  const [paused, setPaused] = useState(false)
  const [asked, setAsked] = useState(false)
  const [askDraft, setAskDraft] = useState('')
  const [sttModel, setSttModel] = useState('medium')
  const [tDel, setTDel] = useState(true)
  const [tEnc, setTEnc] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const [noteTab, setNoteTab] = useState<NoteTab>('transcript')
  const [actions, setActions] = useState<ActionItem[]>(initialActions)
  const sumTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    if (view !== 'recording' || paused) return
    const t = setInterval(() => setRecSeconds(s => s + 1), 1000)
    return () => clearInterval(t)
  }, [view, paused])

  useEffect(() => () => clearTimeout(sumTimeout.current), [])

  const mm = Math.floor(recSeconds / 60)
  const ss = recSeconds % 60

  return {
    view, sel, recSeconds, paused, asked, askDraft, sttModel,
    tDel, tEnc, summarizing, noteTab, actions,
    recTime: `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`,
    askText: askDraft || 'What did we promise Acme?',
    goNotes: () => setView('notes'),
    goSettings: () => setView('settings'),
    startRec: () => { setView('recording'); setRecSeconds(872); setPaused(false) },
    stopRec: () => {
      setView('notes'); setSel(0); setSummarizing(true)
      clearTimeout(sumTimeout.current)
      sumTimeout.current = setTimeout(() => setSummarizing(false), 3200)
    },
    togglePause: () => setPaused(p => !p),
    selectNote: setSel,
    setNoteTab,
    toggleAction: (i: number) =>
      setActions(a => a.map((x, j) => (j === i ? { ...x, done: !x.done } : x))),
    setAskDraft,
    ask: () => setAsked(true),
    setSttModel,
    toggleDel: () => setTDel(v => !v),
    toggleEnc: () => setTEnc(v => !v),
  }
}

export type AppState = ReturnType<typeof useAppState>
