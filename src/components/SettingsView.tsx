import type { CSSProperties } from 'react'
import { sttModels } from '../data/demo'
import { Toggle } from './Toggle'

export interface SettingsViewProps {
  sttModel: string
  setSttModel: (id: string) => void
  tDel: boolean
  toggleDel: () => void
  tEnc: boolean
  toggleEnc: () => void
}

const cardStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid rgba(0,0,0,.07)',
  borderRadius: 14,
  boxShadow: '0 1px 3px rgba(0,0,0,.04)',
  overflow: 'hidden',
}

const cardHeaderStyle: CSSProperties = {
  padding: '16px 20px 4px',
  fontWeight: 700,
  fontSize: 14,
}

export function SettingsView({ sttModel, setSttModel, tDel, toggleDel, tEnc, toggleEnc }: SettingsViewProps) {
  return (
    <div style={{ flex: 1, overflow: 'auto', background: '#f7f6f4' }}>
      <div style={{ maxWidth: 760, padding: '28px 36px 40px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <h1 style={{ margin: 0, fontWeight: 700, fontSize: 22, letterSpacing: '-.02em' }}>Settings</h1>

        <div style={{ background: '#1c1a18', color: '#fff', borderRadius: 16, padding: '24px 28px', boxShadow: '0 2px 8px rgba(0,0,0,.15)' }}>
          <div style={{ fontWeight: 700, fontSize: 19, letterSpacing: '-.01em' }}>Nothing leaves this machine.</div>
          <div style={{ marginTop: 6, fontSize: 13.5, lineHeight: 1.6, color: 'rgba(255,255,255,.75)', maxWidth: 520 }}>
            No account. No cloud. No network permission. Transcription and summarization run entirely on your hardware — pull the Wi-Fi and everything still works.
          </div>
        </div>

        <div style={cardStyle}>
          <div style={cardHeaderStyle}>Transcription model</div>
          <div
            role="radiogroup"
            aria-label="Transcription model"
            style={{ padding: '12px 20px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            {sttModels.map(m => {
              const selected = sttModel === m.id
              return (
                <button
                  key={m.id}
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setSttModel(m.id)}
                  className="model-card"
                  style={{
                    display: 'flex',
                    gap: 12,
                    alignItems: 'flex-start',
                    width: '100%',
                    border: selected ? '1.5px solid #e04430' : '1px solid rgba(0,0,0,.1)',
                    background: selected ? '#fff6f4' : '#fff',
                    borderRadius: 10,
                    padding: selected ? '11.5px 13.5px' : '12px 14px',
                    cursor: 'pointer',
                    fontSize: 13,
                    lineHeight: 1.5,
                    transition: 'border-color .15s, background .15s',
                    fontFamily: 'inherit',
                    textAlign: 'left',
                    color: 'inherit',
                  }}
                >
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      flex: 'none',
                      marginTop: 2,
                      borderRadius: '50%',
                      boxSizing: 'border-box',
                      background: '#fff',
                      border: selected ? '5px solid #e04430' : '1.5px solid #b0a9a2',
                      transition: 'border .15s',
                    }}
                  />
                  <span>
                    <b>{m.name}</b> — {m.desc}
                    <br />
                    <span style={{ fontSize: 12, color: selected ? '#b3200c' : '#9a938c', fontWeight: selected ? 600 : 400 }}>
                      {selected ? m.subOn : m.sub}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <div style={cardStyle}>
          <div style={cardHeaderStyle}>Summary model</div>
          <div style={{ padding: '12px 20px 18px' }}>
            <div style={{ border: '1.5px solid #e04430', background: '#fff6f4', borderRadius: 10, padding: '12px 14px', fontSize: 13, lineHeight: 1.5 }}>
              <b>Qwen3.5-4B (4-bit)</b> — 2.5 GB · summaries, action items &amp; ask-your-notes
              <br />
              <span style={{ fontSize: 12, color: '#b3200c', fontWeight: 600 }}>Installed · in use · avg. summary 4 s</span>
            </div>
          </div>
        </div>

        <div style={cardStyle}>
          <div style={cardHeaderStyle}>Storage</div>
          <div style={{ padding: '12px 20px 18px' }}>
            <div style={{ display: 'flex', height: 12, borderRadius: 999, overflow: 'hidden', background: '#eceae7', maxWidth: 520 }}>
              <div style={{ width: '38%', background: '#1c1a18' }} />
              <div style={{ width: '24%', background: '#e04430' }} />
              <div style={{ width: '11%', background: '#b0a9a2' }} />
            </div>
            <div style={{ display: 'flex', gap: 18, marginTop: 8, fontSize: 12, color: '#8d867f', flexWrap: 'wrap' }}>
              <span>
                <b style={{ color: '#1c1a18' }}>●</b> Models 6.4 GB
              </span>
              <span>
                <b style={{ color: '#e04430' }}>●</b> Audio 4.1 GB
              </span>
              <span>
                <b style={{ color: '#b0a9a2' }}>●</b> Notes 1.9 GB
              </span>
              <span>Free 412 GB</span>
            </div>
            <div style={{ marginTop: 16 }}>
              <Toggle on={tDel} onToggle={toggleDel} label="Delete original audio 30 days after transcription" />
            </div>
            <div style={{ marginTop: 10 }}>
              <Toggle on={tEnc} onToggle={toggleEnc} label="Encrypt note library with FileVault key" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
