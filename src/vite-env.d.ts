/// <reference types="vite/client" />

declare global {
  interface Window {
    // Tauri Host 就绪后经 initialization_script 注入(src-tauri/src/lib.rs boot_script);
    // baseUrl 单一事实源起点,main.tsx 读取后经 props 贯穿到 HealthPill(spec §6,P1 Task7)。
    __OPENCLI_BOOT__?: { baseUrl?: string; hostPid?: number }
  }
}

export {}
