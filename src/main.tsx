import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { StartupSplash } from './components/StartupSplash'
import { createHostSelection } from './host'
import './index.css'

const hostSelection = createHostSelection({
  search: window.location.search,
  env: import.meta.env,
  boot: window.__OPENCLI_BOOT__,
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StartupSplash>
      <App
        host={hostSelection.host}
        catalogSource={hostSelection.catalogSource}
        mode={hostSelection.mode}
        baseUrl={hostSelection.baseUrl}
      />
    </StartupSplash>
  </StrictMode>,
)
