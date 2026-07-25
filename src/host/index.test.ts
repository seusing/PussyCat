import { createHostSelection } from './index'
import { DEFAULT_BASE_URL } from './nodeBridgeHost'

test('defaults to demo mock host', () => {
  const selected = createHostSelection({ search: '', env: {} })
  expect(selected.mode).toBe('demo')
  expect(selected.host).toBeDefined()
})

test('environment and query select connected node host', () => {
  const fromEnv = createHostSelection({ search: '', env: { VITE_HOST_MODE: 'node', VITE_NODE_HOST_URL: 'http://node' } })
  expect(fromEnv.mode).toBe('connected')
  const fromQuery = createHostSelection({ search: '?host=node', env: { VITE_HOST_MODE: 'mock' } })
  expect(fromQuery.mode).toBe('connected')
})

test('createHostSelection: demo→snapshot 源;node→live 源', () => {
  expect(createHostSelection({}).catalogSource.kind).toBe('snapshot')
  expect(createHostSelection({ search: '?host=node' }).catalogSource.kind).toBe('live')
})

// --- P1 Task7:boot 注入 baseUrl 单一事实源(消灭随机端口下的假离线,spec §6) ---

test('boot 注入 baseUrl:createHostSelection 返回该值 + mode 变 connected,catalogSource/host 都指向它(fetch URL 前缀断言)', async () => {
  const boot = { baseUrl: 'http://127.0.0.1:54321' }
  const calls: string[] = []
  const fetchMock = vi.fn((url: string) => {
    calls.push(url)
    return Promise.resolve({ ok: true, status: 204, json: async () => undefined } as Response)
  })
  // 先桩再构造:createNodeBridgeHost 在构造期(非调用期)捕获 fetch,晚桩会绑死在
  // vitest.setup 默认的"永不落定" fetch 上(仓库级已知坑,同 catalogSource.ts 注释)。
  vi.stubGlobal('fetch', fetchMock)

  const selected = createHostSelection({ boot })
  expect(selected.baseUrl).toBe(boot.baseUrl)
  expect(selected.mode).toBe('connected')

  await selected.host.cancelCommand('r1')          // host 侧:验 fetch 打到 boot baseUrl
  await selected.catalogSource.load().catch(() => {})   // catalogSource 侧:同上(内容不重要,只验 URL)

  expect(calls.some((u) => u.startsWith(`${boot.baseUrl}/cancel`))).toBe(true)
  expect(calls.some((u) => u.startsWith(`${boot.baseUrl}/catalog`))).toBe(true)
})

test('baseUrl 优先级:boot > env > 默认43117;HostSelection.baseUrl 全场景(含 demo)都返回,供 T7 props 贯穿', () => {
  expect(createHostSelection({
    search: '?host=node', env: { VITE_NODE_HOST_URL: 'http://env-wins' }, boot: { baseUrl: 'http://boot-wins' },
  }).baseUrl).toBe('http://boot-wins')

  expect(createHostSelection({
    search: '?host=node', env: { VITE_NODE_HOST_URL: 'http://env-wins' },
  }).baseUrl).toBe('http://env-wins')

  expect(createHostSelection({ search: '?host=node' }).baseUrl).toBe(DEFAULT_BASE_URL)
  expect(createHostSelection({}).baseUrl).toBe(DEFAULT_BASE_URL)   // demo 模式仍回落默认值(HealthPill 在 demo 下不 ping,值本身不用)
})

test('mode 优先级:boot 存在即视为已连接,无视 query/env 显式选择 mock;无 boot 时既有 query>env 顺序不变', () => {
  const withBoot = createHostSelection({ boot: { baseUrl: 'http://127.0.0.1:9' }, search: '?host=mock', env: { VITE_HOST_MODE: 'mock' } })
  expect(withBoot.mode).toBe('connected')
  expect(withBoot.baseUrl).toBe('http://127.0.0.1:9')

  const queryOverridesEnv = createHostSelection({ search: '?host=mock', env: { VITE_HOST_MODE: 'node' } })
  expect(queryOverridesEnv.mode).toBe('demo')   // 既有行为:query 显式给值时压过 env(回归护栏)
})
