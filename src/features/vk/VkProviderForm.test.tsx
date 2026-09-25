import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VkProviderForm } from './VkProviderForm'

const providerCss = readFileSync(resolve(process.cwd(), 'src/features/vk/VkProviderForm.css'), 'utf8')

const BASE = 'http://127.0.0.1:9999'
const SECRET = 'sk-relay-DO-NOT-LEAK-0123456789'
const dialogMethods = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close'),
}

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) { this.setAttribute('open', '') },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    },
  })
})

afterAll(() => {
  for (const [name, descriptor] of Object.entries(dialogMethods)) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
  }
})

beforeEach(() => {
  const layer = document.createElement('div')
  layer.dataset.testid = 'app-notification-layer'
  document.body.append(layer)
})

function channel(over: Record<string, unknown> = {}) {
  return {
    id: 'cheap', name: 'GPT 5.6 Luna', base_url: 'https://api.example.com/v1',
    model_id: 'gpt-5.6-luna', key_env: 'VK_CHANNEL_CHEAP_KEY',
    api_style: 'openai_completions', key_stored: true, key_from_environment: false,
    key_masked: 'sk-rela••••••••••6789',
    reasoning_effort: 'low', reasoning_effort_explicit: false, extra_headers: {},
    enabled: true,
    ...over,
  }
}

function settings(over: Record<string, unknown> = {}) {
  return {
    channels: [channel()],
    roles: { deep_analysis: 'cheap', basic: 'cheap' },
    role_assignments: {},
    role_fallbacks: {},
    role_composite_enabled: { deep_analysis: false, basic: false },
    role_routes: { deep_analysis: ['cheap'], basic: ['cheap'] },
    role_route_warnings: {},
    role_labels: { deep_analysis: '深度分析', basic: '基础处理' },
    role_hints: { deep_analysis: '提炼观点', basic: '章节划分、质检等其余步骤' },
    unassigned_roles: [],
    api_styles: [
      { id: 'openai_completions', label: 'OpenAI 兼容（chat/completions）' },
      { id: 'openai_responses', label: 'OpenAI Responses' },
      { id: 'anthropic_messages', label: 'Anthropic Messages' },
    ],
    importable: [],
    cc_switch: { available: false, path: '', reason: '本机没装 cc-switch', skipped: [], candidates: [] },
    configured: true,
    ...over,
  }
}

async function chooseGlass(trigger: HTMLElement, name: string | RegExp) {
  await userEvent.click(trigger)
  await userEvent.click(screen.getByRole('option', { name }))
}

function ccCandidate(over: Record<string, unknown> = {}) {
  return {
    ref: 'codex:242d3850', name: 'hhcoding sol', app_type: 'codex',
    base_url: 'https://hhcoding.fun', model_id: 'gpt-5.6-sol',
    api_style: 'openai_responses', is_current: true,
    masked_key: 'sk-1dbc65…862c', website_url: 'https://hhcoding.fun/dashboard',
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const SAVE_OK = { saved: true, normalization_notes: [], keys_written: [], keys_injected: [], configured: true }

afterEach(() => {
  document.querySelector('[data-testid="app-notification-layer"]')?.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function openChannelEditor(id = 'cheap') {
  await userEvent.click(await screen.findByTestId(`vk-channel-edit-${id}`))
  return screen.getByRole('dialog', { name: '编辑配置' })
}

async function commitChannelEditor() {
  await userEvent.click(screen.getByTestId('vk-provider-modal-submit'))
}

// ── key 的进出 ──────────────────────────────────────────────────────────

test('已保存的 key 以打码值示人 —— 空输入框会被当成"没设过"', async () => {
  const { calls } = stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
  render(<VkProviderForm baseUrl={BASE} />)

  await openChannelEditor()
  await waitFor(() => expect(screen.getByTestId('vk-channel-key-cheap')).toBeInTheDocument())
  const input = screen.getByTestId('vk-channel-key-cheap') as HTMLInputElement
  expect(input.value).toBe('sk-rela••••••••••6789')
  expect(input.type).toBe('password')
  expect(input.readOnly).toBe(true)
  expect(calls.some((c) => c.key.includes('reveal'))).toBe(false)
  expect(document.body.textContent).not.toContain(SECRET)
})

test('Jev Key is added and tested from its dialog', async () => {
  const saved = { id: 'jev-new', name: '测试 Key', masked_key: 'jev••••••-key', enabled: true, test_status: 'unknown', input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 }
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'GET /vk/v1/jev/config': { body: { configured: false, model: 'jev-latest', intent_tree_version: 'intent-tree@1' } },
    'POST /vk/v1/jev/configs': { body: { configured: true, configs: [saved], active_id: 'jev-new' } },
    'POST /vk/v1/jev/configs/jev-new/test': { body: { ok: true, model: 'jev-latest', message: 'Jev 配置已就绪' } },
    'GET /vk/v1/jev/configs': { body: { configured: true, configs: [saved], active_id: 'jev-new' } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  const addButton = await screen.findByTestId('vk-jev-add')
  expect(addButton).toHaveAccessibleName('新增配置')
  expect(addButton).toHaveAttribute('title', '新增配置')
  await userEvent.click(addButton)
  await userEvent.type(screen.getByLabelText('Jev 配置名称'), '测试 Key')
  const input = await screen.findByTestId('vk-jev-key') as HTMLInputElement
  expect(input.type).toBe('password')
  await userEvent.type(input, 'jev-private-key')
  await userEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(calls.some((call) => call.key === 'POST /vk/v1/jev/configs')).toBe(true))
  expect(screen.queryByTestId('vk-jev-modal')).not.toBeInTheDocument()
  await userEvent.click(within(screen.getByTestId('vk-jev-config-jev-new')).getByRole('button', { name: '测试连接' }))
  await waitFor(() => expect(calls.some((call) => call.key === 'POST /vk/v1/jev/configs/jev-new/test')).toBe(true))
})

test('保存接口 200 但未返回 configs 时刷新列表显示新配置', async () => {
  const saved = { id: 'jev-refresh', name: '刷新 Key', masked_key: 'jev••••••resh', enabled: true, test_status: 'unknown', input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 }
  const calls: Array<{ key: string; body: unknown }> = []
  let configsGets = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (key === 'GET /vk/v1/providers') return { ok: true, status: 200, json: async () => settings() }
    if (key === 'GET /vk/v1/jev/config') return { ok: true, status: 200, json: async () => ({ configured: false, model: 'jev-latest', intent_tree_version: 'intent-tree@1' }) }
    if (key === 'GET /vk/v1/jev/configs') {
      configsGets += 1
      return { ok: true, status: 200, json: async () => ({ configured: true, configs: configsGets > 1 ? [saved] : [], active_id: configsGets > 1 ? saved.id : null }) }
    }
    if (key === 'POST /vk/v1/jev/configs') return { ok: true, status: 200, json: async () => ({ configured: true }) }
    return { ok: false, status: 404, json: async () => ({ error: `no stub for ${key}` }) }
  }))
  render(<VkProviderForm baseUrl={BASE} />)
  await userEvent.click(await screen.findByRole('button', { name: '新增配置' }))
  await userEvent.type(screen.getByLabelText('Jev 配置名称'), saved.name)
  await userEvent.type(await screen.findByTestId('vk-jev-key'), 'jev-private-key')
  await userEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(await screen.findByTestId('vk-jev-config-jev-refresh')).toBeInTheDocument()
  expect(calls.filter((call) => call.key === 'GET /vk/v1/jev/configs')).toHaveLength(2)
})

test('Jev 多配置显示掩码、启用状态和估算消费', async () => {
  const config = { id: 'jev-a', name: '主 Key', masked_key: 'jev••••••cret', enabled: true, input_tokens: 1_000_000, output_tokens: 50, estimated_cost_usd: 0.042 }
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'GET /vk/v1/jev/config': { body: { configured: true, model: 'jev-latest', intent_tree_version: 'intent-tree@1' } },
    'GET /vk/v1/jev/configs': { body: { configured: true, configs: [config], active_id: 'jev-a', model: 'jev-latest', intent_tree_version: 'intent-tree@1' } },
    'POST /vk/v1/jev/configs/jev-a/enable': { body: { configured: true, configs: [config], active_id: 'jev-a' } },
    'POST /vk/v1/jev/configs/jev-a/test': { body: { ok: true, model: 'jev-latest', message: 'Jev 连接正常' } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  expect(await screen.findByText('Jev配置')).toBeInTheDocument()
  expect(screen.queryByText(/Key 仅用于服务端意图分类/)).not.toBeInTheDocument()
  expect(await screen.findByText('jev••••••cret')).toBeInTheDocument()
  const row = screen.getByTestId('vk-jev-config-jev-a')
  expect(within(row).getByText('使用中')).toBeInTheDocument()
  expect(within(row).getByTestId('vk-jev-status-light-jev-a')).toBeInTheDocument()
  expect(row).not.toHaveTextContent('连接正常')
  expect(row).not.toHaveTextContent('连接失败')
  expect(row).not.toHaveTextContent('未测试')
  expect(row).not.toHaveTextContent('尚未使用')
  expect(screen.getByText('$0.042000')).toBeInTheDocument()
  await userEvent.click(within(screen.getByTestId('vk-jev-config-jev-a')).getByRole('button', { name: '测试连接' }))
  await waitFor(() => expect(calls.some((call) => call.key === 'POST /vk/v1/jev/configs/jev-a/test')).toBe(true))
})

test('Jev 测试连接按配置独立异步执行，不锁住其他 Key', async () => {
  const configs = [
    { id: 'jev-a', name: '主 Key', masked_key: 'jev••••••a', enabled: true, test_status: 'unknown', input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 },
    { id: 'jev-b', name: '备用 Key', masked_key: 'jev••••••b', enabled: false, test_status: 'unknown', input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 },
  ]
  const first = deferred<{ ok: boolean; model: string; message: string }>()
  const second = deferred<{ ok: boolean; model: string; message: string }>()
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`
    calls.push(key)
    if (key === 'GET /vk/v1/providers') return { ok: true, status: 200, json: async () => settings() }
    if (key === 'GET /vk/v1/jev/config') return { ok: true, status: 200, json: async () => ({ configured: true }) }
    if (key === 'GET /vk/v1/jev/configs') return { ok: true, status: 200, json: async () => ({ configured: true, configs, active_id: 'jev-a' }) }
    if (key === 'POST /vk/v1/jev/configs/jev-a/test') return { ok: true, status: 200, json: () => first.promise }
    if (key === 'POST /vk/v1/jev/configs/jev-b/test') return { ok: true, status: 200, json: () => second.promise }
    return { ok: false, status: 404, json: async () => ({ error: `no stub for ${key}` }) }
  }))
  render(<VkProviderForm baseUrl={BASE} />)
  const rowA = await screen.findByTestId('vk-jev-config-jev-a')
  const rowB = screen.getByTestId('vk-jev-config-jev-b')
  await userEvent.click(within(rowA).getByRole('button', { name: '测试连接' }))
  await userEvent.click(within(rowB).getByRole('button', { name: '测试连接' }))
  await waitFor(() => {
    expect(calls).toContain('POST /vk/v1/jev/configs/jev-a/test')
    expect(calls).toContain('POST /vk/v1/jev/configs/jev-b/test')
  })
  expect(within(rowA).getByRole('button', { name: '测试连接' })).toBeDisabled()
  expect(within(rowB).getByRole('button', { name: '测试连接' })).toBeDisabled()
  first.resolve({ ok: true, model: 'jev-latest', message: 'A 已连接' })
  second.resolve({ ok: true, model: 'jev-latest', message: 'B 已连接' })
  await waitFor(() => {
    expect(within(screen.getByTestId('vk-jev-config-jev-a')).getByRole('button', { name: '测试连接' })).toBeEnabled()
    expect(within(screen.getByTestId('vk-jev-config-jev-b')).getByRole('button', { name: '测试连接' })).toBeEnabled()
  })
})

test('Jev 操作列使用带可访问名称的图标按钮', async () => {
  const enabled = { id: 'jev-enabled', name: '启用 Key', masked_key: 'jev••••••one', enabled: true, test_status: 'passed', input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 }
  const disabled = { id: 'jev-disabled', name: '停用 Key', masked_key: 'jev••••••two', enabled: false, test_status: 'unknown', input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 }
  stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'GET /vk/v1/jev/configs': { body: { configured: true, configs: [enabled, disabled], active_id: enabled.id } },
  })
  render(<VkProviderForm baseUrl={BASE} />)

  const enabledRow = await screen.findByTestId('vk-jev-config-jev-enabled')
  const disabledRow = screen.getByTestId('vk-jev-config-jev-disabled')
  expect(within(enabledRow).getAllByRole('button')).toHaveLength(4)
  expect(within(enabledRow).getByRole('button', { name: '禁用' })).toBeDisabled()
  expect(within(disabledRow).getAllByRole('button')).toHaveLength(4)
  for (const row of [enabledRow, disabledRow]) {
    for (const button of within(row).getAllByRole('button')) expect(button).toHaveTextContent('')
  }
  expect(within(enabledRow).getByRole('button', { name: '测试连接' })).toHaveAttribute('title', '测试连接')
  expect(within(enabledRow).getByRole('button', { name: '编辑' })).toHaveAttribute('title', '编辑')
  expect(within(enabledRow).getByRole('button', { name: '删除' })).toHaveAttribute('title', '删除')
  expect(within(enabledRow).getByText('使用中')).toBeInTheDocument()
  expect(within(enabledRow).getByTestId('vk-jev-status-light-jev-enabled')).toBeInTheDocument()
  expect(within(disabledRow).getByRole('button', { name: '启用' })).toHaveAttribute('title', '启用')
  expect(within(disabledRow).getByRole('button', { name: '测试连接' })).toHaveAttribute('title', '测试连接')
  expect(within(disabledRow).queryByText('未启用')).not.toBeInTheDocument()
  expect(within(disabledRow).queryByText('未测试')).not.toBeInTheDocument()
})

test('Jev 切换启用项后新的使用中按钮仍保持置灰，旧项恢复可用', async () => {
  const configs = [
    { id: 'jev-a', name: '主 Key', masked_key: 'jev••••••a', enabled: true, input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 },
    { id: 'jev-b', name: '备用 Key', masked_key: 'jev••••••b', enabled: false, input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 },
  ]
  let activeId = 'jev-a'
  const { calls } = (() => {
    const calls: Array<{ key: string; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`
      calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const response = () => ({ configured: true, configs: configs.map((item) => ({ ...item, enabled: item.id === activeId })), active_id: activeId })
      if (key === 'GET /vk/v1/providers') return { ok: true, status: 200, json: async () => settings() }
      if (key === 'GET /vk/v1/jev/configs') return { ok: true, status: 200, json: async () => response() }
      if (key === 'POST /vk/v1/jev/configs/jev-b/enable') {
        activeId = 'jev-b'
        return { ok: true, status: 200, json: async () => ({ data: response() }) }
      }
      return { ok: false, status: 404, json: async () => ({ error: `no stub for ${key}` }) }
    }))
    return { calls }
  })()
  render(<VkProviderForm baseUrl={BASE} />)

  const rowA = await screen.findByTestId('vk-jev-config-jev-a')
  const rowB = screen.getByTestId('vk-jev-config-jev-b')
  const buttonA = within(rowA).getByRole('button', { name: '禁用' })
  expect(buttonA).toBeDisabled()
  expect(buttonA).toHaveAttribute('data-state', 'active-disabled')
  await waitFor(() => expect(buttonA).toHaveStyle({ opacity: '0.5' }))
  expect(within(rowB).getByRole('button', { name: '启用' })).toBeEnabled()

  await userEvent.click(within(rowB).getByRole('button', { name: '启用' }))
  await waitFor(() => expect(calls.some((call) => call.key === 'POST /vk/v1/jev/configs/jev-b/enable')).toBe(true))
  await waitFor(() => expect(within(screen.getByTestId('vk-jev-config-jev-b')).getByRole('button', { name: '禁用' })).toBeDisabled())

  const nextA = within(screen.getByTestId('vk-jev-config-jev-a')).getByRole('button', { name: '启用' })
  const nextB = within(screen.getByTestId('vk-jev-config-jev-b')).getByRole('button', { name: '禁用' })
  expect(nextA).toBeEnabled()
  expect(nextA).toHaveAttribute('data-state', 'available')
  expect(nextB).toHaveAttribute('data-state', 'active-disabled')
  await waitFor(() => expect(nextB).toHaveStyle({ opacity: '0.5' }))
  await waitFor(() => expect(nextA).toHaveStyle({ opacity: '1' }))
})

test('Jev 编辑详情默认全密文并可用眼睛切换，启用项按钮保留且置灰', async () => {
  const config = { id: 'jev-eye', name: 'Jev 主 Key', masked_key: 'jev••••••cret', enabled: true, input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 }
  stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'GET /vk/v1/jev/config': { body: { configured: true, model: 'jev-latest', intent_tree_version: 'intent-tree@1' } },
    'GET /vk/v1/jev/configs': { body: { configured: true, configs: [config], active_id: config.id } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  const row = await screen.findByTestId('vk-jev-config-jev-eye')
  const toggle = within(row).getByRole('button', { name: '禁用' })
  expect(toggle).toBeDisabled()
  await userEvent.click(within(row).getByRole('button', { name: '编辑' }))
  const input = screen.getByTestId('vk-jev-key') as HTMLInputElement
  expect(input.type).toBe('password')
  expect(input.value).toBe(config.masked_key)
  const eye = screen.getByTestId('vk-jev-reveal')
  expect(eye).toBeEnabled()
  await userEvent.click(eye)
  expect(input.type).toBe('text')
  await userEvent.click(eye)
  expect(input.type).toBe('password')
})

test('编辑 Jev 配置通过弹窗改名且留空 Key 时保留原密钥', async () => {
  const config = { id: 'jev-edit', name: '原名称', masked_key: 'jev••••••cret', enabled: true, input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 }
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'GET /vk/v1/jev/configs': { body: { configured: true, configs: [config], active_id: 'jev-edit' } },
    'PUT /vk/v1/jev/configs/jev-edit': { body: { configured: true, configs: [{ ...config, name: '新名称' }], active_id: 'jev-edit' } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  const jevRow = await screen.findByTestId('vk-jev-config-jev-edit')
  await userEvent.click(within(jevRow).getByRole('button', { name: '编辑' }))
  expect(screen.getByTestId('vk-jev-modal')).toBeInTheDocument()
  expect((screen.getByTestId('vk-jev-key') as HTMLInputElement).placeholder).toContain('留空以保留当前 Key')
  await userEvent.clear(screen.getByLabelText('Jev 配置名称'))
  await userEvent.type(screen.getByLabelText('Jev 配置名称'), '新名称')
  await userEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(calls.some((call) => call.key === 'PUT /vk/v1/jev/configs/jev-edit')).toBe(true))
  const body = calls.find((call) => call.key === 'PUT /vk/v1/jev/configs/jev-edit')?.body as Record<string, unknown>
  expect(body).not.toHaveProperty('api_key')
  expect(await screen.findByText('新名称')).toBeInTheDocument()
})

test('旧解析引擎的 Jev 配置接口返回 not found 时自动更新一次', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'GET /vk/v1/jev/configs': { status: 404, body: { error: 'not found' } },
    'GET /vk/v1/runtime/status': { body: { state: 'installed', current: false } },
    'POST /vk/v1/runtime/install': { body: { state: 'installing' } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await userEvent.click(await screen.findByRole('button', { name: '新增配置' }))

  await waitFor(() => expect(calls.filter((call) => call.key === 'POST /vk/v1/runtime/install')).toHaveLength(1))
  expect(calls.filter((call) => call.key === 'GET /vk/v1/runtime/status')).toHaveLength(1)
  expect(await screen.findByTestId('vk-provider-error')).toHaveTextContent('解析引擎版本过旧，正在更新')
})

test('保存 Jev Key 遇到旧引擎 404 时显示升级提示并只提交一次安装', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'GET /vk/v1/jev/config': { body: { configured: false, model: 'jev-latest', intent_tree_version: 'intent-tree@1' } },
    'GET /vk/v1/jev/configs': { body: { configured: false, configs: [], active_id: null } },
    'POST /vk/v1/jev/configs': { status: 404, body: { error: 'not found' } },
    'POST /vk/v1/jev/config': { status: 404, body: { error: 'not found' } },
    'GET /vk/v1/runtime/status': { body: { state: 'installed', current: false } },
    'POST /vk/v1/runtime/install': { body: { state: 'installing' } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await userEvent.click(await screen.findByRole('button', { name: '新增配置' }))
  const input = await screen.findByTestId('vk-jev-key') as HTMLInputElement
  await userEvent.type(input, 'jev-key')
  await userEvent.click(screen.getByRole('button', { name: '保存' }))

  await waitFor(() => expect(calls.filter((call) => call.key === 'POST /vk/v1/runtime/install')).toHaveLength(1))
  expect(calls.filter((call) => call.key === 'GET /vk/v1/runtime/status')).toHaveLength(1)
  expect(await screen.findByTestId('vk-provider-error')).toHaveTextContent('解析引擎版本过旧，正在更新')
})

test('Jev 404 但解析引擎已是当前版本时不启动安装', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'GET /vk/v1/jev/config': { body: { configured: false, model: 'jev-latest', intent_tree_version: 'intent-tree@1' } },
    'GET /vk/v1/jev/configs': { body: { configured: false, configs: [], active_id: null } },
    'POST /vk/v1/jev/configs': { status: 404, body: { error: 'not found' } },
    'POST /vk/v1/jev/config': { status: 404, body: { error: 'not found' } },
    'GET /vk/v1/runtime/status': { body: { state: 'installed', current: true } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await userEvent.click(await screen.findByRole('button', { name: '新增配置' }))
  const input = await screen.findByTestId('vk-jev-key') as HTMLInputElement
  await userEvent.type(input, 'jev-key')
  await userEvent.click(screen.getByRole('button', { name: '保存' }))

  expect(await screen.findByTestId('vk-provider-error')).toHaveTextContent('not found')
  expect(calls.filter((call) => call.key === 'POST /vk/v1/runtime/install')).toHaveLength(0)
})

test('保存 Jev Key 的普通接口错误原样显示且不检查或更新解析引擎', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'GET /vk/v1/jev/config': { body: { configured: false, model: 'jev-latest', intent_tree_version: 'intent-tree@1' } },
    'GET /vk/v1/jev/configs': { body: { configured: false, configs: [], active_id: null } },
    'POST /vk/v1/jev/configs': { status: 503, body: { error: 'Jev service unavailable' } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await userEvent.click(await screen.findByRole('button', { name: '新增配置' }))
  const input = await screen.findByTestId('vk-jev-key') as HTMLInputElement
  await userEvent.type(input, 'jev-key')
  await userEvent.click(screen.getByRole('button', { name: '保存' }))

  expect(await screen.findByTestId('vk-provider-error')).toHaveTextContent('Jev service unavailable')
  expect(calls.filter((call) => call.key.startsWith('GET /vk/v1/runtime/status'))).toHaveLength(0)
  expect(calls.filter((call) => call.key === 'POST /vk/v1/runtime/install')).toHaveLength(0)
})

test('点击已保存 key 输入框会先取回明文,未修改保存不提交 api_key', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers/reveal': { body: { key_env: 'VK_CHANNEL_CHEAP_KEY', found: true, api_key: SECRET, source: 'stored' } },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await openChannelEditor()
  const input = screen.getByTestId('vk-channel-key-cheap') as HTMLInputElement
  await userEvent.click(input)

  await waitFor(() => expect(input.value).toBe(SECRET))
  expect(input.readOnly).toBe(false)
  expect(input.type).toBe('text')
  expect(calls.filter((c) => c.key.includes('reveal'))).toHaveLength(1)
  expect(screen.getByTestId('vk-channel-cheap')).toHaveTextContent('sk-rela••••••••••6789')

  await commitChannelEditor()
  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const body = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as { channels: Record<string, unknown>[] }
  expect('api_key' in body.channels[0]).toBe(false)
})

test('已取回的 key 可直接编辑,编辑后保存提交新值', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers/reveal': { body: { key_env: 'VK_CHANNEL_CHEAP_KEY', found: true, api_key: SECRET, source: 'stored' } },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await openChannelEditor()
  const input = screen.getByTestId('vk-channel-key-cheap') as HTMLInputElement
  await userEvent.click(input)
  await waitFor(() => expect(input.value).toBe(SECRET))

  await userEvent.clear(input)
  await userEvent.type(input, 'sk-brand-new')
  await commitChannelEditor()
  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const body = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as { channels: { api_key: string }[] }
  expect(body.channels[0].api_key).toBe('sk-brand-new')
})


test('点「显示」才取明文 —— 这是唯一会把 key 送回前端的一次', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers/reveal': { body: { key_env: 'VK_CHANNEL_CHEAP_KEY', found: true, api_key: SECRET, source: 'stored' } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await openChannelEditor()
  await waitFor(() => expect(screen.getByTestId('vk-channel-reveal-cheap')).toBeInTheDocument())

  const revealButton = screen.getByTestId('vk-channel-reveal-cheap')
  expect(revealButton).toHaveAttribute('data-icon', 'eye')
  await userEvent.hover(revealButton)
  expect(revealButton).toHaveAttribute('data-icon', 'eye-off')
  await userEvent.unhover(revealButton)

  // 打开页面时没人问过 reveal
  expect(calls.some((c) => c.key.includes('reveal'))).toBe(false)

  await userEvent.click(revealButton)

  await waitFor(() => expect((screen.getByTestId('vk-channel-key-cheap') as HTMLInputElement).value).toBe(SECRET))
  expect((screen.getByTestId('vk-channel-key-cheap') as HTMLInputElement).type).toBe('text')
  await userEvent.unhover(revealButton)
  expect(revealButton).toHaveAttribute('data-icon', 'eye-off')
})

test('再点一次隐藏,仍保留完整明文只交给 password input 打点', async () => {
  stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers/reveal': { body: { key_env: 'VK_CHANNEL_CHEAP_KEY', found: true, api_key: SECRET, source: 'stored' } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await openChannelEditor()
  await waitFor(() => expect(screen.getByTestId('vk-channel-reveal-cheap')).toBeInTheDocument())

  await userEvent.click(screen.getByTestId('vk-channel-reveal-cheap'))
  await waitFor(() => expect((screen.getByTestId('vk-channel-key-cheap') as HTMLInputElement).value).toBe(SECRET))
  await userEvent.click(screen.getByTestId('vk-channel-reveal-cheap'))

  const input = screen.getByTestId('vk-channel-key-cheap') as HTMLInputElement
  expect(input.type).toBe('password')
  expect(input.value).toBe(SECRET)
  await userEvent.click(screen.getByTestId('vk-channel-reveal-cheap'))
  expect(input.type).toBe('text')
  expect(input.value).toBe(SECRET)
})


test('没碰过的 key 不提交 —— 表示"别动已存的那把"', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await openChannelEditor()
  await commitChannelEditor()

  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const body = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as { channels: Record<string, unknown>[] }
  expect('api_key' in body.channels[0]).toBe(false)
  expect(body.channels[0].model_id).toBe('gpt-5.6-luna')
})

test('推理强度使用接口返回的档位并随通道保存', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers/test': { body: {
      ok: true, reason_code: 'ok', message: 'ok', models: ['gpt-5.6-luna'],
      reasoning_efforts: { 'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'] },
      normalization_notes: [],
    } },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await openChannelEditor()
  await waitFor(() => expect(screen.getByTestId('vk-channel-reasoning-cheap')).toBeInTheDocument())

  const effort = screen.getByTestId('vk-channel-reasoning-cheap') as HTMLInputElement
  expect(effort.value).toBe('medium')
  expect(effort).toBeEnabled()
  await userEvent.click(screen.getByTestId('vk-channel-models-fetch-cheap'))
  await waitFor(() => expect(effort).toBeEnabled())
  await userEvent.clear(effort)
  expect(screen.getAllByRole('option').map((option) => option.textContent))
    .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  await userEvent.type(effort, 'max')
  await commitChannelEditor()

  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const body = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as { channels: { reasoning_effort: string }[] }
  expect(body.channels[0].reasoning_effort).toBe('max')
})

test('中转站未返回推理档位时保持 medium 默认值且不显示旧说明', async () => {
  stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers/test': { body: {
      ok: true, reason_code: 'ok', message: 'ok', models: ['gpt-5.6-luna'],
      reasoning_efforts: {}, normalization_notes: [],
    } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await openChannelEditor()
  const effort = await screen.findByTestId('vk-channel-reasoning-cheap') as HTMLInputElement

  await userEvent.click(screen.getByTestId('vk-channel-models-fetch-cheap'))
  await screen.findByTestId('vk-provider-notice')
  expect(effort).toBeEnabled()
  expect(effort.value).toBe('medium')
  expect(screen.getByTestId('vk-channel-protocol-row-cheap')).toBeInTheDocument()
  expect(screen.queryByTestId('vk-channel-reasoning-note-cheap')).not.toBeInTheDocument()
  expect(screen.queryByText('中转站未返回可枚举档位；可保持自动，或输入其支持的值')).not.toBeInTheDocument()
})

test('接口未返回推理档位时仍允许按中转站文档手填', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await openChannelEditor()
  const effort = await screen.findByTestId('vk-channel-reasoning-cheap') as HTMLInputElement

  expect(effort).toBeEnabled()
  await userEvent.clear(effort)
  await userEvent.type(effort, 'max')
  await commitChannelEditor()

  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const body = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as { channels: { reasoning_effort: string | null }[] }
  expect(body.channels[0].reasoning_effort).toBe('max')
})

test('推理强度清空后保存仍提交 medium', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await openChannelEditor()

  await userEvent.clear(await screen.findByTestId('vk-channel-reasoning-cheap'))
  await commitChannelEditor()

  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const body = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as { channels: { reasoning_effort: string }[] }
  expect(body.channels[0].reasoning_effort).toBe('medium')
})

test('服务端显式推理强度优先于 medium 默认值', async () => {
  stubRoutes({
    'GET /vk/v1/providers': { body: settings({
      channels: [channel({ reasoning_effort: 'high', reasoning_effort_explicit: true })],
    }) },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await openChannelEditor()

  const effort = await screen.findByTestId('vk-channel-reasoning-cheap')
  expect(effort).toHaveValue('high')
  const model = screen.getByTestId('vk-channel-model-cheap')
  await userEvent.clear(model)
  await userEvent.type(model, 'gpt-5.6-sol')
  expect(effort).toHaveValue('high')
})


test('key 来自系统环境变量时说明它优先 —— 用户要改得去别处', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({ channels: [channel({ key_from_environment: true })] }) } })
  render(<VkProviderForm baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('vk-channel-cheap').textContent).toContain('系统环境变量'))
  expect(screen.getByTestId('vk-channel-cheap').textContent).toContain('优先')
})

// ── 通道增删与默认 ──────────────────────────────────────────────────────

test('新增配置 —— 没有"默认"这回事了', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({ channels: [], configured: false }) } })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-channel-add')).toBeInTheDocument())

  await userEvent.click(screen.getByTestId('vk-channel-add'))

  expect(screen.getAllByPlaceholderText(/接口地址/)).toHaveLength(1)
  // 通道是按用途建的,两个角色各指一条 —— "默认"没有语义。
  expect(screen.queryByText('默认')).not.toBeInTheDocument()
  expect(screen.queryByText('设为默认')).not.toBeInTheDocument()
})

test('角色选择不再依赖页面底部的全局保存按钮', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({
    configured: false, unassigned_roles: ['basic'],
  }) } })
  render(<VkProviderForm baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('vk-provider-routing-section')).toBeInTheDocument())
  expect(screen.queryByTestId('vk-provider-save')).not.toBeInTheDocument()
})


test('确认删除模型配置后才保存,并解绑主角色和备用设置', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings({
      channels: [channel(), channel({ id: 'smart', name: 'Sol' })],
      role_assignments: { deep_analysis: 'cheap', basic: 'smart' },
      role_fallbacks: { deep_analysis: ['smart'], basic: ['cheap'] },
    }) },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-channel-remove-cheap')).toBeInTheDocument())

  await userEvent.click(screen.getByTestId('vk-channel-remove-cheap'))
  const dialog = screen.getByRole('dialog', { name: '删除模型配置？' })
  expect(dialog).toHaveTextContent('GPT 5.6 Luna')
  expect(dialog).toHaveTextContent('已有任务和解析结果保留')
  expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus()
  expect(screen.getByTestId('vk-channel-cheap')).toBeInTheDocument()
  expect(calls.filter((call) => call.key === 'POST /vk/v1/providers')).toHaveLength(0)
  await userEvent.click(within(dialog).getByRole('button', { name: '删除配置' }))

  await waitFor(() => expect(screen.queryByTestId('vk-channel-cheap')).not.toBeInTheDocument())
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const body = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as { roles: Record<string, string>; role_fallbacks: Record<string, string[]> }
  expect(body.roles).toEqual({ deep_analysis: 'smart', basic: 'smart' })
  expect(body.role_fallbacks).toEqual({ deep_analysis: [], basic: [] })
})

test('删除确认点击弹窗外关闭且不写入', async () => {
  const { calls } = stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
  render(<VkProviderForm baseUrl={BASE} />)
  const remove = await screen.findByTestId('vk-channel-remove-cheap')
  await userEvent.click(remove)
  const dialog = screen.getByRole('dialog', { name: '删除模型配置？' }) as HTMLDialogElement
  await userEvent.click(dialog)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByTestId('vk-channel-cheap')).toBeInTheDocument()
  expect(calls.filter((call) => call.key === 'POST /vk/v1/providers')).toHaveLength(0)
})

test('删除确认取消或接收 cancel 事件不写入', async () => {
  const { calls } = stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
  render(<VkProviderForm baseUrl={BASE} />)
  const remove = await screen.findByTestId('vk-channel-remove-cheap')
  await userEvent.click(remove)
  const reopened = screen.getByRole('dialog', { name: '删除模型配置？' }) as HTMLDialogElement
  await userEvent.click(within(reopened).getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await userEvent.click(remove)
  const reopenedForCancel = screen.getByRole('dialog', { name: '删除模型配置？' }) as HTMLDialogElement
  act(() => {
    const event = new Event('cancel', { cancelable: true })
    reopenedForCancel.dispatchEvent(event)
    if (!event.defaultPrevented) reopenedForCancel.close()
  })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByTestId('vk-channel-cheap')).toBeInTheDocument()
  expect(calls.filter((call) => call.key === 'POST /vk/v1/providers')).toHaveLength(0)
})

test('删除保存失败保留配置和确认弹窗,错误留在弹窗内且可重试', async () => {
  const routes = {
    'GET /vk/v1/providers': { body: settings({ role_assignments: { basic: 'cheap' } }) },
    'POST /vk/v1/providers': { status: 500, body: { error: '删除保存失败' } as unknown },
  }
  const { calls } = stubRoutes(routes)
  render(<VkProviderForm baseUrl={BASE} />)
  await userEvent.click(await screen.findByTestId('vk-channel-remove-cheap'))
  const dialog = screen.getByRole('dialog', { name: '删除模型配置？' })
  await userEvent.click(within(dialog).getByRole('button', { name: '删除配置' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('删除保存失败')
  expect(screen.getByTestId('vk-channel-cheap')).toBeInTheDocument()
  expect(screen.getByTestId('vk-role-basic')).toHaveAttribute('data-value', 'cheap')
  expect(screen.queryByTestId('vk-provider-error')).not.toBeInTheDocument()
  routes['POST /vk/v1/providers'] = { status: 200, body: SAVE_OK }
  await userEvent.click(within(dialog).getByRole('button', { name: '删除配置' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(screen.queryByTestId('vk-channel-cheap')).not.toBeInTheDocument()
  expect(calls.filter((call) => call.key === 'POST /vk/v1/providers')).toHaveLength(2)
})

test('删除保存期间重复确认仅发一次请求且禁止取消', async () => {
  const saved = deferred<typeof SAVE_OK>()
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts += 1
      const body = await saved.promise
      return { ok: true, status: 200, json: async () => body }
    }
    return { ok: true, status: 200, json: async () => settings() }
  }))
  render(<VkProviderForm baseUrl={BASE} />)
  await userEvent.click(await screen.findByTestId('vk-channel-remove-cheap'))
  const dialog = screen.getByRole('dialog', { name: '删除模型配置？' })
  const confirm = within(dialog).getByRole('button', { name: '删除配置' })
  act(() => { fireEvent.click(confirm); fireEvent.click(confirm) })
  expect(posts).toBe(1)
  expect(confirm).toBeDisabled()
  expect(confirm).toHaveTextContent('删除中…')
  expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled()
  expect(within(dialog).getByRole('button', { name: '关闭删除确认' })).toBeDisabled()
  const cancel = new Event('cancel', { cancelable: true })
  fireEvent(dialog, cancel)
  expect(cancel.defaultPrevented).toBe(true)
  expect(screen.getByTestId('vk-channel-cheap')).toBeInTheDocument()
  await act(async () => { saved.resolve(SAVE_OK) })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByTestId('vk-channel-cheap')).not.toBeInTheDocument()
})


test('没有内置预设 —— 走 API key 的话官方站和中转站配置形状本来一样', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({ channels: [], configured: false }) } })
  render(<VkProviderForm baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('vk-channel-add')).toBeInTheDocument())
  expect(screen.queryByText(/智谱/)).not.toBeInTheDocument()
  expect(screen.queryByText(/OpenAI（官方）/)).not.toBeInTheDocument()
})

test('配置清单移除旧说明,创建弹窗与关键操作都有可访问名称', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)

  const create = await screen.findByRole('button', { name: '创建配置' })
  expect(screen.queryByText('一条通道 = 地址 + 模型 + key')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '复用' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '禁用' })).toBeInTheDocument()
  expect(create).toHaveTextContent('')
  expect(create).toHaveAttribute('data-tooltip', '创建配置')
  expect(create.querySelector('svg')).not.toBeNull()

  const rowTest = screen.getByTestId('vk-channel-test-cheap')
  expect(rowTest).toHaveAccessibleName('测试连接')
  expect(rowTest).toHaveAttribute('data-icon', 'activity')
  expect(rowTest).toHaveTextContent('')
  expect(rowTest.querySelector('svg')).not.toBeNull()

  expect(screen.getByTestId('vk-role-composite-basic')).toHaveAccessibleName('基础处理启用复合key')
  expect(screen.getByTestId('vk-role-composite-deep_analysis')).toHaveAccessibleName('深度分析启用复合key')

  await user.click(create)
  const dialog = screen.getByRole('dialog', { name: '创建配置' })
  expect(dialog).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '关闭模型配置弹窗' })).toBeInTheDocument()
  const fetchModels = within(dialog).getByRole('button', { name: '获取模型列表' })
  expect(fetchModels).toHaveTextContent('')
  expect(fetchModels).toHaveAttribute('data-icon', 'download')
  const modalTest = within(dialog).getByRole('button', { name: '测试连接' })
  expect(modalTest).toHaveTextContent('')
  expect(modalTest).toHaveAttribute('data-icon', 'activity')
  expect(dialog.querySelector('.vk-provider-protocol-row')).not.toBeNull()
  const name = within(dialog).getByTestId('vk-modal-name')
  const upstream = within(dialog).getByTestId('vk-modal-group')
  expect(within(dialog).getByText('上游站点')).toBeInTheDocument()
  expect(name.className).toBe(upstream.className)
  expect(name.parentElement).toHaveClass('vk-validation-field')
  expect(upstream.parentElement).toHaveClass('vk-validation-field')
  expect(name).toHaveAccessibleName('名称')
  expect(upstream).toHaveAccessibleName('上游站点')
  expect(upstream).toHaveAttribute('readonly')
  expect(dialog.querySelector('[data-testid^="vk-channel-reasoning-"]')).toHaveValue('medium')
})

test('取消创建会丢弃草稿,取消编辑会恢复打开弹窗前的内容', async () => {
  const user = userEvent.setup()
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({ channels: [], configured: false }) } })
  const first = render(<VkProviderForm baseUrl={BASE} />)
  await user.click(await screen.findByTestId('vk-channel-add'))
  await user.clear(screen.getByTestId('vk-modal-name'))
  await user.type(screen.getByTestId('vk-modal-name'), '不会保留')
  await user.click(screen.getByTestId('vk-provider-modal-cancel'))
  expect(screen.getByText('暂无模型配置')).toBeInTheDocument()

  first.unmount()
  vi.unstubAllGlobals()
  stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
  render(<VkProviderForm baseUrl={BASE} />)
  await openChannelEditor()
  await user.clear(screen.getByTestId('vk-modal-name'))
  await user.type(screen.getByTestId('vk-modal-name'), '临时名称')
  await user.click(screen.getByTestId('vk-provider-modal-cancel'))
  expect(screen.getByTestId('vk-channel-name-cheap')).toHaveTextContent('GPT 5.6 Luna')
})

test('点击编辑弹窗外部会关闭且还原草稿,点击表单本身不会关闭', async () => {
  const user = userEvent.setup()
  stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
  render(<VkProviderForm baseUrl={BASE} />)

  const dialog = await openChannelEditor()
  await user.clear(screen.getByTestId('vk-modal-name'))
  await user.type(screen.getByTestId('vk-modal-name'), '不应保存')
  await user.click(dialog)
  expect(screen.getByRole('dialog', { name: '编辑配置' })).toBeInTheDocument()

  await user.click(screen.getByTestId('vk-provider-modal-backdrop'))
  expect(screen.queryByRole('dialog', { name: '编辑配置' })).not.toBeInTheDocument()
  expect(screen.getByTestId('vk-channel-name-cheap')).toHaveTextContent('GPT 5.6 Luna')
})

test('文本框有选中内容时点击遮罩不会关闭编辑弹窗', async () => {
  const user = userEvent.setup()
  stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
  render(<VkProviderForm baseUrl={BASE} />)

  await openChannelEditor()
  const name = screen.getByTestId('vk-modal-name') as HTMLInputElement
  name.focus()
  name.setSelectionRange(0, 2)
  await user.click(screen.getByTestId('vk-provider-modal-backdrop'))

  expect(screen.getByRole('dialog', { name: '编辑配置' })).toBeInTheDocument()
})

test('弹窗保存会校验必填项并保持弹窗打开', async () => {
  const user = userEvent.setup()
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({ channels: [], configured: false }) } })
  render(<VkProviderForm baseUrl={BASE} />)

  await user.click(await screen.findByTestId('vk-channel-add'))
  await user.click(screen.getByTestId('vk-provider-modal-submit'))

  expect(screen.getByRole('dialog', { name: '创建配置' })).toBeInTheDocument()
  expect(screen.getByText('请输入接口地址')).toBeInTheDocument()
  expect(screen.getByText('请输入模型 ID')).toBeInTheDocument()
  expect(screen.getByText('请输入 API key')).toBeInTheDocument()
})

test('模型配置与角色选择是彼此独立的分区', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
  render(<VkProviderForm baseUrl={BASE} />)

  const channels = await screen.findByTestId('vk-provider-channels-section')
  const routing = screen.getByTestId('vk-provider-routing-section')
  expect(channels).not.toContainElement(routing)
})

test('弹窗保存成功后通知父级收起配置', async () => {
  const onSaved = vi.fn()
  stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  render(<VkProviderForm baseUrl={BASE} onSaved={onSaved} />)

  await openChannelEditor()
  await commitChannelEditor()
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByTestId('app-notification-layer')).toContainElement(
    await screen.findByTestId('vk-provider-notice'),
  )
})

test('弹窗保存失败只在弹窗内显示错误', async () => {
  stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers': { status: 500, body: { error: '保存被拒绝' } },
  })
  render(<VkProviderForm baseUrl={BASE} />)

  const dialog = await openChannelEditor()
  await commitChannelEditor()

  const alert = await screen.findByTestId('vk-provider-error')
  expect(screen.getByTestId('vk-provider-modal-shell')).toContainElement(alert)
  expect(dialog).toContainElement(alert)
  expect(screen.getByTestId('app-notification-layer')).not.toContainElement(alert)
  expect(screen.getAllByTestId('vk-provider-error')).toHaveLength(1)
})

test('页面乐观保存失败只在共享通知层显示错误', async () => {
  stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers': { status: 500, body: { error: '页面保存失败' } },
  })
  render(<VkProviderForm baseUrl={BASE} />)

  await userEvent.click(await screen.findByTestId('vk-channel-toggle-cheap'))

  const alert = await screen.findByTestId('vk-provider-error')
  expect(screen.getByTestId('app-notification-layer')).toContainElement(alert)
  expect(screen.getByTestId('vk-provider-form')).not.toContainElement(alert)
  expect(screen.getAllByTestId('vk-provider-error')).toHaveLength(1)
})

test('启用与禁用按钮使用锁图标并保持状态图标', async () => {
  stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)

  const toggle = await screen.findByTestId('vk-channel-toggle-cheap')
  expect(toggle).toHaveAccessibleName('禁用')
  expect(toggle).toHaveAttribute('data-icon', 'lock')
  await user.hover(toggle)
  expect(toggle).toHaveAttribute('data-icon', 'lock')
  await user.unhover(toggle)
  await user.click(toggle)
  expect(toggle).toHaveAccessibleName('启用')
  await user.unhover(toggle)
  expect(toggle).toHaveAttribute('data-icon', 'lock-open')
  await user.hover(toggle)
  expect(toggle).toHaveAttribute('data-icon', 'lock-open')
})

test('复用保留上游和已存 key 引用,新模型可独立编辑且不提交明文 key', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)

  await user.click(await screen.findByTestId('vk-channel-reuse-cheap'))
  const dialog = screen.getByRole('dialog', { name: '创建配置' })
  const reusedUrl = within(dialog).getByPlaceholderText(/接口地址/) as HTMLInputElement
  const reusedModel = within(dialog).getByPlaceholderText(/模型名称/) as HTMLInputElement
  const reusedKey = within(dialog).getByPlaceholderText('粘贴 API key') as HTMLInputElement

  expect(reusedUrl.value).toBe('https://api.example.com/v1')
  expect(reusedKey.value).toBe('sk-rela••••••••••6789')
  expect(reusedKey.readOnly).toBe(true)
  await user.clear(reusedModel)
  await user.type(reusedModel, 'gpt-5.6-sol')
  expect(screen.getByTestId('vk-channel-cheap')).toHaveTextContent('gpt-5.6-luna')

  await user.click(within(dialog).getByTestId('vk-provider-modal-submit'))
  await waitFor(() => expect(calls.some((call) => call.key === 'POST /vk/v1/providers')).toBe(true))

  const body = calls.find((call) => call.key === 'POST /vk/v1/providers')!.body as {
    channels: Array<Record<string, unknown>>
  }
  const original = body.channels.find((item) => item.id === 'cheap')!
  const reused = body.channels.find((item) => item.id !== 'cheap')!
  expect(original.model_id).toBe('gpt-5.6-luna')
  expect(reused).toMatchObject({
    base_url: 'https://api.example.com/v1',
    key_env: 'VK_CHANNEL_CHEAP_KEY',
    model_id: 'gpt-5.6-sol',
  })
  expect('api_key' in original).toBe(false)
  expect('api_key' in reused).toBe(false)
})

test('接口风格随模型名自动填上 —— 别让用户在三个技术名词里选', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({ channels: [], configured: false }) } })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-channel-add')).toBeInTheDocument())
  await userEvent.click(screen.getByTestId('vk-channel-add'))

  const model = screen.getByPlaceholderText(/模型名称/)
  const style = () => screen.getByRole('combobox', { name: '接口协议' })

  await userEvent.type(model, 'gpt-5.6-luna')
  expect(style()).toHaveAttribute('data-value', 'openai_responses')

  await userEvent.clear(model)
  await userEvent.type(model, 'claude-opus-4-6')
  expect(style()).toHaveAttribute('data-value', 'anthropic_messages')

  // 用户自己选过之后,再改模型名不再覆盖他的选择。
  await chooseGlass(style(), /OpenAI 兼容/)
  await userEvent.clear(model)
  await userEvent.type(model, 'gpt-5.6-sol')
  expect(style()).toHaveAttribute('data-value', 'openai_completions')
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
  expect(screen.getByTestId('vk-channel-reasoning-luna')).toHaveValue('medium')
})

// ── 角色指派 ────────────────────────────────────────────────────────────

test('两个角色各有主通道下拉,未指派时明确为空', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
  render(<VkProviderForm baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('vk-role-deep_analysis')).toBeInTheDocument())
  expect(screen.getByTestId('vk-role-basic')).toBeInTheDocument()
  // 中文名由后端给,前端不自己编
  expect(screen.getByText('深度分析')).toBeInTheDocument()
  expect(screen.getByText('基础处理')).toBeInTheDocument()
  expect(screen.getByTestId('vk-role-deep_analysis')).toHaveAttribute('data-value', '')
  expect(screen.getByTestId('vk-role-routing-note')).toHaveTextContent('不会换通道掩盖配置问题')
})

test('指派角色后立即提交，不再要求页面底部保存', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings({
      channels: [channel(), channel({ id: 'smart', name: 'Sol', is_default: false })],
    }) },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-role-deep_analysis')).toBeInTheDocument())

  await chooseGlass(screen.getByTestId('vk-role-deep_analysis'), 'Sol')

  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const body = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as { roles: Record<string, string> }
  expect(body.roles).toEqual({ deep_analysis: 'smart' })
})

test('两个角色的复合开关独立，关闭与重开保留完整顺序', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings({
      channels: [channel(), channel({ id: 'backup', name: '备用', base_url: 'https://backup.example/v1' })],
      role_assignments: { basic: 'cheap' },
      role_fallbacks: { basic: ['backup'] },
      role_composite_enabled: { basic: true, deep_analysis: false },
    }) },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)
  const basic = await screen.findByTestId('vk-role-composite-basic')
  const deep = screen.getByTestId('vk-role-composite-deep_analysis')
  expect(basic).toBeChecked()
  expect(deep).not.toBeChecked()
  expect(screen.getByTestId('vk-role-basic')).toHaveTextContent('已选 2 个')

  await user.click(basic)
  expect(deep).not.toBeChecked()
  expect(screen.getByTestId('vk-role-basic')).toHaveAttribute('data-value', 'cheap')
  await user.click(basic)
  expect(screen.getByTestId('vk-role-basic')).toHaveTextContent('已选 2 个')

  await waitFor(() => expect(calls.filter((call) => call.key === 'POST /vk/v1/providers')).toHaveLength(2))
  const posts = calls.filter((call) => call.key === 'POST /vk/v1/providers')
  expect((posts[0].body as { role_fallbacks: Record<string, string[]> }).role_fallbacks.basic).toEqual(['backup'])
  expect((posts[0].body as { role_composite_enabled: Record<string, boolean> }).role_composite_enabled.basic).toBe(false)
  expect((posts[1].body as { role_composite_enabled: Record<string, boolean> }).role_composite_enabled.basic).toBe(true)
})

test('复合菜单列出停用配置并明确标注为不可选', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({
    channels: [channel(), channel({ id: 'stopped', name: '已停的配置', enabled: false })],
    role_assignments: { basic: 'cheap' },
    role_composite_enabled: { basic: true, deep_analysis: false },
  }) } })
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)
  await user.click(await screen.findByTestId('vk-role-basic'))
  expect(screen.getByRole('option', { name: /已停的配置（已停用）/ })).toBeDisabled()
})

test('复合菜单移除主项后自动晋升下一项并允许清空路线', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings({
      channels: [channel(), channel({ id: 'backup', name: '备用', base_url: 'https://backup.example/v1' })],
      role_assignments: { basic: 'cheap' },
      role_fallbacks: { basic: ['backup'] },
      role_composite_enabled: { basic: true, deep_analysis: false },
    }) },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)
  await user.click(await screen.findByTestId('vk-role-basic'))
  await user.click(screen.getByRole('option', { name: /GPT 5.6 Luna/ }))
  await user.click(screen.getByRole('option', { name: /备用/ }))

  await waitFor(() => expect(calls.filter((call) => call.key === 'POST /vk/v1/providers')).toHaveLength(2))
  const posts = calls.filter((call) => call.key === 'POST /vk/v1/providers')
  expect((posts[0].body as { roles: Record<string, string> }).roles.basic).toBe('backup')
  expect((posts.at(-1)!.body as { roles: Record<string, string> }).roles.basic).toBeUndefined()
  expect((posts.at(-1)!.body as { role_fallbacks: Record<string, string[]> }).role_fallbacks.basic).toEqual([])
})

test('首个路由保存未完成时只追加最新快照且不丢连续选择', async () => {
  const firstSave = deferred<unknown>()
  const posts: Array<{ role_fallbacks: Record<string, string[]> }> = []
  let postCount = 0
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    const response = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body })
    if (!init?.method && path === '/vk/v1/providers') return response(settings({
      channels: [
        channel(),
        channel({ id: 'backup-a', name: '备用 A', base_url: 'https://a.example/v1' }),
        channel({ id: 'backup-b', name: '备用 B', base_url: 'https://b.example/v1' }),
      ],
      role_assignments: { basic: 'cheap' },
      role_composite_enabled: { basic: true, deep_analysis: false },
    }))
    if (init?.method === 'POST' && path === '/vk/v1/providers') {
      posts.push(JSON.parse(String(init.body)))
      postCount += 1
      if (postCount === 1) return firstSave.promise.then(() => ({ ok: true, status: 200, json: async () => SAVE_OK }))
      return response(SAVE_OK)
    }
    return response({})
  }))
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)
  await user.click(await screen.findByTestId('vk-role-basic'))
  await user.click(screen.getByRole('option', { name: /备用 A/ }))
  await waitFor(() => expect(posts).toHaveLength(1))
  await user.click(screen.getByRole('option', { name: /备用 B/ }))
  expect(posts).toHaveLength(1)

  firstSave.resolve(SAVE_OK)
  await waitFor(() => expect(posts).toHaveLength(2))
  expect(posts[0].role_fallbacks.basic).toEqual(['backup-a'])
  expect(posts[1].role_fallbacks.basic).toEqual(['backup-a', 'backup-b'])
})

test('停用已选主项时备用项晋升并压紧保存路线', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings({
      channels: [channel(), channel({ id: 'backup', name: '备用', base_url: 'https://backup.example/v1' })],
      role_assignments: { basic: 'cheap' },
      role_fallbacks: { basic: ['backup'] },
      role_composite_enabled: { basic: true, deep_analysis: false },
    }) },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)
  await user.click(await screen.findByTestId('vk-channel-toggle-cheap'))

  await waitFor(() => expect(calls.some((call) => call.key === 'POST /vk/v1/providers')).toBe(true))
  const body = calls.find((call) => call.key === 'POST /vk/v1/providers')!.body as {
    roles: Record<string, string>
    role_fallbacks: Record<string, string[]>
    channels: Array<{ id: string; enabled: boolean }>
  }
  expect(body.roles.basic).toBe('backup')
  expect(body.role_fallbacks.basic).toEqual([])
  expect(body.channels.find((item) => item.id === 'cheap')?.enabled).toBe(false)
})

test('复合路由保存失败后回读服务端状态', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings({ role_composite_enabled: { basic: false, deep_analysis: false } }) },
    'POST /vk/v1/providers': { status: 500, body: { error: '路由保存失败' } },
  })
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)
  const toggle = await screen.findByTestId('vk-role-composite-basic')
  await user.click(toggle)
  expect(await screen.findByTestId('vk-provider-error')).toHaveTextContent('路由保存失败')
  const post = calls.find((call) => call.key === 'POST /vk/v1/providers')!.body as { role_composite_enabled: Record<string, boolean> }
  expect(post.role_composite_enabled.basic).toBe(true)
  await waitFor(() => expect(screen.getByTestId('vk-role-composite-basic')).not.toBeChecked())
})

test('复合通道按用户选择顺序保存,取消后重选会追加到末尾', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings({
      channels: [
        channel(),
        channel({ id: 'backup-a', name: '备用 A', base_url: 'https://a.example/v1' }),
        channel({ id: 'backup-b', name: '备用 B', base_url: 'https://b.example/v1' }),
      ],
      role_assignments: { basic: 'cheap' },
      role_fallbacks: { basic: ['backup-a', 'backup-b'] },
      role_composite_enabled: { basic: true, deep_analysis: false },
      role_routes: { basic: ['cheap', 'backup-a', 'backup-b'] },
    }) },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)

  const trigger = await screen.findByTestId('vk-role-basic')
  expect(trigger).toHaveTextContent('已选 3 个')
  await user.click(trigger)
  await user.click(screen.getByRole('option', { name: /备用 A/ }))
  await user.click(screen.getByRole('option', { name: /备用 A/ }))

  await waitFor(() => expect(calls.filter((call) => call.key === 'POST /vk/v1/providers')).toHaveLength(2))
  const body = calls.filter((call) => call.key === 'POST /vk/v1/providers').at(-1)!.body as {
    role_fallbacks: Record<string, string[]>
  }
  expect(body.role_fallbacks.basic).toEqual(['backup-b', 'backup-a'])
  expect(screen.getByTestId('vk-role-routing-note')).toHaveTextContent('仅超时、429 或上游 5xx')
})

test('复合选择不会重复添加主通道或已选通道，并立即提交', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings({
      channels: [channel(), channel({ id: 'backup', name: '备用' })],
      role_assignments: { basic: 'cheap' },
    }) },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)

  await user.click(await screen.findByTestId('vk-role-composite-basic'))
  await user.click(screen.getByTestId('vk-role-basic'))
  await user.click(screen.getByRole('option', { name: /备用/ }))
  expect(screen.getByTestId('vk-role-basic')).toHaveTextContent('已选 2 个')
  await waitFor(() => expect(calls.some((call) => call.key === 'POST /vk/v1/providers')).toBe(true))
})

test('开启复合但只有主通道时提示至少选择两个配置', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({
    channels: [channel()],
    role_assignments: { basic: 'cheap' },
    role_fallbacks: { basic: [] },
    role_composite_enabled: { basic: true, deep_analysis: false },
  }) } })
  render(<VkProviderForm baseUrl={BASE} />)

  expect(await screen.findByTestId('vk-role-warning-basic')).toHaveTextContent(
    '至少选择 2 个配置才能形成故障切换',
  )
})

test('已有备用通道时不显示缺失备用警告', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({
    channels: [channel(), channel({ id: 'backup', name: '备用', base_url: 'https://backup.example/v1' })],
    role_assignments: { basic: 'cheap' },
    role_fallbacks: { basic: ['backup'] },
    role_composite_enabled: { basic: true, deep_analysis: false },
  }) } })
  render(<VkProviderForm baseUrl={BASE} />)

  expect(await screen.findByTestId('vk-role-basic')).toHaveTextContent('已选 2 个')
  expect(screen.queryByText('未设置备用上游；当前通道超时后任务会失败。请添加一个 Base URL 不同的备用配置。')).not.toBeInTheDocument()
})

test('同一上游的主备只提醒不替用户改配置', async () => {
  stubRoutes({
    'GET /vk/v1/providers': { body: settings({
    channels: [channel(), channel({ id: 'backup', name: '备用' })],
    role_assignments: { basic: 'cheap' },
    role_fallbacks: { basic: ['backup'] },
    role_composite_enabled: { basic: true, deep_analysis: false },
    role_route_warnings: { basic: ['主通道和备用 1 来自同一上游，故障时可能一起不可用'] },
    }) },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)

  expect(await screen.findByTestId('vk-role-warning-basic')).toHaveTextContent('同一服务')
  expect(screen.getByTestId('vk-role-basic')).toHaveTextContent('已选 2 个')
  await user.click(screen.getByTestId('vk-role-composite-basic'))
  expect(screen.queryByTestId('vk-role-warning-basic')).not.toBeInTheDocument()
})

test('连接确认永久失效后可禁用且不会自动删除', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers/test': { body: {
      ok: false, reason_code: 'unauthorized', message: 'API key 已过期', retryable: false,
      fix_hint: '更换 key', models: [], normalization_notes: [],
    } },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)

  await user.click(await screen.findByTestId('vk-channel-test-cheap'))
  const notice = await screen.findByTestId('vk-provider-notice')
  expect(notice).toHaveTextContent('API key 已过期')
  expect(notice).toHaveTextContent('下一步：更换 key')
  expect(notice).toHaveClass('app-alert')
  expect(notice).toHaveAttribute('data-tone', 'error')
  expect(within(notice).getByRole('progressbar', { name: '通知剩余时间' }))
    .toHaveAttribute('aria-valuetext', '2 秒后自动关闭')
  expect(screen.queryByTestId('vk-channel-invalid-cheap')).not.toBeInTheDocument()
  expect(screen.getByTestId('vk-channel-cheap')).toHaveTextContent('已启用')
  await user.click(screen.getByTestId('vk-channel-toggle-cheap'))
  expect(screen.getByTestId('vk-channel-cheap')).toHaveTextContent('已禁用')
  expect(screen.queryByTestId('vk-channel-disabled-cheap')).not.toBeInTheDocument()
  expect(screen.getByTestId('vk-channel-cheap')).toBeInTheDocument()
  await waitFor(() => expect(calls.some((call) => call.key === 'POST /vk/v1/providers')).toBe(true))
  const body = calls.find((call) => call.key === 'POST /vk/v1/providers')!.body as {
    channels: Array<{ id: string; enabled: boolean }>
  }
  expect(body.channels).toContainEqual(expect.objectContaining({ id: 'cheap', enabled: false }))
})

// ── 测试连接 ────────────────────────────────────────────────────────────

test('不同配置的连接测试各自忙碌,一条 pending 不会锁住另一条', async () => {
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  const testBodies: unknown[] = []
  const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
  const impl = vi.fn((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`
    if (key === 'GET /vk/v1/providers') {
      return Promise.resolve(response(settings({
        channels: [
          channel(),
          channel({ id: 'smart', name: 'GPT 5.6 Sol', model_id: 'gpt-5.6-sol', key_env: 'VK_CHANNEL_SMART_KEY' }),
        ],
      })))
    }
    if (key === 'POST /vk/v1/providers/test') {
      testBodies.push(init?.body ? JSON.parse(String(init.body)) : undefined)
      const pending = testBodies.length === 1 ? first : second
      return pending.promise.then(response)
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: `no stub for ${key}` }) })
  })
  vi.stubGlobal('fetch', impl)
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)

  const cheapTest = await screen.findByTestId('vk-channel-test-cheap')
  const smartTest = screen.getByTestId('vk-channel-test-smart')
  await user.click(cheapTest)
  await waitFor(() => expect(cheapTest).toBeDisabled())
  expect(smartTest).toBeEnabled()

  await user.click(smartTest)
  await waitFor(() => expect(testBodies).toHaveLength(2))
  expect(cheapTest).toBeDisabled()
  expect(smartTest).toBeDisabled()

  first.resolve({ ok: true, reason_code: 'ok', message: 'cheap ok', models: [], normalization_notes: [] })
  await waitFor(() => expect(cheapTest).toBeEnabled())
  expect(smartTest).toBeDisabled()

  second.resolve({ ok: true, reason_code: 'ok', message: 'smart ok', models: [], normalization_notes: [] })
  await waitFor(() => expect(smartTest).toBeEnabled())
  expect(testBodies).toEqual([
    expect.objectContaining({ base_url: 'https://api.example.com/v1', key_env: 'VK_CHANNEL_CHEAP_KEY' }),
    expect.objectContaining({ base_url: 'https://api.example.com/v1', key_env: 'VK_CHANNEL_SMART_KEY' }),
  ])
})

test('弹窗生成连接成功显示后端真实首字与总耗时且通知局限在弹窗内', async () => {
  const pending = deferred<unknown>()
  const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`
    if (key === 'GET /vk/v1/providers') return Promise.resolve(response(settings()))
    if (key === 'POST /vk/v1/providers/test') return pending.promise.then(response)
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: `no stub for ${key}` }) })
  }))
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)

  const dialog = await openChannelEditor()
  await user.click(within(dialog).getByRole('button', { name: '测试连接' }))
  pending.resolve({
    ok: true, reason_code: 'ok', message: '连接正常，可用模型 2 个',
    models: ['m-a', 'm-b'], normalization_notes: [],
    generation_probe: {
      ok: true, reason_code: 'ok', message: '生成连接正常', model_reported: 'gpt-5.6-luna',
      transport_mode: 'sse', response_headers_ms: 20, first_event_ms: 30,
      first_text_ms: 47, total_ms: 123, stream_event_count: 4,
      upstream_response_id: 'resp_1', request_may_still_run: false,
    },
  })

  const notice = await screen.findByTestId('vk-provider-notice')
  expect(notice).toHaveTextContent('连接成功 · 首字 47 ms · 总耗时 123 ms')
  expect(notice).not.toHaveTextContent('连接正常，可用模型 2 个')
  expect(dialog).toContainElement(notice)
  expect(screen.getByTestId('vk-provider-modal-shell')).toContainElement(notice)
  expect(screen.getByTestId('app-notification-layer')).not.toContainElement(notice)
  expect(notice).not.toHaveClass('fixed')
  expect(getComputedStyle(notice).position).not.toBe('fixed')
})

test('页面通知挂到共享悬浮层，弹窗通知仍以弹窗为锚点', async () => {
  const pending = deferred<unknown>()
  const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`
    if (key === 'GET /vk/v1/providers') return Promise.resolve(response(settings()))
    if (key === 'POST /vk/v1/providers/test') return pending.promise.then(response)
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: key }) })
  }))
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)

  const form = await screen.findByTestId('vk-provider-form')
  const section = screen.getByTestId('vk-provider-channels-section')
  expect(form).not.toHaveClass('relative')
  await user.click(screen.getByTestId('vk-channel-test-cheap'))
  const dialog = await openChannelEditor()
  pending.resolve({ ok: true, reason_code: 'ok', message: 'ok', models: [], normalization_notes: [] })

  const formSlot = (await screen.findByTestId('vk-provider-notice')).parentElement!
  const layer = screen.getByTestId('app-notification-layer')
  expect(layer).toContainElement(formSlot)
  expect(form).not.toContainElement(formSlot)
  expect(dialog).not.toContainElement(screen.getByTestId('vk-provider-notice'))
  expect(providerCss).toMatch(/\.vk-provider-alert-slot--modal\s*\{[^}]*position:\s*absolute;/s)
  expect(providerCss).toMatch(/\.vk-provider-alert-slot--modal\s*\{[^}]*top:\s*0;/s)
  expect(providerCss).toMatch(/\.vk-provider-alert-slot--modal\s*\{[^}]*transform:\s*translateX\(-50%\);/s)
  expect(providerCss).toMatch(/\.vk-provider-alert-slot\s*\{[^}]*pointer-events:\s*none;/s)
  expect(providerCss).toMatch(/\.vk-provider-alert-slot \.app-alert\s*\{[^}]*pointer-events:\s*auto;/s)
  expect(section).toBe(screen.getByTestId('vk-provider-channels-section'))
  expect(section.compareDocumentPosition(screen.getByTestId('vk-provider-routing-section')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

  expect(dialog).toHaveClass('relative')
  expect(screen.getByTestId('vk-provider-modal-shell')).toHaveClass('relative')
})

test('弹窗连接测试关闭后完成时不迁移到页面通知层', async () => {
  const pending = deferred<unknown>()
  const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`
    if (key === 'GET /vk/v1/providers') return Promise.resolve(response(settings()))
    if (key === 'POST /vk/v1/providers/test') return pending.promise.then(response)
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: key }) })
  }))
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)

  const dialog = await openChannelEditor()
  await user.click(within(dialog).getByRole('button', { name: '测试连接' }))
  await user.click(screen.getByRole('button', { name: '关闭模型配置弹窗' }))
  await act(async () => {
    pending.resolve({ ok: true, reason_code: 'ok', message: 'ok', models: [], normalization_notes: [] })
    await pending.promise
  })

  await waitFor(() => expect(screen.getByTestId('vk-channel-test-cheap')).toBeEnabled())
  expect(screen.getByTestId('app-notification-layer')).not.toContainElement(
    screen.queryByTestId('vk-provider-notice'),
  )
  expect(screen.queryByTestId('vk-provider-notice')).not.toBeInTheDocument()
})

test('旧后端无 generation probe 时使用前端实测耗时且不回显模型数', async () => {
  const pending = deferred<unknown>()
  const now = vi.spyOn(performance, 'now')
    .mockReturnValue(1000)
  const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`
    if (key === 'GET /vk/v1/providers') return Promise.resolve(response(settings()))
    if (key === 'POST /vk/v1/providers/test') return pending.promise.then(response)
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: key }) })
  }))
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)

  const testButton = await screen.findByTestId('vk-channel-test-cheap')
  await user.click(testButton)
  await waitFor(() => expect(testButton).toBeDisabled())
  now.mockReturnValue(1123)
  pending.resolve({
    ok: true, reason_code: 'ok', message: '连接正常，可用模型 2 个',
    models: ['m-a', 'm-b'], normalization_notes: [],
  })

  const notice = await screen.findByTestId('vk-provider-notice')
  expect(notice).toHaveTextContent('连接成功 · 123 ms')
  expect(notice).not.toHaveTextContent('可用模型')
  now.mockRestore()
})

test('获取模型列表与测试连接独立发送请求，连接测试不覆盖模型列表', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`
    if (key === 'GET /vk/v1/providers') return response(settings({
      channels: [channel({ extra_headers: { 'x-actor': 'desktop' } })],
    }))
    if (key === 'POST /vk/v1/providers/test') {
      bodies.push(JSON.parse(String(init?.body)))
      const generation = bodies.at(-1)?.probe_generation === true
      return response({
        ok: true, reason_code: 'ok', message: '连接正常',
        models: generation ? ['generated-model'] : ['listed-model'],
        reasoning_efforts: generation
          ? { 'generated-model': ['medium', 'high'] }
          : { 'listed-model': ['low'] },
        normalization_notes: [],
        ...(generation ? { generation_probe: {
          ok: true, reason_code: 'ok', message: '生成连接正常', model_reported: 'gpt-5.6-luna',
          transport_mode: 'sync_fallback', response_headers_ms: 10, first_event_ms: null,
          first_text_ms: null, total_ms: 88, stream_event_count: 0,
          upstream_response_id: null, request_may_still_run: false,
        } } : {}),
      })
    }
    return { ok: false, status: 404, json: async () => ({ error: key }) }
  }))
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)
  const dialog = await openChannelEditor()

  await user.click(within(dialog).getByRole('button', { name: '获取模型列表' }))
  await waitFor(() => expect(bodies).toHaveLength(1))
  await waitFor(() => expect(within(dialog).getByRole('button', { name: '获取模型列表' })).toBeEnabled())
  expect(await screen.findByTestId('vk-provider-notice')).toHaveTextContent('获取到 1 个模型')
  expect(bodies[0]).toEqual({
    base_url: 'https://api.example.com/v1',
    key_env: 'VK_CHANNEL_CHEAP_KEY',
    api_style: 'openai_completions',
    probe_generation: false,
  })

  await user.click(within(dialog).getByRole('button', { name: '测试连接' }))
  await waitFor(() => expect(bodies).toHaveLength(2))
  expect(bodies[1]).toEqual({
    base_url: 'https://api.example.com/v1',
    key_env: 'VK_CHANNEL_CHEAP_KEY',
    api_style: 'openai_completions',
    probe_generation: true,
    model_id: 'gpt-5.6-luna',
    reasoning_effort: 'medium',
    extra_headers: { 'x-actor': 'desktop' },
  })
  await screen.findByText('连接成功 · 同步 · 总耗时 88 ms')
  const notices = screen.getAllByTestId('vk-provider-notice')
  expect(notices).toHaveLength(2)
  expect(notices[0]).toHaveTextContent('连接成功 · 同步 · 总耗时 88 ms')
  expect(notices[1]).toHaveTextContent('获取到 1 个模型')
  const model = screen.getByTestId('vk-channel-model-cheap')
  await user.clear(model)
  expect(screen.getByRole('option', { name: 'listed-model' })).toBeInTheDocument()
})

test('model labels change display while selection and save keep the original ID', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers/test': { body: {
      ok: true, reason_code: 'ok', message: 'listed',
      models: ['gpt-6-sol', 'gpt-6-luna', 'unlabeled-model'],
      model_labels: { 'gpt-6-sol': 'GPT-6 Sol', 'gpt-6-luna': 'GPT-6 Luna' },
      reasoning_efforts: {}, normalization_notes: [],
    } },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)
  await openChannelEditor()

  await user.click(screen.getByTestId('vk-channel-models-fetch-cheap'))
  const model = screen.getByTestId('vk-channel-model-cheap')
  await user.clear(model)
  expect(screen.getByRole('option', { name: 'GPT-6 Sol' })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'GPT-6 Luna' })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'unlabeled-model' })).toBeInTheDocument()

  await user.click(screen.getByRole('option', { name: 'GPT-6 Sol' }))
  expect(model).toHaveValue('gpt-6-sol')
  await commitChannelEditor()

  await waitFor(() => expect(calls.some((call) => call.key === 'POST /vk/v1/providers')).toBe(true))
  const saved = calls.find((call) => call.key === 'POST /vk/v1/providers')!.body as { channels: { model_id: string }[] }
  expect(saved.channels[0].model_id).toBe('gpt-6-sol')
})

test('同一配置获取模型时仍可测试连接，两个按钮各自结束', async () => {
  const listed = deferred<unknown>()
  const tested = deferred<unknown>()
  let requestCount = 0
  const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`
    if (key === 'GET /vk/v1/providers') return Promise.resolve(response(settings()))
    if (key === 'POST /vk/v1/providers/test') {
      requestCount += 1
      return (requestCount === 1 ? listed : tested).promise.then(response)
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: key }) })
  }))
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)
  const dialog = await openChannelEditor()
  const fetchModels = within(dialog).getByRole('button', { name: '获取模型列表' })
  const testConnection = within(dialog).getByRole('button', { name: '测试连接' })

  await user.click(fetchModels)
  await waitFor(() => expect(fetchModels).toBeDisabled())
  expect(testConnection).toBeEnabled()

  await user.click(testConnection)
  await waitFor(() => expect(testConnection).toBeDisabled())
  expect(fetchModels).toBeDisabled()

  listed.resolve({
    ok: true, reason_code: 'ok', message: '列表已获取', models: ['listed-model'],
    reasoning_efforts: { 'listed-model': ['low'] }, normalization_notes: [],
  })
  await waitFor(() => expect(fetchModels).toBeEnabled())
  expect(testConnection).toBeDisabled()

  tested.resolve({
    ok: true, reason_code: 'ok', message: '连接正常', models: ['test-only-model'], normalization_notes: [],
    generation_probe: {
      ok: true, reason_code: 'ok', message: '生成连接正常', model_reported: 'gpt-5.6-luna',
      transport_mode: 'sync_fallback', response_headers_ms: 10, first_event_ms: null,
      first_text_ms: null, total_ms: 88, stream_event_count: 0,
      upstream_response_id: null, request_may_still_run: false,
    },
  })
  await waitFor(() => expect(testConnection).toBeEnabled())
  const model = screen.getByTestId('vk-channel-model-cheap')
  await user.clear(model)
  expect(screen.getByRole('option', { name: 'listed-model' })).toBeInTheDocument()
})

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

  const notice = await screen.findByTestId('vk-provider-notice')
  expect(notice).toHaveClass('app-alert')
  expect(notice).toHaveAttribute('data-tone', 'error')
  expect(notice).toHaveTextContent('已过期')
  expect(notice).toHaveTextContent('下一步：到中转站控制台重新签发一把 key')
  expect(screen.getByTestId('vk-channel-cheap')).toHaveTextContent('已启用')
  expect(screen.queryByTestId('vk-channel-result-cheap')).not.toBeInTheDocument()
  expect(screen.queryByTestId('vk-channel-fix-cheap')).not.toBeInTheDocument()
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

  await waitFor(() => expect(screen.getByTestId('vk-channel-cheap')).toHaveTextContent('api.example.com'))
  expect(screen.getByTestId('vk-channel-cheap')).toHaveTextContent('已启用')
  expect(screen.getByTestId('vk-provider-notice')).toHaveClass('app-alert')
  expect(screen.getByTestId('vk-provider-notice')).toHaveAttribute('data-tone', 'success')
  expect(screen.getByTestId('app-notification-layer')).toContainElement(screen.getByTestId('vk-provider-notice'))
  expect(screen.getByTestId('vk-provider-form')).not.toContainElement(screen.getByTestId('vk-provider-notice'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByTestId('vk-channel-result-cheap')).not.toBeInTheDocument()
  await openChannelEditor()
  await waitFor(() => expect((screen.getByTestId('vk-channel-url-cheap') as HTMLInputElement).value)
    .toBe('https://api.example.com/v1'))
  expect(screen.getByText('已自动补上 https://')).toBeInTheDocument()
  await userEvent.click(screen.getByTestId('vk-channel-models-fetch-cheap'))
  await screen.findByText('获取到 2 个模型')
  // 获取模型列表的结果做成下拉,省掉手抄。
  const model = screen.getByTestId('vk-channel-model-cheap')
  await userEvent.clear(model)
  expect(screen.getAllByRole('option')).toHaveLength(2)
})

// ── 其余 ────────────────────────────────────────────────────────────────

test('表单不再收单价', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
  render(<VkProviderForm baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('vk-channel-cheap')).toBeInTheDocument())
  expect(screen.queryByPlaceholderText(/输入单价/)).not.toBeInTheDocument()
  expect(screen.queryByPlaceholderText(/输出单价/)).not.toBeInTheDocument()
  expect(screen.getByTestId('vk-provider-form')).not.toHaveTextContent('单价未知')
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
  await openChannelEditor()
  await waitFor(() => expect(screen.getByTestId('vk-channel-style-cheap')).toBeInTheDocument())

  await chooseGlass(screen.getByTestId('vk-channel-style-cheap'), 'OpenAI Responses')
  await userEvent.click(screen.getByTestId('vk-channel-test-cheap'))
  await waitFor(() => expect(calls.some((c) => c.key.includes('providers/test'))).toBe(true))
  const test = calls.find((c) => c.key.includes('providers/test'))!.body as { api_style: string }
  expect(test.api_style).toBe('openai_responses')

  await commitChannelEditor()
  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const saved = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as { channels: { api_style: string }[] }
  expect(saved.channels[0].api_style).toBe('openai_responses')
})

// ── 从 cc-switch 一键读取 ────────────────────────────────────────────────

const CC_IMPORT = {
  channel: {
    id: 'hhcoding-sol', name: 'hhcoding sol', base_url: 'https://hhcoding.fun',
    model_id: 'gpt-5.6-sol', key_env: 'VK_CHANNEL_HHCODING_SOL_KEY',
    api_style: 'openai_responses',
    extra_headers: { 'x-openai-actor-authorization': 'local-image-extension' },
  },
  api_key: SECRET,
}

const CC_AVAILABLE = {
  available: true, path: 'C:/x/cc-switch.db', reason: '', skipped: [], candidates: [ccCandidate()],
}

test('没装 cc-switch 时不摆一个点不动的空按钮 —— 干脆不出现', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
  render(<VkProviderForm baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('vk-channel-add')).toBeInTheDocument())
  expect(screen.queryByTestId('vk-ccswitch-import')).not.toBeInTheDocument()
  expect(screen.queryByTestId('vk-ccswitch-codex:242d3850')).not.toBeInTheDocument()
  expect(screen.getByTestId('vk-provider-form')).not.toHaveTextContent('cc-switch')
})

test('cc-switch 使用带可访问名称的图标入口，候选仅在菜单中展示', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({ cc_switch: CC_AVAILABLE }) } })
  render(<VkProviderForm baseUrl={BASE} />)

  const trigger = await screen.findByTestId('vk-ccswitch-import')
  expect(trigger).toHaveAccessibleName('从 cc-switch 导入配置')
  expect(trigger).toHaveAttribute('title', '从 cc-switch 导入配置')
  expect(trigger.querySelector('img')).toHaveAttribute('src', '/cc-switch-icon.png')
  expect(screen.queryByTestId('vk-ccswitch-codex:242d3850')).not.toBeInTheDocument()
  await userEvent.click(trigger)
  const button = screen.getByTestId('vk-ccswitch-codex:242d3850')
  expect(button).toHaveTextContent('hhcoding sol')
  expect(button.getAttribute('title')).toContain('sk-1dbc65…862c')
  expect(document.body.textContent).not.toContain(SECRET)
})

test('cc-switch 候选菜单点击内部保留，点击外部自动收起', async () => {
  const user = userEvent.setup()
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({ cc_switch: CC_AVAILABLE }) } })
  render(<VkProviderForm baseUrl={BASE} />)

  await user.click(await screen.findByTestId('vk-ccswitch-import'))
  const menu = screen.getByTestId('vk-ccswitch-picker')
  expect(menu).toHaveClass('glass-menu-effect')
  expect(menu.parentElement).toBe(document.body)
  await user.click(menu)
  expect(screen.getByTestId('vk-ccswitch-picker')).toBeInTheDocument()

  await user.click(document.body)
  expect(screen.queryByTestId('vk-ccswitch-picker')).not.toBeInTheDocument()
})

test('模型列表菜单点击内部保留，点击外部自动收起', async () => {
  const user = userEvent.setup()
  stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers/test': { body: {
      ok: true, reason_code: 'ok', message: 'ok',
      models: ['gpt-5.6-luna', 'openai/gpt-5.6-sol-long-name'],
      reasoning_efforts: {}, normalization_notes: [],
    } },
  })
  render(<VkProviderForm baseUrl={BASE} />)

  await openChannelEditor()
  await user.click(screen.getByTestId('vk-channel-models-fetch-cheap'))
  const model = screen.getByTestId('vk-channel-model-cheap')
  await user.click(model)
  await user.clear(model)
  const listbox = screen.getByRole('listbox')
  await user.click(listbox)
  expect(screen.getByRole('listbox')).toBeInTheDocument()

  await user.click(document.body)
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
})

test('配置清单截断文本接入 OverflowTooltip，且不暴露完整 API key', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
  render(<VkProviderForm baseUrl={BASE} />)

  const name = await screen.findByTestId('vk-channel-name-cheap')
  expect(name.querySelector('.overflow-tooltip__label')).toHaveTextContent('GPT 5.6 Luna')
  expect(document.body.textContent).not.toContain(SECRET)
})

test('点某一条才拉明文,并把地址/模型/接口风格/请求头一起填进表单', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings({ channels: [], cc_switch: CC_AVAILABLE }) },
    'POST /vk/v1/providers/cc-switch': { body: CC_IMPORT },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  render(<VkProviderForm baseUrl={BASE} />)

  await userEvent.click(await screen.findByTestId('vk-ccswitch-import'))
  await userEvent.click(screen.getByTestId('vk-ccswitch-codex:242d3850'))
  await waitFor(() => expect(screen.getByTestId('vk-channel-hhcoding-sol')).toBeInTheDocument())
  expect(screen.getByTestId('vk-channel-url-hhcoding-sol')).toHaveValue('https://hhcoding.fun')
  expect(screen.getByTestId('vk-channel-style-hhcoding-sol')).toHaveAttribute('data-value', 'openai_responses')
  const keyInput = screen.getByTestId('vk-channel-key-hhcoding-sol') as HTMLInputElement
  const reveal = screen.getByTestId('vk-channel-reveal-hhcoding-sol')
  expect(keyInput.type).toBe('password')
  expect(keyInput.value).toBe(SECRET)
  expect(reveal).toBeEnabled()

  await userEvent.click(reveal)
  expect(keyInput.type).toBe('text')
  expect(keyInput.value).toBe(SECRET)
  await userEvent.click(reveal)
  expect(keyInput.type).toBe('password')
  expect(keyInput.value).toBe(SECRET)
  expect(calls.some((c) => c.key.includes('reveal'))).toBe(false)

  await commitChannelEditor()
  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const saved = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as {
    channels: { api_key: string; api_style: string; extra_headers: Record<string, string> }[]
  }
  expect(saved.channels[0].api_key).toBe(SECRET)
  expect(saved.channels[0].api_style).toBe('openai_responses')
  // 中转站要求的请求头丢了,有些站会直接拒 —— 必须原样带过保存。
  expect(saved.channels[0].extra_headers).toEqual({ 'x-openai-actor-authorization': 'local-image-extension' })
})

test('已存在的通道保存时不丢 extra_headers', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': {
      body: settings({ channels: [channel({ extra_headers: { 'x-relay-tag': 'vk' } })] }),
    },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-channel-cheap')).toBeInTheDocument())

  await openChannelEditor()
  await commitChannelEditor()
  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const saved = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as {
    channels: { extra_headers: Record<string, string> }[]
  }
  expect(saved.channels[0].extra_headers).toEqual({ 'x-relay-tag': 'vk' })
})

test('不可导入原因收进 cc-switch 候选菜单', async () => {
  stubRoutes({
    'GET /vk/v1/providers': {
      body: settings({ cc_switch: {
        ...CC_AVAILABLE, candidates: [],
        skipped: ['Claude:用的是 ANTHROPIC_AUTH_TOKEN(Bearer 认证),暂不支持,请手填'],
      } }),
    },
  })
  render(<VkProviderForm baseUrl={BASE} />)

  await userEvent.click(await screen.findByTestId('vk-ccswitch-import'))
  expect(screen.getByTestId('vk-ccswitch-skipped')).toHaveTextContent('AUTH_TOKEN')
})

test('两次连接通知最新在前并各自独立移除', async () => {
  stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers/test': { body: {
      ok: true, reason_code: 'ok', message: '连接正常', models: ['gpt-5.6-luna'],
      base_url: 'https://api.example.com/v1', normalization_notes: [],
    } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  const button = await screen.findByTestId('vk-channel-test-cheap')
  vi.useFakeTimers()
  try {
    await act(async () => { button.click() })
    expect(screen.getAllByTestId('vk-provider-notice')).toHaveLength(1)
    const firstNotice = screen.getByTestId('vk-provider-notice')
    act(() => vi.advanceTimersByTime(1000))
    await act(async () => { button.click() })
    const notices = screen.getAllByTestId('vk-provider-notice')
    expect(notices).toHaveLength(2)
    expect(notices[1]).toBe(firstNotice)
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getAllByTestId('vk-provider-notice')).toHaveLength(1)
    expect(firstNotice).not.toBeInTheDocument()
    expect(notices[0]).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.queryByTestId('vk-provider-notice')).not.toBeInTheDocument()
  } finally {
    vi.useRealTimers()
  }
})

test('连续保存错误叠加且只关闭选中的错误', async () => {
  stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers': { status: 500, body: { error: '保存失败' } },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await screen.findByTestId('vk-channel-toggle-cheap')
  vi.useFakeTimers()
  try {
    await act(async () => { screen.getByTestId('vk-channel-toggle-cheap').click() })
    const firstError = screen.getByTestId('vk-provider-error')
    act(() => vi.advanceTimersByTime(1000))
    await act(async () => { screen.getByTestId('vk-channel-toggle-cheap').click() })
    const errors = screen.getAllByTestId('vk-provider-error')
    expect(errors).toHaveLength(2)
    expect(errors[1]).toBe(firstError)
    act(() => { within(firstError).getByRole('button', { name: '关闭通知' }).click() })
    expect(screen.getByTestId('vk-provider-error')).toBe(errors[0])
    act(() => vi.advanceTimersByTime(1999))
    expect(errors[0]).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByTestId('vk-provider-error')).not.toBeInTheDocument()
  } finally {
    vi.useRealTimers()
  }
})
