if (import.meta.env.DEV) {
  // Dev-only: keep every runtime error with its stack so automated checks can read them.
  const errs: string[] = ((window as unknown as { __errs: string[] }).__errs = [])
  window.addEventListener('error', (e) => errs.push(`${e.message}\n${(e.error as Error | undefined)?.stack?.slice(0, 900) ?? ''}`))
  const original = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    errs.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack?.slice(0, 900)}` : String(a))).join(' ').slice(0, 1400))
    original(...args)
  }
}

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
