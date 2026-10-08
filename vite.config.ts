/// <reference types="vitest/config" />
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 应用版本以安装包的 tauri.conf.json 为准;提交号与构建日期在构建时取,装好的包能对上源码。
function readBuildInfo() {
  const tauriConf = JSON.parse(readFileSync(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  let commit = ''
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    // 不在 git 仓库里(源码压缩包构建)就不显示提交号
  }
  const now = new Date()
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-')
  return { version: String(tauriConf.version), commit, date }
}

// 测试里钉死,断言不随发版、提交和日期漂移。
const TEST_BUILD_INFO = { version: '1.2.3', commit: 'abc1234', date: '2026-01-02' }

export default defineConfig(({ mode }) => {
  const build = mode === 'test' ? TEST_BUILD_INFO : readBuildInfo()
  return {
    define: {
      __APP_VERSION__: JSON.stringify(build.version),
      __APP_COMMIT__: JSON.stringify(build.commit),
      __APP_BUILD_DATE__: JSON.stringify(build.date),
    },
    plugins: [react(), tailwindcss()],
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/vitest.setup.ts'],
      // e2e/ 属 Playwright(独立 runner),不进 vitest 收集面
      exclude: ['**/node_modules/**', '**/dist/**', '**/dist-host/**', 'e2e/**', 'artifacts/**'],
    },
  }
})
