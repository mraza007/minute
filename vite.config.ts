/// <reference types="vitest/config" />
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    rollupOptions: {
      // Multi-entry production build: the main app (index.html) plus the
      // meeting-detected popup pill (popup.html — Stage 5 Task 2), a real
      // second window Tauri loads via `WebviewUrl::App("popup.html".into())`
      // (see src-tauri/src/popup.rs), not a dev-only harness like
      // screenshot.html/screenshot-app.html (those stay out of
      // rollupOptions.input on purpose — they're marketing/dev tooling, only
      // ever reachable through `vite`'s dev server, never shipped in the
      // bundled app).
      input: {
        main: resolve(__dirname, 'index.html'),
        popup: resolve(__dirname, 'popup.html'),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    globals: true,
  },
})
