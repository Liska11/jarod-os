import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

// public/check.js has already explained that this WebView is too old: nothing to start.
if (!(window as unknown as { __jarodTooOld?: boolean }).__jarodTooOld) {
  const root = document.getElementById('root')!
  root.setAttribute('data-ready', '1')
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}
