import { defineConfig } from '@playwright/test'

// 阶段 6 UI E2E:真 vite(node 模式)+ 真 Node Host(43199)+ 真 Python sidecar
// (LLM 面为本机 stub,零真实计费)。Host 由 global-setup 拉起,vite 由 webServer 拉起。
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  retries: 0,
  workers: 1, // 共享同一 Host/sidecar,串行
  globalSetup: './e2e/global-setup.mjs',
  globalTeardown: './e2e/global-teardown.mjs',
  use: {
    baseURL: 'http://localhost:5199',
  },
  webServer: {
    command: 'npm run dev -- --mode node --port 5199 --strictPort',
    port: 5199,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      VITE_HOST_MODE: 'node',
      VITE_NODE_HOST_URL: 'http://127.0.0.1:43199',
    },
  },
})
