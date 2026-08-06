import '@testing-library/jest-dom'

// App.tsx 的 loadCatalog() 用真实 fetch('/catalog.snapshot.json')。测试环境（Node/jsdom）
// 没有本地服务器，未 mock 时请求会失败并（在 Task4 之前）被 App 的 `.catch(() => {})` 静默吞掉。
// Task4 把这个 catch 接上了 setCatalogStatus('error', ...)，若放任真实 fetch 报错，
// 所有渲染 <App /> 的既有测试都会在 catalog 异步落定为 'error' 后把三栏 UI 换成错误态，
// 造成大面积无关回归。
//
// 这里默认给一个"永不 settle"的 fetch（而非默认成功）：绝大多数测试直接用
// useAppStore.setState(...) 摆好 commands/selected/catalogStatus，根本不关心真实
// catalog 加载的结果——让它默认成功也会在测试断言完成后才异步 resolve，
// 触发 React "not wrapped in act(...)" 警告（commands 数组引用变化会让订阅方重渲染）。
// 挂起则让这类测试里 catalogStatus 保持 beforeEach 摆好的值，零竞态、零警告。
// 需要真正验证 loadCatalog 成功/失败路径的测试，自行 vi.stubGlobal('fetch', ...) 覆盖。
function makeMemoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  }
}

// 本机 Node 25 原生 globalThis.localStorage 是坏桩（typeof object 但 setItem 不可用，
// 且遮蔽 jsdom 实现），任何裸 localStorage.* 都会抛。用内存 Storage 桩替换，
// 每个用例一份干净实例；afterEach 的 unstubAllGlobals 恢复。
// 两个桩都只服务 **jsdom 组件测试**;`@vitest-environment node` 的 server 测试(真 spawn Host、
// 真 HTTP)必须拿到真实 fetch,否则永不 settle 的桩会让它们静默卡死——`host-server.test.mjs` 与
// `readiness.test.mjs` 此前各自 stubGlobal/unstubAllGlobals 绕过,属仓库级隐藏耦合,在此按环境收窄根治。
const isJsdomEnv = typeof window !== 'undefined'

// jsdom 至今不实现 window.matchMedia(长期已知缺口,非本仓 bug)。border-beam 用它探测
// prefers-color-scheme —— 探测发生在 hook 里,即使我们显式传了 theme="dark" 也照样会调,
// 因为 hook 不能条件执行。桩固定报 matches:false(浅色),对本应用无影响:我们所有落点都
// 显式钉死 theme,不依赖这个探测结果。装在 setup 而不是单个用例里,后续任何用 matchMedia
// 的组件都不必再各自补一遍。
function stubMatchMedia() {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

beforeEach(() => {
  if (!isJsdomEnv) return
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  vi.stubGlobal('localStorage', makeMemoryStorage())
  stubMatchMedia()
})

afterEach(() => {
  vi.unstubAllGlobals()
})
