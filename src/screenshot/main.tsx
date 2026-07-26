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
import { Pill } from '../popup/Pill'
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

if (state === 'popup') {
  // The production popup window (popup.html, created `transparent: true` —
  // see src-tauri/src/popup.rs) sets its own html/body to
  // `background: transparent` because the *pill* carries the visible
  // surface (--card/--border/shadow — see Pill.tsx), not the document.
  // screenshot-app.html doesn't do that itself: every other `?state=` mounts
  // `<App/>`, which needs and paints its own opaque canvas, so an always-
  // transparent document here would be wrong for those. Left as the UA
  // default (opaque white) for the `popup` state instead, this exact
  // document would render as a solid white rectangle behind/around the
  // pill — not what the real transparent window shows — so it's overridden
  // for this one state only, same rule popup.html itself follows.
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
}

const root = document.getElementById('root')
if (!root) throw new Error('screenshot harness: #root not found')
// `popup` mounts the real Pill component directly (see src/popup/main.tsx)
// instead of `<App/>` — it's the actual popup window's content, not the
// main app shell, so this harness renders exactly what that window renders.
createRoot(root).render(state === 'popup' ? <Pill /> : <App />)

// Always forced (not just for `theme=dark`) — see themeOverride.ts's docs
// on why relying on the capturing machine's own OS appearance would make
// captures non-deterministic. Deferred a tick so the real stylesheet
// (injected by Vite's dev CSS pipeline) is guaranteed to already be in
// `document.styleSheets`.
requestAnimationFrame(() => {
  applyThemeOverride(theme)
  if (state === 'popup' && theme === 'dark') {
    // applyThemeOverride just set `documentElement.style.colorScheme =
    // 'dark'` — reasonable in general, but it reproduces the exact same
    // Chromium headless quirk the transparent-background fix above exists
    // for: a nested same-origin iframe whose *own* `color-scheme` resolves
    // to dark gets an opaque canvas-fallback paint behind it instead of
    // staying transparent, even with `background: transparent` explicitly
    // set on both html and body. (Confirmed the same way as the meta-tag
    // case: light doesn't trigger it, dark does, and it disappears the
    // moment this is forced back.) Never reachable in the real app —
    // popup.html's window is natively transparent at the OS level, never
    // nested inside another page's iframe — and harmless to override here:
    // the pill's dark colors already come entirely from the CSS custom
    // properties applyThemeOverride just injected (--card, --ink, etc.),
    // not from native color-scheme form-control theming, so forcing this
    // back to 'light' changes nothing about how the pill actually looks.
    document.documentElement.style.colorScheme = 'light'
  }
})

void driveScenario(state, params)
