import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { StartupSplash } from './components/StartupSplash'
import { createHostSelection } from './host'
import { connectInspirationLibrary } from './features/inspiration/inspirationLibrary'
import { createHostInspirationPersistence } from './features/inspiration/inspirationHostClient'
import { installExternalLinkHandler } from './lib/externalLinks'
import { connectDotHistory } from './features/dot/dotChatStore'
import { createHostDotHistoryPersistence } from './features/dot/dotHistory'
import './index.css'

const hostSelection = createHostSelection({
  search: window.location.search,
  env: import.meta.env,
  boot: window.__OPENCLI_BOOT__,
})

// 灵感库和点点对话记录都以宿主上的文件为准:先于渲染接上宿主,读取完成前不写入。
// 演示模式没有宿主,只在内存里。
if (hostSelection.mode === 'connected') {
  connectInspirationLibrary(createHostInspirationPersistence(hostSelection.baseUrl))
  connectDotHistory(createHostDotHistoryPersistence(hostSelection.baseUrl))
}

// 外站链接一律交给系统浏览器(桌面壳里 target="_blank" 点了没反应)
installExternalLinkHandler()

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
