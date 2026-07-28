# Minute accessibility review

Run this matrix in both appearances at 100% and 200% browser zoom, with Reduce
Motion enabled and disabled. A release cannot mark the VoiceOver rows complete
from axe output alone.

## Keyboard

- Tab order follows title bar → library → primary workspace → secondary panel.
- `⌘K`/`⌘F` opens search and Escape returns focus to the invoking control.
- `⌘/` opens the shortcut reference; Escape and outside click close it and
  restore focus.
- Arrow keys move note tabs, transcript turns, and installed model radios.
- Recording shortcuts do not fire while a text field is active.
- Confirmation and Undo actions are reachable without pointer input.
- Every focused control has a visible outline in light and dark appearances.

### Keyboard sign-off — July 27, 2026

Status: **Pass**

- Walked the rendered tab order from the title bar through the complete library,
  note workspace, and inspector.
- Verified `⌘K`, `⌘F`, and `⌘/` move focus into their dialogs, contain it, and
  return it to the invoking control on Escape.
- Verified recording preflight receives focus, begins its tab order at the
  microphone selector, contains focus, and returns to New recording.
- Verified arrow-key navigation for note tabs, transcript turns, and installed
  model radios.
- Verified title, marker, speaker rename, and speaker merge editors restore
  focus after Save, Cancel, and Escape.
- Verified marker deletion moves focus to Undo and Undo returns focus to the
  Markers section.
- Inspected visible focus in light and dark appearances. Regression coverage is
  in `NoteView.test.tsx`, `App.test.tsx`, `SearchPalette.test.tsx`,
  `ShortcutReference.test.tsx`, and `RecordingPreflight.test.tsx`.

## VoiceOver

- The main window exposes one title, Notes navigation, and one main landmark.
- Recording status, processing stages, errors, and Undo confirmations announce
  once without repeating on every render.
- Source facts read as microphone name, microphone/system-audio state, model,
  and local-processing status—not as unlabeled color or icon changes.
- Dialog names are concise; opening moves focus inside; closing restores focus.
- Note tabs announce selected state and their panels.
- Transcript timestamps announce their seek action and unavailable audio state.
- Destructive confirmations identify the exact note, marker, or audio asset.

### VoiceOver sign-off — July 27, 2026

Status: **Pass**

- Enabled VoiceOver in the isolated native macOS build, traversed the interface
  with VoiceOver navigation, and restored the original system setting after the
  pass.
- Inspected the native macOS accessibility tree for onboarding, the empty
  library, Settings, recording preflight, and the shortcut reference.
- Added names to collapsed-sidebar navigation buttons and promoted the empty
  library title and onboarding Models label to headings.
- Exposed detected processor, memory, and CPU-core details as named
  accessibility content; model compatibility and download state are included in
  each model radio's accessible name.
- Changed unavailable transcript timestamps from a misleading play action to
  “Audio unavailable,” and made note-deletion confirmation identify the exact
  note.
- Kept the visible recording-health detail current while moving announcements
  to a stable, atomic live region that changes only when health category or
  capture state changes.
- Confirmed preflight and shortcut dialogs expose names, initial focus, controls,
  and state in the native tree.

## Visual access

- Text and icons meet WCAG AA contrast against both paper themes.
- At 200% zoom, actions reflow without horizontal page scrolling at the
  supported minimum window.
- Status never relies on color alone.
- Reduced motion removes entrance, blink, and scroll animations while
  preserving every state change.

### Visual-access sign-off — July 27, 2026

Status: **Pass**

- Checked the rendered light and dark token ramps against the paper surface.
  The lowest body-text result was 5.24:1 in light appearance and 5.96:1 in
  dark appearance; accent buttons measured 5.92:1.
- Exercised Settings and onboarding at a 720px CSS viewport, equivalent to
  200% zoom at the supported 1440px review width. Both reflow without
  horizontal page scrolling, and onboarding keeps its first heading reachable.
- Confirmed model compatibility uses the written labels Recommended, Good fit,
  Near memory limit, Below minimum, and Not supported in addition to color.
- Enabled `prefers-reduced-motion: reduce` on the active recording view and
  verified no CSS animations remained active. The waveform stays visible at a
  static mid-height and textual recording status remains unchanged.
- Added `settings-enlarged-text` to the screenshot regression suite and a
  component regression for the viewport-capped application minimum width.

Automated axe coverage runs through `npm run test:accessibility`. Keyboard,
VoiceOver, and visual-access results above must be repeated when a release
changes navigation, dialogs, recording status, or core color tokens.
