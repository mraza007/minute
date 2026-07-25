// Entry point for screenshot-app.html — the dev-only harness that mounts
// the real app UI with curated demo data for marketing captures. Never part
// of the production build (see vite.config.ts: only index.html is a build
// input) and excluded from `tsc -b`'s app project (tsconfig.app.json) so it
// can use browser-only globals (KeyboardEvent, etc.) without affecting the
// real app's type-check.
//
// Deliberately does *not* use <StrictMode> (unlike src/main.tsx) — its
// double-invoke-effects behavior in dev is a correctness net for the real
// app, not something this capture tool needs, and it would double-fire the
// scenario-driving side effects below (button clicks, emitted events).

import { createRoot } from 'react-dom/client'
import { mockConvertFileSrc } from '@tauri-apps/api/mocks'
import '../index.css'
import App from '../App'
import { installFakeAudio } from './fakeAudio'
import { installMockIpc, type ScreenshotState } from './mockIpc'
import { driveScenario } from './scenario'
import { applyThemeOverride } from './themeOverride'

const params = new URLSearchParams(window.location.search)
const state = (params.get('state') ?? 'note') as ScreenshotState
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'

mockConvertFileSrc('macos')
installFakeAudio()
installMockIpc(state)

const root = document.getElementById('root')
if (!root) throw new Error('screenshot harness: #root not found')
createRoot(root).render(<App />)

// Always forced (not just for `theme=dark`) — see themeOverride.ts's docs
// on why relying on the capturing machine's own OS appearance would make
// captures non-deterministic. Deferred a tick so the real stylesheet
// (injected by Vite's dev CSS pipeline) is guaranteed to already be in
// `document.styleSheets`.
requestAnimationFrame(() => applyThemeOverride(theme))

void driveScenario(state, params)
