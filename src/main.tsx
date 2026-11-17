import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { processPhotoFilesSequentially } from './services/photo-reader'
import { useJourneyStore } from './store/journey-store'

// 僅開發模式：提供瀏覽器自動化測試注入照片的入口（正式建置時整段會被移除）
if (import.meta.env.DEV) {
  Object.assign(window, { __devTools: { useJourneyStore, processPhotoFilesSequentially } })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
