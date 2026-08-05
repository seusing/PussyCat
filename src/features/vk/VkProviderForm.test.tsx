import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VkProviderForm } from './VkProviderForm'

const BASE = 'http://127.0.0.1:9999'
const SECRET = 'sk-relay-DO-NOT-LEAK-0123456789'

function channel(over: Record<string, unknown> = {}) {
  return {
    id: 'cheap', name: 'GPT 5.6 Luna', base_url: 'https://api.example.com/v1',
    model_id: 'gpt-5.6-luna', key_env: 'VK_CHANNEL_CHEAP_KEY',
    api_style: 'openai_completions', key_stored: true, key_from_environment: false,
    in_cny: 1, out_cny: 6, reasoning_effort: 'low', reasoning_effort_explicit: false,
    extra_headers: {}, is_default: true, priced: true,
    ...over,
  }
}

function settings(over: Record<string, unknown> = {}) {
  return {
    channels: [channel()],
    roles: { deep_analysis: 'cheap', basic: 'cheap' },
    role_assignments: {},
    role_labels: { deep_analysis: '深度分析', basic: '基础处理' },
    role_hints: { deep_analysis: '提炼观点', basic: '章节划分、质检等其余步骤' },
    api_styles: [
      { id: 'openai_completions', label: 'OpenAI 兼容（chat/completions）' },
      { id: 'openai_responses', label: 'OpenAI Responses' },
      { id: 'anthropic_messages', label: 'Anthropic Messages' },
    ],
    presets: [{ id: 'zhipu', name: '智谱 GLM（官方）', base_url: 'https://open.bigmodel.cn/api/paas/v4', note: '国内直连' }],
    importable: [],
    unpriced: [],
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

const SAVE_OK = { saved: true, normalization_notes: [], keys_written: [], keys_injected: [], configured: true }

afterEach(() => { vi.unstubAllGlobals() })

// ── key 的进出 ──────────────────────────────────────────────────────────

test('已保存的 key 不随页面回显 —— 输入框从空开始', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
  render(<VkProviderForm baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('vk-channel-key-cheap')).toBeInTheDocument())
  const input = screen.getByTestId('vk-channel-key-cheap') as HTMLInputElement
  expect(input.value).toBe('')
  expect(input.type).toBe('password')
  expect(input.placeholder).toContain('留空')
  expect(document.body.textContent).not.toContain(SECRET)
})

test('点「显示」才取明文 —— 这是唯一会把 key 送回前端的一次', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers/reveal': { body: { key_env: 'VK_CHANNEL_CHEAP_KEY', found: true, api_key: SECRET, source: 'stored' } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-channel-reveal-cheap')).toBeInTheDocument())

  // 打开页面时没人问过 reveal
  expect(calls.some((c) => c.key.includes('reveal'))).toBe(false)

  await userEvent.click(screen.getByTestId('vk-channel-reveal-cheap'))

  await waitFor(() => expect((screen.getByTestId('vk-channel-key-cheap') as HTMLInputElement).value).toBe(SECRET))
  expect((screen.getByTestId('vk-channel-key-cheap') as HTMLInputElement).type).toBe('text')
})

test('再点一次隐藏,明文从输入框消失', async () => {
  stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers/reveal': { body: { key_env: 'VK_CHANNEL_CHEAP_KEY', found: true, api_key: SECRET, source: 'stored' } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-channel-reveal-cheap')).toBeInTheDocument())

  await userEvent.click(screen.getByTestId('vk-channel-reveal-cheap'))
  await waitFor(() => expect((screen.getByTestId('vk-channel-key-cheap') as HTMLInputElement).value).toBe(SECRET))
  await userEvent.click(screen.getByTestId('vk-channel-reveal-cheap'))

  const input = screen.getByTestId('vk-channel-key-cheap') as HTMLInputElement
  expect(input.value).toBe('')
  expect(input.type).toBe('password')
})

test('留空的 key 不提交 —— 留空表示"别动已存的那把"', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-provider-save')).toBeInTheDocument())

  await userEvent.click(screen.getByTestId('vk-provider-save'))

  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const body = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as { channels: Record<string, unknown>[] }
  expect('api_key' in body.channels[0]).toBe(false)
  expect(body.channels[0].model_id).toBe('gpt-5.6-luna')
})

test('key 来自系统环境变量时说明它优先 —— 用户要改得去别处', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({ channels: [channel({ key_from_environment: true })] }) } })
  render(<VkProviderForm baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('vk-channel-cheap').textContent).toContain('系统环境变量'))
  expect(screen.getByTestId('vk-channel-cheap').textContent).toContain('优先')
})

// ── 通道增删与默认 ──────────────────────────────────────────────────────

test('新增配置,并且第一条自动成为默认', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({ channels: [], configured: false }) } })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-channel-add')).toBeInTheDocument())

  await userEvent.click(screen.getByTestId('vk-channel-add'))

  // 「默认」必须始终存在,否则角色解析无处可退
  await waitFor(() => expect(screen.getByText('默认')).toBeInTheDocument())
})

test('删掉默认那条时立刻指定新的默认_不留没有默认的中间态', async () => {
  stubRoutes({
    'GET /vk/v1/providers': { body: settings({
      channels: [channel(), channel({ id: 'smart', name: 'Sol', is_default: false })],
    }) },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-channel-remove-cheap')).toBeInTheDocument())

  await userEvent.click(screen.getByTestId('vk-channel-remove-cheap'))

  expect(screen.queryByTestId('vk-channel-cheap')).not.toBeInTheDocument()
  expect(screen.getByTestId('vk-channel-smart').textContent).toContain('默认')
})

test('预设一键建通道并带上公开地址', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({ channels: [], configured: false }) } })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-preset-zhipu')).toBeInTheDocument())

  await userEvent.click(screen.getByTestId('vk-preset-zhipu'))

  const urls = screen.getAllByPlaceholderText(/接口地址/) as HTMLInputElement[]
  expect(urls[0].value).toBe('https://open.bigmodel.cn/api/paas/v4')
  // 预设不预填模型名 —— 编一个会让用户以为它一定存在
  expect((screen.getAllByPlaceholderText(/模型名称/)[0] as HTMLInputElement).value).toBe('')
})

test('从本机既有配置一键导入_地址与模型名现成', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({
    channels: [], configured: false,
    importable: [{ id: 'luna', name: 'gpt-5.6-luna', base_url: 'https://relay.example.com/v1',
      model_id: 'gpt-5.6-luna', key_env: 'VK_RELAY_LUNA_KEY', in_cny: 1, out_cny: 6, key_stored: true }],
  }) } })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-import-luna')).toBeInTheDocument())

  await userEvent.click(screen.getByTestId('vk-import-luna'))

  expect((screen.getByTestId('vk-channel-url-luna') as HTMLInputElement).value).toBe('https://relay.example.com/v1')
  expect((screen.getByTestId('vk-channel-model-luna') as HTMLInputElement).value).toBe('gpt-5.6-luna')
})

// ── 角色指派 ────────────────────────────────────────────────────────────

test('两个角色各一个下拉,未指派时显示跟随默认', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
  render(<VkProviderForm baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('vk-role-deep_analysis')).toBeInTheDocument())
  expect(screen.getByTestId('vk-role-basic')).toBeInTheDocument()
  // 中文名由后端给,前端不自己编
  expect(screen.getByText('深度分析')).toBeInTheDocument()
  expect(screen.getByText('基础处理')).toBeInTheDocument()
  expect((screen.getByTestId('vk-role-deep_analysis') as HTMLSelectElement).value).toBe('')
})

test('指派的角色随保存一起提交', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings({
      channels: [channel(), channel({ id: 'smart', name: 'Sol', is_default: false })],
    }) },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-role-deep_analysis')).toBeInTheDocument())

  await userEvent.selectOptions(screen.getByTestId('vk-role-deep_analysis'), 'smart')
  await userEvent.click(screen.getByTestId('vk-provider-save'))

  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const body = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as { roles: Record<string, string> }
  expect(body.roles).toEqual({ deep_analysis: 'smart' })
})

// ── 测试连接 ────────────────────────────────────────────────────────────

test('测试失败时给根因和下一步,不是一段原始日志', async () => {
  stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers/test': { body: {
      ok: false, reason_code: 'unauthorized', message: 'API key 无效或已过期',
      fix_hint: '到中转站控制台重新签发一把 key', models: [], normalization_notes: [],
    } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-channel-test-cheap')).toBeInTheDocument())

  await userEvent.click(screen.getByTestId('vk-channel-test-cheap'))

  await waitFor(() => expect(screen.getByTestId('vk-channel-result-cheap')).toHaveTextContent('已过期'))
  expect(screen.getByTestId('vk-channel-fix-cheap')).toHaveTextContent('重新签发')
})

test('自动修正的地址回填输入框 —— 看不见的自动修等于没修', async () => {
  stubRoutes({
    'GET /vk/v1/providers': { body: settings({ channels: [channel({ base_url: 'api.example.com/v1/chat/completions' })] }) },
    'POST /vk/v1/providers/test': { body: {
      ok: true, reason_code: 'ok', message: '连接正常，可用模型 2 个',
      models: ['m-a', 'm-b'], base_url: 'https://api.example.com/v1',
      normalization_notes: ['已自动补上 https://', '已去掉末尾的 /chat/completions（这里要填的是根地址）'],
    } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-channel-test-cheap')).toBeInTheDocument())

  await userEvent.click(screen.getByTestId('vk-channel-test-cheap'))

  await waitFor(() => expect((screen.getByTestId('vk-channel-url-cheap') as HTMLInputElement).value)
    .toBe('https://api.example.com/v1'))
  expect(screen.getByTestId('vk-channel-cheap').textContent).toContain('已自动补上 https://')
  // 测出来的模型名做成下拉,省掉手抄
  expect(document.querySelectorAll('#vk-models-cheap option')).toHaveLength(2)
})

// ── 其余 ────────────────────────────────────────────────────────────────

test('缺单价的通道明说预算上限不可用', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({
    channels: [channel({ in_cny: null, out_cny: null, priced: false })], unpriced: ['cheap'],
  }) } })
  render(<VkProviderForm baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('vk-channel-unpriced-cheap')).toHaveTextContent('预算上限不可用'))
})

test('读不到配置时如实说,而不是渲染一张空表单让人以为配好了', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { status: 503, body: { error: 'sidecar 未接线' } } })
  render(<VkProviderForm baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('vk-provider-form')).toHaveTextContent('sidecar 未接线'))
  expect(screen.queryByTestId('vk-provider-save')).not.toBeInTheDocument()
})

test('接口风格可选并随保存/测试一起提交 —— 漏掉它,responses 风格的中转会被打成 chat/completions', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers': { body: SAVE_OK },
    'POST /vk/v1/providers/test': { body: { ok: true, reason_code: 'ok', message: 'ok', models: [], normalization_notes: [] } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-channel-style-cheap')).toBeInTheDocument())

  await userEvent.selectOptions(screen.getByTestId('vk-channel-style-cheap'), 'openai_responses')
  await userEvent.click(screen.getByTestId('vk-channel-test-cheap'))
  await waitFor(() => expect(calls.some((c) => c.key.includes('providers/test'))).toBe(true))
  const test = calls.find((c) => c.key.includes('providers/test'))!.body as { api_style: string }
  expect(test.api_style).toBe('openai_responses')

  await userEvent.click(screen.getByTestId('vk-provider-save'))
  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const saved = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as { channels: { api_style: string }[] }
  expect(saved.channels[0].api_style).toBe('openai_responses')
})
