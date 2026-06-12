import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { bootTheme } from './theme'
import './tokens.css'
import './styles.css'
import './onboarding/onboarding.css'

// Re-apply the saved accent before first paint (overrides the tokens.css default at runtime).
bootTheme()

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
