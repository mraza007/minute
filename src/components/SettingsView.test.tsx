import { fireEvent, render, screen } from '@testing-library/react'
import { SettingsView } from './SettingsView'

const base = {
  sttModel: 'medium',
  setSttModel: vi.fn(),
  tDel: true,
  toggleDel: vi.fn(),
  tEnc: false,
  toggleEnc: vi.fn(),
}

describe('SettingsView', () => {
  it('shows the privacy hero text', () => {
    render(<SettingsView {...base} />)
    expect(screen.getByText('Nothing leaves this machine.')).toBeInTheDocument()
  })

  it('calls setSttModel with the clicked model id', () => {
    const setSttModel = vi.fn()
    render(<SettingsView {...base} setSttModel={setSttModel} />)
    fireEvent.click(screen.getByRole('radio', { name: /whisper small/i }))
    expect(setSttModel).toHaveBeenCalledWith('small')

    fireEvent.click(screen.getByRole('radio', { name: /whisper large-v3/i }))
    expect(setSttModel).toHaveBeenCalledWith('large')
  })

  it('shows the "in use" sub text for the selected model and the plain sub text for others', () => {
    render(<SettingsView {...base} sttModel="medium" />)
    const selected = screen.getByRole('radio', { name: /whisper medium/i })
    expect(selected).toHaveTextContent('Installed · in use')
    expect(selected).toHaveAttribute('aria-checked', 'true')

    const unselected = screen.getByRole('radio', { name: /whisper small/i })
    expect(unselected).toHaveTextContent('Recommended for this Mac')
    expect(unselected).not.toHaveTextContent('Installed · in use')
    expect(unselected).toHaveAttribute('aria-checked', 'false')
  })

  it('groups the transcription models under a radiogroup', () => {
    render(<SettingsView {...base} />)
    expect(screen.getByRole('radiogroup', { name: /transcription model/i })).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
  })

  it('renders the Qwen summary model card copy', () => {
    render(<SettingsView {...base} />)
    expect(screen.getByText('Qwen3.5-4B (4-bit)')).toBeInTheDocument()
    expect(screen.getByText(/2\.5 GB · summaries, action items & ask-your-notes/)).toBeInTheDocument()
    expect(screen.getByText('Installed · in use · avg. summary 4 s')).toBeInTheDocument()
  })

  it('wires the storage toggles to their handlers', () => {
    const toggleDel = vi.fn()
    const toggleEnc = vi.fn()
    render(<SettingsView {...base} toggleDel={toggleDel} toggleEnc={toggleEnc} />)

    fireEvent.click(screen.getByRole('switch', { name: /delete original audio 30 days after transcription/i }))
    expect(toggleDel).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('switch', { name: /encrypt note library with filevault key/i }))
    expect(toggleEnc).toHaveBeenCalledTimes(1)
  })

  it('reflects toggle state via aria-checked', () => {
    render(<SettingsView {...base} tDel={true} tEnc={false} />)
    expect(screen.getByRole('switch', { name: /delete original audio/i })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch', { name: /encrypt note library/i })).toHaveAttribute('aria-checked', 'false')
  })
})
