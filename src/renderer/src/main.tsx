import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { bootTheme } from './theme'
import './tokens.css'
import './styles.css'

const storedTheme = window.localStorage.getItem('blitzos.theme')
document.documentElement.dataset.theme =
  storedTheme === 'dark' || storedTheme === 'light'
    ? storedTheme
    : window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'

// Re-apply the saved accent before first paint (overrides the tokens.css default at runtime).
bootTheme()

// Forward uncaught renderer errors to main (the session tape's diagnostics stream). Best-effort and
// never throws, so a broken reporter can't itself crash the renderer.
{
  const report = (via: string, message: string, stack?: string): void => {
    try {
      ;(window as unknown as { agentOS?: { reportError?: (p: unknown) => void } }).agentOS?.reportError?.({
        via,
        message,
        stack,
        surface: location.hash || location.pathname
      })
    } catch {
      /* ignore */
    }
  }
  window.addEventListener('error', (e) => report('window.onerror', String(e.message || (e.error as Error)?.message || e), (e.error as Error)?.stack))
  window.addEventListener('unhandledrejection', (e) => report('unhandledrejection', String((e.reason as Error)?.message ?? e.reason), (e.reason as Error)?.stack))
}

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
