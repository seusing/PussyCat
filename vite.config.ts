/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/vitest.setup.ts'],
    // e2e/ 属 Playwright(独立 runner),不进 vitest 收集面
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-host/**', 'e2e/**', 'e2e-preview/**', 'artifacts/**'],
  },
})
