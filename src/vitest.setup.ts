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
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})

afterEach(() => {
  vi.unstubAllGlobals()
})
