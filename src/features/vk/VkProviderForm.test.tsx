import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VkProviderForm } from './VkProviderForm'

const BASE = 'http://127.0.0.1:9999'
const SECRET = 'sk-relay-DO-NOT-LEAK-0123456789'

function settings(over: Record<string, unknown> = {}) {
  const tier = (model_id: string, key_env: string, key_stored = false) => ({
    model_id, key_env, key_stored, key_from_environment: false, in_cny: 1, out_cny: 6,
  })
  return {
    relay_base_url: 'https://api.example.com/v1',
    tiers: {
      luna: tier('m-small', 'VK_RELAY_LUNA_KEY', true),
      terra: tier('m-mid', 'VK_RELAY_TERRA_KEY', true),
      sol: tier('', 'VK_RELAY_SOL_KEY'),
    },
    stage_tiers: { default: 'cheap', chapter: 'mid' },
    price_snapshot_id: 'v14-2026-07-24',
    configured: true,
    ...over,
  }
}

type Route = { status?: number; body: unknown }

function stubRoutes(routes: Record<string, Route>) {
  const calls: Array<{ key: string; body: unknown }> = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const route = routes[key] ?? { status: 404, body: { error: `no stub for ${key}` } }
    return { ok: (route.status ?? 200) < 400, status: route.status ?? 200, json: async () => route.body }
  })
  vi.stubGlobal('fetch', impl)
  return { calls }
}

afterEach(() => { vi.unstubAllGlobals() })

test('已保存的 key 绝不回显 —— 输入框永远从空开始', async () => {
  // 这是整个组件最要紧的一条:回显 key 会让它出现在 DOM、截图、录屏里。
  stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
  render(<VkProviderForm baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('vk-key-terra')).toBeInTheDocument())
  expect((screen.getByTestId('vk-key-terra') as HTMLInputElement).value).toBe('')
  expect(screen.getByTestId('vk-key-terra')).toHaveAttribute('type', 'password')
  // 已存过的那档要给出提示,否则用户不知道留空意味着什么
  expect((screen.getByTestId('vk-key-terra') as HTMLInputElement).placeholder).toContain('留空')
  expect(document.body.textContent).not.toContain(SECRET)
})

test('留空的 key 不提交 —— 留空表示"别动已存的那把",不是清空', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers': { body: { saved: true, relay_base_url: 'https://api.example.com/v1', normalization_notes: [], keys_written: [], keys_injected: [] } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-provider-save')).toBeInTheDocument())

  await userEvent.click(screen.getByTestId('vk-provider-save'))

  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const body = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as {
    tiers: Record<string, Record<string, unknown>>
  }
  expect('api_key' in body.tiers.terra).toBe(false)
  expect(body.tiers.terra.model_id).toBe('m-mid')     // 其余字段照常提交
})

test('填了 key 才带上,且只在这一次请求体里出现', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers': { body: { saved: true, relay_base_url: 'https://api.example.com/v1', normalization_notes: [], keys_written: ['VK_RELAY_TERRA_KEY'], keys_injected: ['VK_RELAY_TERRA_KEY'] } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-key-terra')).toBeInTheDocument())

  await userEvent.type(screen.getByTestId('vk-key-terra'), SECRET)
  await userEvent.click(screen.getByTestId('vk-provider-save'))

  await waitFor(() => expect(screen.getByTestId('vk-provider-notice')).toBeInTheDocument())
  const saves = calls.filter((c) => c.key === 'POST /vk/v1/providers')
  expect(saves).toHaveLength(1)
  // 保存完输入框要清空:key 不该继续留在 DOM 里
  expect((screen.getByTestId('vk-key-terra') as HTMLInputElement).value).toBe('')
})

test('测试失败时给根因和下一步,不是抛一段原始日志', async () => {
  stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers/test': { body: {
      ok: false, reason_code: 'unauthorized', message: 'API key 无效或已过期',
      fix_hint: '到中转站控制台重新签发一把 key', models: [], normalization_notes: [],
    } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-test-terra')).toBeInTheDocument())

  await userEvent.click(screen.getByTestId('vk-test-terra'))

  await waitFor(() => expect(screen.getByTestId('vk-test-result-terra')).toHaveTextContent('已过期'))
  expect(screen.getByTestId('vk-test-fix-terra')).toHaveTextContent('重新签发')
})

test('自动修正的地址回填到输入框 —— 看不见的自动修等于没修', async () => {
  stubRoutes({
    'GET /vk/v1/providers': { body: settings({ relay_base_url: 'api.example.com/v1/chat/completions', configured: false }) },
    'POST /vk/v1/providers/test': { body: {
      ok: true, reason_code: 'ok', message: '连接正常，可用模型 2 个',
      models: ['m-a', 'm-b'], base_url: 'https://api.example.com/v1',
      normalization_notes: ['已自动补上 https://', '已去掉末尾的 /chat/completions（这里要填的是根地址）'],
    } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-test-terra')).toBeInTheDocument())

  await userEvent.click(screen.getByTestId('vk-test-terra'))

  await waitFor(() => expect((screen.getByTestId('vk-relay-base-url') as HTMLInputElement).value)
    .toBe('https://api.example.com/v1'))
  expect(screen.getByTestId('vk-test-result-terra')).toHaveTextContent('连接正常')
  // 改了什么必须写出来,否则用户下次还会填错、还会怀疑表单在乱动输入
  expect(screen.getByTestId('vk-tier-terra').textContent).toContain('已自动补上 https://')
})

test('测试拿回的模型名做成下拉,省掉手抄', async () => {
  stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers/test': { body: {
      ok: true, reason_code: 'ok', message: 'ok', models: ['m-a', 'm-b'], normalization_notes: [],
    } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-test-luna')).toBeInTheDocument())

  await userEvent.click(screen.getByTestId('vk-test-luna'))

  await waitFor(() => expect(document.querySelectorAll('#vk-discovered-models option')).toHaveLength(2))
  expect(screen.getByTestId('vk-model-terra')).toHaveAttribute('list', 'vk-discovered-models')
})

test('读不到配置时如实说,而不是渲染一张空表单让人以为配好了', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { status: 503, body: { error: 'sidecar 未接线' } } })
  render(<VkProviderForm baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('vk-provider-form')).toHaveTextContent('sidecar 未接线'))
  expect(screen.queryByTestId('vk-provider-save')).not.toBeInTheDocument()
})
