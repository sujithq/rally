import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applySiteConfig } from './config'
import './styles.css'

applySiteConfig()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)