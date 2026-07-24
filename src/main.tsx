import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { createHostSelection } from './host'
import './index.css'

const hostSelection = createHostSelection({
  search: window.location.search,
  env: import.meta.env,
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App host={hostSelection.host} catalogSource={hostSelection.catalogSource} mode={hostSelection.mode} />
  </StrictMode>,
)
