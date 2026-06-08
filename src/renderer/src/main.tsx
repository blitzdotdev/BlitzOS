import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './tokens.css'
import './styles.css'
import './onboarding/onboarding.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
