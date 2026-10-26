import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { installBackHook } from './lib/back.ts'
import { ensureX25519 } from './lib/x25519-shim.ts'
import { AppearanceProvider, applySavedAppearance } from './state/appearance.tsx'
import { trackViewport } from './lib/viewport.ts'
import './styles/tokens.css'
import './styles/components.css'
import './styles/screens.css'

// public/check.js has already explained that this WebView is too old: nothing to start.
if (!(window as unknown as { __jarodTooOld?: boolean }).__jarodTooOld) {
  const root = document.getElementById('root')!
  root.setAttribute('data-ready', '1')
  // The saved theme goes on before the first paint, so the app does not flash the wrong one.
  applySavedAppearance()
  trackViewport()
  installBackHook()
  // Before anything uses the protocol: older WebViews get X25519 from @noble/curves.
  void ensureX25519().then(mode => {
    console.info(`Jarod : X25519 ${mode === 'native' ? 'du WebView' : 'de secours (@noble/curves)'}`)
    createRoot(root).render(
      <StrictMode>
        <AppearanceProvider>
          <App />
        </AppearanceProvider>
      </StrictMode>
    )
  })
}
