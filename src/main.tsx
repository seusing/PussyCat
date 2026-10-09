import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { StartupSplash } from './components/StartupSplash'
import { createHostSelection } from './host'
import { connectInspirationLibrary } from './features/inspiration/inspirationLibrary'
import { createHostInspirationPersistence } from './features/inspiration/inspirationHostClient'
import './index.css'

const hostSelection = createHostSelection({
  search: window.location.search,
  env: import.meta.env,
  boot: window.__OPENCLI_BOOT__,
})

// 灵感库以宿主上的文件为准:先于渲染接上宿主,读取完成前库处于"读取中"、不接受写入。
// 演示模式没有宿主,库只在内存里。
if (hostSelection.mode === 'connected') {
  connectInspirationLibrary(createHostInspirationPersistence(hostSelection.baseUrl))
}

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
