/// <reference types="vite/client" />

declare global {
  // vite.config.ts 的 define 在构建时注入。
  const __APP_VERSION__: string
  const __APP_COMMIT__: string
  const __APP_BUILD_DATE__: string

  interface Window {
    // Tauri Host 就绪后经 initialization_script 注入(src-tauri/src/lib.rs boot_script);
    // baseUrl 单一事实源起点,main.tsx 读取后经 props 贯穿到 HealthPill(spec §6,P1 Task7)。
    __OPENCLI_BOOT__?: { baseUrl?: string; hostPid?: number }
  }
}

export {}
