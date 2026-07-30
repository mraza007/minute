import '@testing-library/jest-dom/vitest'
import { clearMocks, mockConvertFileSrc } from '@tauri-apps/api/mocks'
import { vi } from 'vitest'

// The updater/process plugins call real Tauri plugin commands
// (`plugin:updater|check`, `plugin:process|restart`) that no test harness
// stubs — mocked globally as "no update available"/no-op so useAppState's
// update-check effect is inert in every test unless a test overrides these
// with its own mock.
vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn().mockResolvedValue(null),
}))
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn().mockResolvedValue(undefined),
}))

// Minute is macOS-only — `convertFileSrc` is real Tauri plumbing
// (`useAudioPlayer` calls it to build the `<audio>` element's `src`) that
// has no jsdom equivalent; mocked globally here (rather than per test file)
// so any component that renders a note with audio — not just
// useAudioPlayer's own unit tests — gets a working implementation without
// each one having to know that.
beforeEach(() => {
  mockConvertFileSrc('macos')
})

// jsdom's HTMLMediaElement has no real `pause()`/`load()` — component tests
// that render a note with real audio (NoteView, via useAudioPlayer's default
// `new Audio()` factory) now reach both through the pause-on-unmount/note-
// switch cleanup, and jsdom logs a "Not implemented" warning to the console
// each time. Purely test-environment noise (component tests exercise the
// wiring, not real playback — the actual behavior is covered by
// useAudioPlayer's own unit tests against an injected stub), so it's
// silenced here rather than by changing any production code.
if (typeof HTMLMediaElement !== 'undefined') {
  HTMLMediaElement.prototype.pause = () => {}
  HTMLMediaElement.prototype.load = () => {}
}

afterEach(() => {
  clearMocks()
})
