import { fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { useFocusAfterCommit } from './useFocusAfterCommit'

function Toggle() {
  const [open, setOpen] = useState(false)
  const doneRef = useRef<HTMLButtonElement>(null)
  const requestFocus = useFocusAfterCommit()
  return open ? (
    <button ref={doneRef} type="button">Done</button>
  ) : (
    <button
      type="button"
      onClick={() => {
        requestFocus(() => doneRef.current)
        setOpen(true)
      }}
    >
      Open
    </button>
  )
}

function Reenable() {
  const [busy, setBusy] = useState(true)
  const saveRef = useRef<HTMLButtonElement>(null)
  const requestFocus = useFocusAfterCommit()
  return (
    <>
      <button ref={saveRef} type="button" disabled={busy}>Save</button>
      <button
        type="button"
        onClick={() => {
          requestFocus(() => saveRef.current)
          setBusy(false)
        }}
      >
        Finish
      </button>
    </>
  )
}

describe('useFocusAfterCommit', () => {
  it('focuses a button that mounts in the same update', () => {
    render(<Toggle />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus()
  })

  it('focuses a button that re-enables in the same update', () => {
    render(<Reenable />)
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus()
  })
})
