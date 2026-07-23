import '@testing-library/jest-dom/vitest'
import { clearMocks } from '@tauri-apps/api/mocks'

afterEach(() => {
  clearMocks()
})
