// Stubs the global `Audio` constructor for the screenshot harness — headless
// Chrome is a real browser (unlike jsdom), so `useAudioPlayer`'s default
// `new Audio()` would otherwise try to actually load `asset://…` (via the
// mocked `convertFileSrc`), which doesn't resolve to real bytes outside a
// Tauri webview and fires a load `error`, forcing PlayerBar into its
// disabled "Audio unavailable" state. Replacing `window.Audio` with a fake
// that satisfies `useAudioPlayer`'s `AudioElementLike` shape — see
// src/state/useAudioPlayer.ts — lets the real playback UI render normally
// (an enabled PlayerBar with a real-looking duration/position) without
// touching any app code.

const FAKE_DURATION_SECONDS = 1680 // matches the Aurora note's 28:00 duration
const FAKE_CURRENT_TIME_SECONDS = 508 // 08:28 — a natural mid-scrub position for the hero shot

type Listener = () => void

class FakeAudioElement {
  private _src = ''
  currentTime = FAKE_CURRENT_TIME_SECONDS
  duration = NaN
  paused = true
  playbackRate = 1
  private listeners = new Map<string, Set<Listener>>()

  get src(): string {
    return this._src
  }

  set src(value: string) {
    this._src = value
    if (!value) {
      this.duration = NaN
      return
    }
    // Simulate the browser resolving metadata asynchronously, same as a
    // real <audio> element would — queued as a microtask so
    // `useAudioPlayer`'s `loadedmetadata` listener (attached synchronously
    // right after this setter runs) is guaranteed to already be registered.
    queueMicrotask(() => {
      this.duration = FAKE_DURATION_SECONDS
      this.currentTime = FAKE_CURRENT_TIME_SECONDS
      this.dispatch('loadedmetadata')
      // `useAudioPlayer`'s displayed `currentTime` only ever updates off a
      // real `timeupdate` event (see that hook) — without this, the player
      // bar would show a live-looking duration but stay frozen at 00:00
      // forever, since nothing here ever actually plays.
      this.dispatch('timeupdate')
    })
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  private dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }

  play(): Promise<void> {
    this.paused = false
    this.dispatch('play')
    return Promise.resolve()
  }

  pause(): void {
    this.paused = true
    this.dispatch('pause')
  }

  removeAttribute(): void {}

  load(): void {}
}

export function installFakeAudio(): void {
  // @ts-expect-error — deliberately narrower than the real lib.dom.d.ts
  // `HTMLAudioElement` constructor; `useAudioPlayer` only ever touches the
  // `AudioElementLike` surface this class implements.
  window.Audio = FakeAudioElement
}
