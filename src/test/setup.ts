import '@testing-library/jest-dom/vitest'
import { clearMocks, mockConvertFileSrc } from '@tauri-apps/api/mocks'

// Minute is macOS-only — `convertFileSrc` is real Tauri plumbing
// (`useAudioPlayer` calls it to build the `<audio>` element's `src`) that
// has no jsdom equivalent; mocked globally here (rather than per test file)
// so any component that renders a note with audio — not just
// useAudioPlayer's own unit tests — gets a working implementation without
// each one having to know that.
beforeEach(() => {
  mockConvertFileSrc('macos')
})

afterEach(() => {
  clearMocks()
})
