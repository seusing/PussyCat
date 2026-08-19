import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VkProviderForm } from './VkProviderForm'

const BASE = 'http://127.0.0.1:9999'
const SECRET = 'sk-relay-DO-NOT-LEAK-0123456789'

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

afterEach(() => { vi.unstubAllGlobals() })

async function openChannelEditor(id = 'cheap') {
  await userEvent.click(await screen.findByTestId(`vk-channel-edit-${id}`))
  return screen.getByRole('dialog', { name: '编辑配置' })
}

async function commitChannelEditor() {
  await userEvent.click(screen.getByTestId('vk-provider-modal-submit'))
}

// ── key 的进出 ──────────────────────────────────────────────────────────

test('已保存的 key 以打码值示人 —— 空输入框会被当成"没设过"', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
  render(<VkProviderForm baseUrl={BASE} />)

  await openChannelEditor()
  await waitFor(() => expect(screen.getByTestId('vk-channel-key-cheap')).toBeInTheDocument())
  const input = screen.getByTestId('vk-channel-key-cheap') as HTMLInputElement
  expect(input.value).toBe('••••••••••••••••')
  expect(input.readOnly).toBe(true)
  expect(document.body.textContent).not.toContain(SECRET)
})

test('点击已保存 key 输入框后进入编辑状态', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await openChannelEditor()
  const input = screen.getByTestId('vk-channel-key-cheap') as HTMLInputElement
  await userEvent.click(input)
  expect(input.value).toBe('')
  expect(input.readOnly).toBe(false)
  expect(input.type).toBe('password')

  await userEvent.type(input, 'sk-brand-new')
  await commitChannelEditor()
  await userEvent.click(screen.getByTestId('vk-provider-save'))
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

test('再点一次隐藏,退回打码值', async () => {
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

  expect((screen.getByTestId('vk-channel-key-cheap') as HTMLInputElement).value).toBe('••••••••••••••••')
})


test('没碰过的 key 不提交 —— 表示"别动已存的那把"', async () => {
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
  expect(effort.value).toBe('')
  expect(effort).toBeEnabled()
  await userEvent.click(screen.getByTestId('vk-channel-test-cheap'))
  await waitFor(() => expect(effort).toBeEnabled())
  const options = document.querySelectorAll('#vk-channel-reasoning-options-cheap option')
  expect([...options].map((option) => (option as HTMLOptionElement).value))
    .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  await userEvent.type(effort, 'max')
  await commitChannelEditor()
  await userEvent.click(screen.getByTestId('vk-provider-save'))

  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const body = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as { channels: { reasoning_effort: string }[] }
  expect(body.channels[0].reasoning_effort).toBe('max')
})

test('中转站未返回推理档位时明确说明原因并保持自动', async () => {
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

  await userEvent.click(screen.getByTestId('vk-channel-test-cheap'))
  await screen.findByTestId('vk-channel-reasoning-note-cheap')
  expect(effort).toBeEnabled()
  expect(effort.value).toBe('')
  expect(screen.getByTestId('vk-channel-reasoning-note-cheap')).toHaveTextContent('中转站未返回可枚举档位')
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
  await userEvent.type(effort, 'max')
  await commitChannelEditor()
  await userEvent.click(screen.getByTestId('vk-provider-save'))

  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const body = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as { channels: { reasoning_effort: string | null }[] }
  expect(body.channels[0].reasoning_effort).toBe('max')
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

test('没指到通道的角色被点名 —— 跑到那一步才失败更糟', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({
    configured: false, unassigned_roles: ['basic'],
  }) } })
  render(<VkProviderForm baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('vk-unassigned')).toHaveTextContent('基础处理'))
})


test('删掉一条通道,指到它的角色一并解绑', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings({
      channels: [channel(), channel({ id: 'smart', name: 'Sol' })],
      role_assignments: { deep_analysis: 'cheap', basic: 'smart' },
    }) },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  render(<VkProviderForm baseUrl={BASE} />)
  await waitFor(() => expect(screen.getByTestId('vk-channel-remove-cheap')).toBeInTheDocument())

  await userEvent.click(screen.getByTestId('vk-channel-remove-cheap'))
  expect(screen.queryByTestId('vk-channel-cheap')).not.toBeInTheDocument()

  await userEvent.click(screen.getByTestId('vk-provider-save'))
  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const body = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as { roles: Record<string, string> }
  expect(body.roles).toEqual({ basic: 'smart' })
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

  await user.click(create)
  expect(screen.getByRole('dialog', { name: '创建配置' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '关闭模型配置弹窗' })).toBeInTheDocument()
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

test('保存成功后通知父级收起配置', async () => {
  const onSaved = vi.fn()
  stubRoutes({
    'GET /vk/v1/providers': { body: settings() },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  render(<VkProviderForm baseUrl={BASE} onSaved={onSaved} />)

  await userEvent.click(await screen.findByTestId('vk-provider-save'))
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
})

test('启用与禁用按钮使用锁图标并保持状态图标', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
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
  expect(reusedKey.value).toBe('••••••••••••••••')
  expect(reusedKey.readOnly).toBe(true)
  await user.clear(reusedModel)
  await user.type(reusedModel, 'gpt-5.6-sol')
  expect(screen.getByTestId('vk-channel-cheap')).toHaveTextContent('gpt-5.6-luna')

  await user.click(within(dialog).getByTestId('vk-provider-modal-submit'))
  await user.click(screen.getByTestId('vk-provider-save'))
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
  const style = () => screen.getByDisplayValue(/OpenAI|Anthropic/) as HTMLSelectElement

  await userEvent.type(model, 'gpt-5.6-luna')
  expect(style().value).toBe('openai_responses')

  await userEvent.clear(model)
  await userEvent.type(model, 'claude-opus-4-6')
  expect(style().value).toBe('anthropic_messages')

  // 用户自己选过之后,再改模型名不再覆盖他的选择。
  await userEvent.selectOptions(style(), 'openai_completions')
  await userEvent.clear(model)
  await userEvent.type(model, 'gpt-5.6-sol')
  expect(style().value).toBe('openai_completions')
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

test('两个角色各有主通道下拉,未指派时明确为空', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings() } })
  render(<VkProviderForm baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('vk-role-deep_analysis')).toBeInTheDocument())
  expect(screen.getByTestId('vk-role-basic')).toBeInTheDocument()
  // 中文名由后端给,前端不自己编
  expect(screen.getByText('深度分析')).toBeInTheDocument()
  expect(screen.getByText('基础处理')).toBeInTheDocument()
  expect((screen.getByTestId('vk-role-deep_analysis') as HTMLSelectElement).value).toBe('')
  expect(screen.getByTestId('vk-role-routing-note')).toHaveTextContent('不会换通道掩盖配置问题')
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

test('备用通道按用户排序保存,并明确只在临时上游错误时切换', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings({
      channels: [
        channel(),
        channel({ id: 'backup-a', name: '备用 A', base_url: 'https://a.example/v1' }),
        channel({ id: 'backup-b', name: '备用 B', base_url: 'https://b.example/v1' }),
      ],
      role_assignments: { basic: 'cheap' },
      role_fallbacks: { basic: ['backup-a', 'backup-b'] },
      role_routes: { basic: ['cheap', 'backup-a', 'backup-b'] },
    }) },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)

  const first = await screen.findByTestId('vk-role-fallback-basic-0')
  expect(first).toHaveValue('backup-a')
  expect(screen.getByTestId('vk-role-fallback-basic-1')).toHaveValue('backup-b')
  await user.click(screen.getByRole('button', { name: '下移基础处理备用 1' }))
  expect(screen.getByTestId('vk-role-fallback-basic-0')).toHaveValue('backup-b')
  await user.click(screen.getByTestId('vk-provider-save'))

  await waitFor(() => expect(calls.some((call) => call.key === 'POST /vk/v1/providers')).toBe(true))
  const body = calls.find((call) => call.key === 'POST /vk/v1/providers')!.body as {
    role_fallbacks: Record<string, string[]>
  }
  expect(body.role_fallbacks.basic).toEqual(['backup-b', 'backup-a'])
  expect(screen.getByTestId('vk-role-routing-note')).toHaveTextContent('仅超时、429 或上游 5xx')
})

test('添加备用不会提供主通道或已经选过的通道', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({
    channels: [channel(), channel({ id: 'backup', name: '备用' })],
    role_assignments: { basic: 'cheap' },
  }) } })
  const user = userEvent.setup()
  render(<VkProviderForm baseUrl={BASE} />)

  await user.click(await screen.findByTestId('vk-role-fallback-add-basic'))
  expect(screen.getByTestId('vk-role-fallback-basic-0')).toHaveValue('backup')
  expect(screen.getByTestId('vk-role-fallback-add-basic')).toBeDisabled()
})

test('同一上游的主备只提醒不替用户改配置', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({
    channels: [channel(), channel({ id: 'backup', name: '备用' })],
    role_assignments: { basic: 'cheap' },
    role_fallbacks: { basic: ['backup'] },
    role_route_warnings: { basic: ['主通道和备用 1 来自同一上游，故障时可能一起不可用'] },
  }) } })
  render(<VkProviderForm baseUrl={BASE} />)

  expect(await screen.findByTestId('vk-role-warning-basic')).toHaveTextContent('同一上游')
  expect(screen.getByTestId('vk-role-fallback-basic-0')).toHaveValue('backup')
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
  expect(await screen.findByTestId('vk-channel-invalid-cheap')).toHaveTextContent('不会自动删除')
  await user.click(screen.getByTestId('vk-channel-toggle-cheap'))
  expect(screen.getByTestId('vk-channel-disabled-cheap')).toBeInTheDocument()
  expect(screen.getByTestId('vk-channel-cheap')).toBeInTheDocument()
  await user.click(screen.getByTestId('vk-provider-save'))
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

  await waitFor(() => expect(screen.getByTestId('vk-channel-cheap')).toHaveTextContent('api.example.com'))
  await openChannelEditor()
  await waitFor(() => expect((screen.getByTestId('vk-channel-url-cheap') as HTMLInputElement).value)
    .toBe('https://api.example.com/v1'))
  expect(screen.getByText('已自动补上 https://')).toBeInTheDocument()
  // 测出来的模型名做成下拉,省掉手抄
  expect(document.querySelectorAll('#vk-models-cheap option')).toHaveLength(2)
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

  await userEvent.selectOptions(screen.getByTestId('vk-channel-style-cheap'), 'openai_responses')
  await userEvent.click(screen.getByTestId('vk-channel-test-cheap'))
  await waitFor(() => expect(calls.some((c) => c.key.includes('providers/test'))).toBe(true))
  const test = calls.find((c) => c.key.includes('providers/test'))!.body as { api_style: string }
  expect(test.api_style).toBe('openai_responses')

  await commitChannelEditor()
  await userEvent.click(screen.getByTestId('vk-provider-save'))
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
  expect(screen.queryByTestId('vk-ccswitch-codex:242d3850')).not.toBeInTheDocument()
  expect(screen.getByTestId('vk-provider-form')).not.toHaveTextContent('cc-switch')
})

test('列出的候选只带打码 key —— 浏览这一步不该摊开所有中转站的明文', async () => {
  stubRoutes({ 'GET /vk/v1/providers': { body: settings({ cc_switch: CC_AVAILABLE }) } })
  render(<VkProviderForm baseUrl={BASE} />)

  const button = await screen.findByTestId('vk-ccswitch-codex:242d3850')
  expect(button).toHaveTextContent('hhcoding sol')
  expect(button.getAttribute('title')).toContain('sk-1dbc65…862c')
  expect(document.body.textContent).not.toContain(SECRET)
})

test('点某一条才拉明文,并把地址/模型/接口风格/请求头一起填进表单', async () => {
  const { calls } = stubRoutes({
    'GET /vk/v1/providers': { body: settings({ channels: [], cc_switch: CC_AVAILABLE }) },
    'POST /vk/v1/providers/cc-switch': { body: CC_IMPORT },
    'POST /vk/v1/providers': { body: SAVE_OK },
  })
  render(<VkProviderForm baseUrl={BASE} />)

  await userEvent.click(await screen.findByTestId('vk-ccswitch-codex:242d3850'))
  await waitFor(() => expect(screen.getByTestId('vk-channel-hhcoding-sol')).toBeInTheDocument())
  expect(screen.getByTestId('vk-channel-url-hhcoding-sol')).toHaveValue('https://hhcoding.fun')
  expect(screen.getByTestId('vk-channel-style-hhcoding-sol')).toHaveValue('openai_responses')

  await commitChannelEditor()
  await userEvent.click(screen.getByTestId('vk-provider-save'))
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

  await userEvent.click(screen.getByTestId('vk-provider-save'))
  await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/providers')).toBe(true))
  const saved = calls.find((c) => c.key === 'POST /vk/v1/providers')!.body as {
    channels: { extra_headers: Record<string, string> }[]
  }
  expect(saved.channels[0].extra_headers).toEqual({ 'x-relay-tag': 'vk' })
})

test('导不了的那些附原因列出来 —— 比让它凭空消失强', async () => {
  stubRoutes({
    'GET /vk/v1/providers': {
      body: settings({ cc_switch: {
        ...CC_AVAILABLE, candidates: [],
        skipped: ['Claude:用的是 ANTHROPIC_AUTH_TOKEN(Bearer 认证),暂不支持,请手填'],
      } }),
    },
  })
  render(<VkProviderForm baseUrl={BASE} />)

  await waitFor(() => expect(screen.getByTestId('vk-ccswitch')).toHaveTextContent('AUTH_TOKEN'))
})
