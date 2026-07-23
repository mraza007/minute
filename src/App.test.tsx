import { fireEvent, render, screen } from '@testing-library/react'
import App from './App'

describe('App', () => {
  it('renders the title bar, sidebar, and NoteView by default', () => {
    render(<App />)
    expect(screen.getByRole('button', { name: /new recording/i })).toBeInTheDocument()
    expect(screen.getAllByText('Client call — Acme').length).toBeGreaterThan(0)
    // NoteView is showing (sel starts at 2 — Client call — Acme note title in header)
    expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument()
  })

  it('switches to RecordingView when "New recording" is clicked', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
    expect(screen.getByText('LIVE TRANSCRIPT — AUDIO NEVER LEAVES THIS MACHINE')).toBeInTheDocument()
    expect(screen.getByText('REC 14:32')).toBeInTheDocument()
  })

  it('returns to notes and shows summarizing state when "Stop & summarize" is clicked', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
    fireEvent.click(screen.getByRole('button', { name: /stop & summarize/i }))
    expect(screen.getByRole('heading', { name: 'Board prep sync' })).toBeInTheDocument()
    expect(screen.getByText('Summarizing…')).toBeInTheDocument()
  })

  it('shows SettingsView when Settings is clicked in the sidebar, and returns to notes via "All notes"', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByText('Nothing leaves this machine.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'All notes' }))
    expect(screen.queryByText('Nothing leaves this machine.')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument()
  })
})
