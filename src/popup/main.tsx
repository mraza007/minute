import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { Pill } from './Pill'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Pill />
  </StrictMode>,
)
