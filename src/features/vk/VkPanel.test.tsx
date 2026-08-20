import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VkPanel } from './VkPanel'
import { useAppStore } from '../../store/appStore'
import type { VkProcessingRequest } from '../../host/vkClient'
import { saveTextFileAs } from '../../lib/saveTextFile'
import { VK_OPEN_OUTPUT_EVENT } from './taskUiState'

vi.mock('../../lib/saveTextFile', () => ({ saveTextFileAs: vi.fn() }))

const initialState = useAppStore.getState()
beforeEach(() => {
  vi.useRealTimers()
  vi.mocked(saveTextFileAs).mockReset().mockResolvedValue(true)
  useAppStore.setState(initialState, true)
})

const BASE = 'http://127.0.0.1:9999'

const HEALTH = {
  status: 'ok',
  reasonCode: 'ok',
  summary: 'video-knowledge sidecar 就绪',
  apiVersion: '1.2.0',
  packageVersion: '0.1.0',
  capabilities: [{ capability: 'query_ready', runtime: 'ready', detail: null }],
  checkedAt: '2026-08-01T00:00:00.000Z',
  retryable: false,
}

function resolvedRequest(overrides: Partial<VkProcessingRequest> = {}): VkProcessingRequest {
  return {
    schema_version: '1.1.0',
    source: 'https://example.com/v',
    intent: 'summarize',
    preset: 'quick-summary',
    preset_version: '1.0.0',
    content_type: 'auto',
    media_policy: 'audio_transcript',
    output_targets: ['markdown_note', 'quick_summary'],
    language: 'auto',
    processing_depth: 'balanced',
    budget_profile: 'economy',
    provider_profile: 'default',
    audit_requested: false,
    requested_capabilities: [],
    user_metadata: {},
    max_cost_cny: 1.5,
    ...overrides,
  }
}

type Route = { status?: number; body: unknown | (() => unknown | Promise<unknown>) }

function stubRoutes(routes: Record<string, Route>) {
  const calls: Array<{ key: string; init?: RequestInit }> = []
  // 显式参数类型:calls[i] 才能被 tsc 正确推断(仓内 BrowserBridgeStatus.test 同款)
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const pathname = new URL(url).pathname
    const key = `${init?.method ?? 'GET'} ${pathname}`
    calls.push({ key, init })
    const route = routes[key]
    if (!route) return {
      ok: false,
      status: 404,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ error: `no stub for ${key}` }),
      text: async () => JSON.stringify({ error: `no stub for ${key}` }),
    }
    const body = typeof route.body === 'function' ? await route.body() : route.body
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      headers: new Headers({
        'content-type': typeof body === 'string' ? 'text/markdown; charset=utf-8' : 'application/json',
      }),
      json: async () => body,
      text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    }
  })
  vi.stubGlobal('fetch', impl)
  return { calls }
}

describe('VkPanel', () => {
  // —— 一句结论:正常时整块只有一行,出问题才出现按钮 ——
  const RUNTIME_INSTALLED = {
    state: 'installed', version: 'v1', reasonCode: null, summary: '解析引擎已就绪(0.1.0)',
    pythonPath: 'C:\dev\python.exe', source: 'external', log: [],
  }
  const candidate = (over: Record<string, unknown> = {}) => ({
    pythonPath: 'C:\dev\python.exe', source: 'developer-venv', version: '0.1.0',
    apiVersion: '1.4.0', schemaVersion: '1.1.0', compatible: true, reason: null,
    capabilities: [{ capability: 'query_ready', runtime: 'ready', detail: null }],
    ...over,
  })

  it('引擎和模型通道都就绪时不渲染健康状态条', async () => {
    const { calls } = stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'POST /vk/v1/runtime/detect': { body: { candidates: [candidate({ active: true })], checkedAt: 'x' } },
      'GET /vk/v1/providers': { body: { channels: [], roles: {}, role_assignments: {}, role_labels: {}, role_hints: {}, unassigned_roles: [], api_styles: [], importable: [], cc_switch: { available: false, path: '', reason: '', skipped: [], candidates: [] }, configured: true } },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => {
      expect(calls.some((c) => c.key === 'GET /vk/v1/providers')).toBe(true)
    })
    expect(screen.queryByTestId('vk-verdict')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vk-refresh')).not.toBeInTheDocument()
  })

  it('正常时版面上没有健康状态动作', async () => {
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'POST /vk/v1/runtime/detect': { body: { candidates: [candidate({ active: true })], checkedAt: 'x' } },
      'GET /vk/v1/providers': { body: { channels: [], roles: {}, role_assignments: {}, role_labels: {}, role_hints: {}, unassigned_roles: [], api_styles: [], importable: [], cc_switch: { available: false, path: '', reason: '', skipped: [], candidates: [] }, configured: true } },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(screen.queryByTestId('vk-verdict')).not.toBeInTheDocument())

    expect(screen.queryByTestId('vk-refresh')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vk-runtime-details-toggle')).not.toBeInTheDocument()
  })

  it('模型通道没配时阻止提交并显示顶部提醒', async () => {
    // 真机上的原始症状:下载 + 转写成功耗时 7m33s,最后一步 401。通道不通必须在
    // 第 1 秒可见,而不是第 7.5 分钟。
    const { calls } = stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'POST /vk/v1/runtime/detect': { body: { candidates: [candidate({ active: true })], checkedAt: 'x' } },
      'GET /vk/v1/providers': { body: { relay_base_url: '', tiers: {}, stage_tiers: {}, price_snapshot_id: 'v14', configured: false } },
    })
    render(<VkPanel baseUrl={BASE} />)

    await waitFor(() => expect(screen.getByTestId('vk-verdict')).toHaveTextContent('请完成模型配置选择'))
    expect(screen.getByTestId('vk-verdict-action')).toHaveTextContent('去配置')
    await userEvent.type(screen.getByTestId('vk-source'), 'https://example.com/blocked')
    await userEvent.click(screen.getByTestId('vk-submit-button'))

    expect(calls.some((call) => call.key === 'POST /vk/v1/preview')).toBe(false)
    expect(calls.some((call) => call.key === 'POST /vk/v1/jobs')).toBe(false)
    expect(screen.getByTestId('vk-task-banner')).toHaveTextContent('请先完成模型配置选择')
    expect(screen.getByTestId('vk-task-banner')).toHaveAttribute('data-tone', 'warning')
    expect(useAppStore.getState().activeModule).not.toBe('providers')
    expect(screen.getByTestId('vk-verdict-note')).toHaveTextContent('请选择基础处理和深度分析使用的模型配置。')
  })

  it('配好之后回到一句就绪,视频页不再渲染模型配置入口或表单', async () => {
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'POST /vk/v1/runtime/detect': { body: { candidates: [candidate({ active: true })], checkedAt: 'x' } },
      'GET /vk/v1/providers': { body: { relay_base_url: 'https://x/v1', tiers: {}, stage_tiers: {}, price_snapshot_id: 'v14', configured: true } },
    })
    render(<VkPanel baseUrl={BASE} />)

    await waitFor(() => expect(screen.queryByTestId('vk-verdict')).not.toBeInTheDocument())
    expect(screen.queryByTestId('vk-provider-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vk-provider-form')).not.toBeInTheDocument()
  })

  it('能力提示读取当前健康回执,不会继续显示旧候选快照的缺失能力', async () => {
    const liveHealth = {
      ...HEALTH,
      capabilities: [
        { capability: 'query_ready', runtime: 'ready', detail: null },
        { capability: 'word_timestamps', runtime: 'ready', detail: null },
        { capability: 'speaker_diarization', runtime: 'ready', detail: null },
      ],
    }
    stubRoutes({
      'GET /vk/v1/health': { body: liveHealth },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'POST /vk/v1/runtime/detect': {
        body: { candidates: [candidate({ active: true, capabilities: [
          { capability: 'word_timestamps', runtime: 'missing_dependency', detail: null },
          { capability: 'speaker_diarization', runtime: 'missing_dependency', detail: null },
        ] })], checkedAt: 'x' },
      },
      'GET /vk/v1/providers': { body: { channels: [], roles: {}, role_assignments: {}, role_labels: {}, role_hints: {}, unassigned_roles: [], api_styles: [], importable: [], cc_switch: { available: false, path: '', reason: '', skipped: [], candidates: [] }, configured: true } },
    })
    render(<VkPanel baseUrl={BASE} />)

    await waitFor(() => expect(screen.queryByTestId('vk-verdict')).not.toBeInTheDocument())
    expect(screen.queryByTestId('vk-verdict-note')).not.toBeInTheDocument()
  })

  it('视频页保留能力中心,但模型配置独立于视频任务表单', async () => {
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'POST /vk/v1/runtime/detect': { body: { candidates: [candidate({ active: true })], checkedAt: 'x' } },
      'GET /vk/v1/providers': { body: { configured: true, channels: [], roles: {}, role_assignments: {}, role_labels: {}, role_hints: {}, unassigned_roles: [], api_styles: [], importable: [], cc_switch: { available: false, path: '', reason: '', skipped: [], candidates: [] } } },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(screen.queryByTestId('vk-verdict')).not.toBeInTheDocument())
    expect(screen.getByTestId('vk-capability-toggle')).toBeInTheDocument()
    expect(screen.queryByTestId('vk-provider-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vk-provider-form')).not.toBeInTheDocument()
  })

  it('一切正常时不渲染引擎状态条', async () => {
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'POST /vk/v1/runtime/detect': { body: { candidates: [candidate({ active: true })], checkedAt: 'x' } },
    })
    render(<VkPanel baseUrl={BASE} />)

    await waitFor(() => expect(screen.queryByTestId('vk-verdict')).not.toBeInTheDocument())
    expect(screen.queryByTestId('vk-verdict-action')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vk-developer-details')).not.toBeInTheDocument()
  })

  it('引擎没装时给一句人话 + 一个按钮,而不是一段说明书', async () => {
    stubRoutes({
      'GET /vk/v1/health': { body: { ...HEALTH, status: 'stopped' } },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': { body: { state: 'not-installed', version: null, reasonCode: null, summary: '尚未安装', pythonPath: null, source: null, log: [] } },
    })
    render(<VkPanel baseUrl={BASE} />)

    await waitFor(() => expect(screen.getByTestId('vk-verdict')).toHaveTextContent('解析引擎还没准备好'))
    expect(screen.getByTestId('vk-verdict-action')).toHaveTextContent('一键准备')
  })

  it('装失败时按钮是「重试」,并如实带上失败原因', async () => {
    stubRoutes({
      'GET /vk/v1/health': { body: { ...HEALTH, status: 'failed' } },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': { body: { state: 'failed', version: null, reasonCode: 'install-failed', summary: '磁盘空间不足', pythonPath: null, source: null, log: [] } },
    })
    render(<VkPanel baseUrl={BASE} />)

    await waitFor(() => expect(screen.getByTestId('vk-verdict')).toHaveTextContent('解析环境没装成功'))
    expect(screen.getByTestId('vk-verdict-action')).toHaveTextContent('重试')
    expect(screen.getByTestId('vk-verdict-note')).toHaveTextContent('磁盘空间不足')
  })

  it('捆绑件缺失时不给按钮 —— 点了没用的按钮比没有按钮更糟', async () => {
    stubRoutes({
      'GET /vk/v1/health': { body: { ...HEALTH, status: 'not-configured' } },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': { body: { state: 'not-available', version: null, reasonCode: 'bundle-missing', summary: '安装件缺失', pythonPath: null, source: null, log: [] } },
    })
    render(<VkPanel baseUrl={BASE} />)

    await waitFor(() => expect(screen.getByTestId('vk-verdict')).toHaveTextContent('解析引擎不可用'))
    expect(screen.queryByTestId('vk-verdict-action')).not.toBeInTheDocument()
  })

  it('进面板自动检测并切到能力最全的环境 —— 不让用户去点检测再去挑', async () => {
    const weak = candidate({
      pythonPath: 'C:\app\python.exe', source: 'app-owned', active: true,
      capabilities: [{ capability: 'query_ready', runtime: 'ready', detail: null }, { capability: 'visual_evidence', runtime: 'missing_dependency', detail: null }],
    })
    const strong = candidate({
      pythonPath: 'C:\dev\python.exe', source: 'developer-venv',
      capabilities: [{ capability: 'query_ready', runtime: 'ready', detail: null }, { capability: 'visual_evidence', runtime: 'ready', detail: null }],
    })
    const { calls } = stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'POST /vk/v1/runtime/detect': { body: { candidates: [weak, strong], checkedAt: 'x' } },
      'POST /vk/v1/runtime/adopt': { body: RUNTIME_INSTALLED },
    })
    render(<VkPanel baseUrl={BASE} />)

    await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/runtime/adopt')).toBe(true))
    const adopt = calls.find((c) => c.key === 'POST /vk/v1/runtime/adopt')!
    expect(String(adopt.init?.body)).toContain('dev')   // 切到强的那个,不是当前那个弱的
  })

  it('已经在最强环境上时一次 adopt 都不发 —— 每次切换都要重启 sidecar', async () => {
    const only = candidate({ active: true })
    const { calls } = stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'POST /vk/v1/runtime/detect': { body: { candidates: [only], checkedAt: 'x' } },
    })
    render(<VkPanel baseUrl={BASE} />)

    await waitFor(() => expect(calls.some((c) => c.key === 'POST /vk/v1/runtime/detect')).toBe(true))
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.some((c) => c.key === 'POST /vk/v1/runtime/adopt')).toBe(false)
  })

  it('renders every submission control without the removed developer and preview sections', async () => {
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(screen.queryByTestId('vk-verdict')).not.toBeInTheDocument())
    for (const id of ['vk-source', 'vk-user-goal', 'vk-preset', 'vk-content-type', 'vk-media-policy',
      'vk-budget-profile', 'vk-max-cost', 'vk-reasoning-effort', 'vk-audit',
      'vk-cap-word_timestamps', 'vk-cap-speaker_diarization', 'vk-cap-visual_evidence',
      'vk-cap-query_ready', 'vk-submit-button',
      'vk-query-input', 'vk-jobs-refresh', 'vk-capability-toggle']) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    expect(screen.queryByTestId('vk-preview-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vk-developer-details')).not.toBeInTheDocument()
    expect(screen.getByTestId('vk-advanced-settings')).not.toHaveAttribute('open')
    expect(screen.getByTestId('vk-preset')).toHaveAccessibleName('结果模板（可选）')
    expect(screen.queryByTestId('vk-processing-depth')).not.toBeInTheDocument()
    expect(screen.getByTestId('vk-advanced-settings')).toContainElement(
      screen.getByTestId('vk-reasoning-effort'),
    )
    expect(screen.getByRole('option', { name: '快速总结' })).toHaveValue('quick-summary')
    expect(screen.queryByText('新解析任务')).not.toBeInTheDocument()
    expect(screen.queryByText('视频链接')).not.toBeInTheDocument()
    expect(screen.getByTestId('vk-source')).toHaveAttribute('rows', '6')
    expect(screen.getByRole('button', { name: '导入链接文件' })).toHaveAttribute('title', '导入链接文件')
    expect(screen.getByRole('button', { name: '导入链接文件' })).toHaveAttribute('data-tooltip', '导入链接文件')
    expect(screen.getByRole('button', { name: '导入链接文件' })).toHaveClass('vk-source-file-input')
    expect(screen.getByTestId('vk-source-file')).toHaveAttribute('accept', '.txt,.csv,.md,text/plain,text/csv')
  })

  it('imports a newline-delimited text file, removes duplicates, and identifies each source', async () => {
    const user = userEvent.setup()
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
    })
    render(<VkPanel baseUrl={BASE} />)

    const file = new File([
      'https://youtu.be/video-1\r\n',
      'https://www.bilibili.com/video/BV1\n',
      'https://youtu.be/video-1\n',
    ], 'video-links.txt', { type: 'text/plain' })
    await user.upload(screen.getByTestId('vk-source-file'), file)

    await waitFor(() => {
      expect((screen.getByTestId('vk-source') as HTMLTextAreaElement).value).toBe(
        'https://youtu.be/video-1\nhttps://www.bilibili.com/video/BV1',
      )
    })
    expect(screen.getByTestId('video-source-card-youtube')).toHaveAttribute('data-count', '1')
    expect(screen.getByTestId('video-source-card-bilibili')).toHaveAttribute('data-count', '1')
  })

  it('previews and submits directly from the submit button without a cost dialog', async () => {
    const user = userEvent.setup()
    const { calls } = stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'POST /vk/v1/preview': { body: resolvedRequest({ reasoning_effort: 'max', user_metadata: { processing_strategy: 'auto', user_goal: '重点比较价格和耗电' } }) },
      'POST /vk/v1/jobs': { status: 201, body: { job_id: 'job-1', kind: 'request' } },
    })
    render(<VkPanel baseUrl={BASE} />)
    await user.type(screen.getByTestId('vk-source'), 'https://example.com/v')
    await user.type(screen.getByTestId('vk-user-goal'), '重点比较价格和耗电')
    await user.type(screen.getByTestId('vk-max-cost'), '1.5')
    await user.type(screen.getByTestId('vk-reasoning-effort'), 'max')
    await user.click(screen.getByTestId('vk-submit-button'))
    const previewCall = calls.find((item) => item.key === 'POST /vk/v1/preview')
    expect(previewCall).toBeDefined()
    const projection = JSON.parse(String(previewCall!.init!.body))
    expect(projection).toMatchObject({ source: 'https://example.com/v', preset: 'quick-summary', max_cost_cny: 1.5, reasoning_effort: 'max', user_metadata: { user_goal: '重点比较价格和耗电' } })
    expect(projection).not.toHaveProperty('processing_depth')
    expect(projection).not.toHaveProperty('quality_profile')
    await waitFor(() => {
      expect(calls.some((item) => item.key === 'POST /vk/v1/jobs')).toBe(true)
    })
    const submit = calls.find((item) => item.key === 'POST /vk/v1/jobs')
    const payload = JSON.parse(String(submit!.init!.body))
    expect(payload).toMatchObject({
      request: { source: 'https://example.com/v', preset: 'quick-summary', processing_depth: 'balanced', max_cost_cny: 1.5, reasoning_effort: 'max', user_metadata: { processing_strategy: 'auto', user_goal: '重点比较价格和耗电' } },
    })
    expect(payload.idempotency_key).toMatch(/[0-9a-f-]{36}/)
    expect(payload.client_job_id).toMatch(/[0-9a-f-]{36}/)
    expect(screen.queryByTestId('vk-cost-dialog')).toBeNull()
    const banner = await screen.findByTestId('vk-task-banner')
    expect(banner).toHaveTextContent('\u4efb\u52a1\u5df2\u63d0\u4ea4')
    expect(banner).toHaveAttribute('data-tone', 'info')
    expect(banner).toHaveClass('is-info')
    expect(banner).toHaveClass('vk-task-banner')
    expect(banner.closest('.vk-task-banners')).toHaveClass('vk-task-banners')
    const progress = screen.getByTestId('vk-task-banner-progress')
    expect(progress).toHaveClass('is-info')
    expect(Number(progress.getAttribute('aria-valuenow'))).toBeGreaterThan(90)

    await user.click(screen.getByRole('button', { name: '\u5173\u95ed\u4efb\u52a1\u63d0\u9192' }))
    expect(screen.queryByTestId('vk-task-banner')).not.toBeInTheDocument()
  })

  it('does not expose processing depth and sends the optional user goal', async () => {
    const user = userEvent.setup()
    const { calls } = stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'POST /vk/v1/preview': { body: resolvedRequest({ user_metadata: { user_goal: '整理操作步骤' } }) },
      'POST /vk/v1/jobs': { status: 201, body: { job_id: 'job-auto', kind: 'request' } },
    })
    render(<VkPanel baseUrl={BASE} />)
    await user.type(screen.getByTestId('vk-source'), 'https://example.com/auto')
    await user.type(screen.getByTestId('vk-user-goal'), '整理操作步骤')
    await user.click(screen.getByTestId('vk-submit-button'))

    await waitFor(() => {
      expect(calls.some((item) => item.key === 'POST /vk/v1/preview')).toBe(true)
    })
    const previewCall = calls.find((item) => item.key === 'POST /vk/v1/preview')!
    const projection = JSON.parse(String(previewCall.init?.body))
    expect(projection).not.toHaveProperty('processing_depth')
    expect(projection.user_metadata).toEqual({
      processing_strategy: 'auto',
      user_goal: '整理操作步骤',
    })
    expect(projection).not.toHaveProperty('quality_profile')
  })

  it('submits each imported link as its own durable job after inline previews', async () => {
    const user = userEvent.setup()
    const first = 'https://youtu.be/video-1'
    const second = 'https://www.bilibili.com/video/BV1'
    const { calls } = stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'POST /vk/v1/preview': { body: resolvedRequest({ source: first, reasoning_effort: 'max' }) },
      'POST /vk/v1/jobs': { status: 201, body: { job_id: 'job-1', kind: 'request' } },
    })
    render(<VkPanel baseUrl={BASE} />)
    await user.type(screen.getByTestId('vk-source'), `${first}\n${second}`)
    await user.type(screen.getByTestId('vk-reasoning-effort'), 'max')
    await user.click(screen.getByTestId('vk-submit-button'))
    await waitFor(() => {
      expect(calls.filter((item) => item.key === 'POST /vk/v1/jobs')).toHaveLength(2)
    })
    const sources = calls
      .filter((item) => item.key === 'POST /vk/v1/jobs')
      .map((item) => JSON.parse(String(item.init?.body)).request.source)
    expect(sources).toEqual([first, second])
    const efforts = calls
      .filter((item) => item.key === 'POST /vk/v1/jobs')
      .map((item) => JSON.parse(String(item.init?.body)).request.reasoning_effort)
    expect(efforts).toEqual(['max', 'max'])
    expect(screen.getAllByTestId('vk-task-banner')).toHaveLength(1)
    expect(screen.getByTestId('vk-task-banner')).toHaveTextContent('\u4efb\u52a1\u5df2\u63d0\u4ea4')
  })

  it('uses the old universal job path for YouTube without a diagnostic gate', async () => {
    const user = userEvent.setup()
    const { calls } = stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'POST /vk/v1/preview': { body: resolvedRequest({ source: 'https://youtu.be/video-1' }) },
      'POST /vk/v1/jobs': { status: 201, body: { job_id: 'job-youtube', kind: 'request' } },
    })
    render(<VkPanel baseUrl={BASE} />)
    await user.type(screen.getByTestId('vk-source'), 'https://youtu.be/video-1')
    await user.click(screen.getByTestId('vk-submit-button'))
    await waitFor(() => expect(calls.some((item) => item.key === 'POST /vk/v1/jobs')).toBe(true))
    expect(calls.some((item) => item.key === 'GET /vk/v1/diagnostic')).toBe(false)
  })

  it('consumes the cross-module handoff: prefills the source, shows provenance, clears the store', async () => {
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
    })
    useAppStore.getState().setVkHandoff({
      url: 'https://www.bilibili.com/video/BV1',
      commandKey: 'bilibili/hot',
      collectedAt: 1754000000000,
    })
    expect(useAppStore.getState().activeModule).toBe('vk')
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => {
      expect((screen.getByTestId('vk-source') as HTMLInputElement).value).toBe('https://www.bilibili.com/video/BV1')
    })
    expect(screen.getByTestId('vk-provenance').textContent).toContain('bilibili/hot')
    expect(useAppStore.getState().vkHandoff).toBeUndefined()
  })

  // 任务列表只呈现耗时与状态，费用字段不再占用耗时列的第二行。
  it.each([
    [0.42],
    [0.003],
    [0],
  ])('cost_cny=%s 不显示费用文案', async (cost) => {
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'GET /vk/v1/jobs': {
        body: [{
          job_id: 'run:run-1', kind: 'run', status: 'done',
          submitted_at: '2026-08-01T00:00:00+00:00', finished_at: '2026-08-01T00:10:00+00:00',
          parent_job_id: null, cache_bypass: false, run_id: 'run-1', cost_cny: cost,
        }],
      },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(screen.getByTestId('vk-job-row')).toBeInTheDocument())
    expect(screen.getByTestId('vk-job-row').textContent).not.toContain('¥')
  })

  it('任务删除后保留稳定编号，新任务继续递增', async () => {
    const job = (id: string, minute: number) => ({
      job_id: id,
      kind: 'run',
      status: 'done',
      submitted_at: `2026-08-01T00:0${minute}:00+00:00`,
      finished_at: `2026-08-01T00:1${minute}:00+00:00`,
      parent_job_id: null,
      cache_bypass: false,
    })
    const jobsRoute: Route = { body: [job('job-1', 1), job('job-2', 2), job('job-3', 3)] }
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'GET /vk/v1/jobs': jobsRoute,
    })
    render(<VkPanel baseUrl={BASE} />)
    const numbers = () => screen.getAllByTestId('vk-job-row')
      .map((row) => row.querySelector('.vk-task-number')?.textContent)
    await waitFor(() => expect(numbers()).toEqual(['3', '2', '1']))

    jobsRoute.body = [job('job-1', 1), job('job-3', 3), job('job-4', 4)]
    await userEvent.click(screen.getByTestId('vk-jobs-refresh'))
    await waitFor(() => expect(numbers()).toEqual(['4', '3', '1']))
  })

  it('手动刷新时保留旧表格并只在表格内显示加载态，完成后原子替换记录', async () => {
    const initialJob = {
      job_id: 'job-old', kind: 'run', status: 'done',
      submitted_at: '2026-08-01T00:01:00+00:00', finished_at: '2026-08-01T00:02:00+00:00',
      parent_job_id: null, cache_bypass: false,
    }
    const latestJob = { ...initialJob, job_id: 'job-latest', submitted_at: '2026-08-01T00:03:00+00:00' }
    let jobsCall = 0
    const refreshGate: { resolve?: (value: unknown) => void } = {}
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'GET /vk/v1/jobs': {
        body: () => {
          jobsCall += 1
          if (jobsCall === 1) return [initialJob]
          return new Promise((resolve) => { refreshGate.resolve = resolve })
        },
      },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(screen.getByTestId('vk-job-open-job-old')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('vk-jobs-refresh'))
    expect(screen.getByTestId('vk-jobs-refresh')).toHaveTextContent('刷新中')
    expect(screen.getByTestId('vk-job-open-job-old')).toBeInTheDocument()
    expect(screen.getByText('正在读取最新任务…')).toBeInTheDocument()

    refreshGate.resolve?.([latestJob])
    await waitFor(() => expect(screen.getByTestId('vk-job-open-job-latest')).toBeInTheDocument())
    expect(screen.getByTestId('vk-jobs-refresh')).toHaveTextContent('刷新')
  })

  it('任务记录只在存在进行中任务时每 30 秒查询一次', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'GET /vk/v1/jobs': { body: [{
        job_id: 'job-active', kind: 'request', status: 'retrying',
        submitted_at: '2026-08-01T00:01:00+00:00', finished_at: null,
        parent_job_id: null, cache_bypass: false,
      }] },
    })

    render(<VkPanel baseUrl={BASE} />)
    await screen.findByTestId('vk-job-open-job-active')

    await waitFor(() => expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 15_000))
    intervalSpy.mockRestore()
  })

  it('syncs an open detail in the same refresh that observes an active task becoming terminal', async () => {
    const user = userEvent.setup()
    let status = 'running'
    const jobsRoute: Route = { body: () => [{
      job_id: 'job-sync', kind: 'request', status,
      submitted_at: '2026-08-11T00:01:00+00:00',
      finished_at: status === 'running' ? null : '2026-08-11T00:02:00+00:00',
      parent_job_id: null, cache_bypass: false,
    }] }
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'GET /vk/v1/jobs': jobsRoute,
      'GET /vk/v1/jobs/job-sync': { body: () => ({
        job_id: 'job-sync', kind: 'request', status,
        submitted_at: '2026-08-11T00:01:00+00:00',
        finished_at: status === 'running' ? null : '2026-08-11T00:02:00+00:00',
        parent_job_id: null, cache_bypass: false,
        request: { source: 'https://example.com/video', preset: 'quick-summary' },
        error: status === 'failed' ? 'terminal detail error' : null,
      }) },
    })

    render(<VkPanel baseUrl={BASE} />)
    await user.click(await screen.findByTestId('vk-job-row'))
    await screen.findByTestId('vk-job-detail')

    status = 'failed'
    await user.click(screen.getByTestId('vk-jobs-refresh'))

    await waitFor(() => expect(screen.getByTestId('vk-job-detail')).toHaveTextContent('terminal detail error'))
    expect(screen.getByTestId('vk-job-row')).toHaveTextContent('\u5931\u8d25')
    expect(screen.getByText(/\u4efb\u52a1\d+\u9047\u5230\u4e86\u4e9b\u95ee\u9898/)).toBeInTheDocument()
  })

  it('shows one rerun-colored notice for one successful retry event', async () => {
    const { calls } = stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(calls.some((call) => call.key === 'GET /vk/v1/jobs')).toBe(true))

    act(() => {
      window.dispatchEvent(new CustomEvent('vk:job-retry-submitted', { detail: { jobId: 'retry-child' } }))
      window.dispatchEvent(new CustomEvent('vk:job-retry-submitted', { detail: { jobId: 'retry-child' } }))
    })

    const notices = screen.getAllByTestId('vk-task-banner')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toHaveTextContent('\u4efb\u52a1\u5df2\u91cd\u65b0\u63d0\u4ea4\uff0c\u6b63\u5728\u91cd\u8dd1')
    expect(notices[0]).toHaveAttribute('data-tone', 'rerun')
    expect(screen.getByTestId('vk-task-banner-progress')).toHaveClass('is-rerun')
  })

  it('folds an active internal run into its user request row', async () => {
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': {
        body: [
          {
            job_id: 'request-1', kind: 'request', status: 'running',
            submitted_at: '2026-08-09T09:26:39.861Z', finished_at: null,
            parent_job_id: null, cache_bypass: false,
          },
          {
            job_id: 'run:run-1', kind: 'run', status: 'running', run_id: 'run-1',
            submitted_at: '2026-08-09T09:26:39.900Z', finished_at: null,
            parent_job_id: null, cache_bypass: false,
          },
        ],
      },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(screen.getAllByTestId('vk-job-row')).toHaveLength(1))
    expect(screen.getByTestId('vk-job-open-request-1')).toBeInTheDocument()
    expect(screen.queryByTestId('vk-job-open-run:run-1')).not.toBeInTheDocument()
  })

  it('folds a failed internal run into the failed request row', async () => {
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': {
        body: [
          {
            job_id: 'request-failed', kind: 'request', status: 'failed',
            submitted_at: '2026-08-10T08:13:03.678Z', finished_at: '2026-08-10T08:15:41.377Z',
            parent_job_id: null, cache_bypass: false,
          },
          {
            job_id: 'run:failed-run', kind: 'run', status: 'failed', run_id: 'failed-run',
            submitted_at: '2026-08-10T08:13:03.711Z', finished_at: '2026-08-10T08:15:41.360Z',
            parent_job_id: null, cache_bypass: false,
          },
        ],
      },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(screen.getAllByTestId('vk-job-row')).toHaveLength(1))
    expect(screen.getByTestId('vk-job-open-request-failed')).toBeInTheDocument()
    expect(screen.queryByTestId('vk-job-open-run:failed-run')).not.toBeInTheDocument()
  })

  it('lists failed jobs with real status/elapsed and keeps diagnostics without exposing outputs', async () => {
    const user = userEvent.setup()
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': {
        body: [{
          job_id: 'run:run-1', kind: 'run', status: 'failed',
          submitted_at: '2026-08-01T00:00:00+00:00', finished_at: '2026-08-01T00:10:00+00:00',
          parent_job_id: null, cache_bypass: false, run_id: 'run-1', cost_cny: 0.05,
        }],
      },
      'GET /vk/v1/jobs/run:run-1': {
        body: {
          job_id: 'run:run-1', kind: 'run', status: 'failed',
          submitted_at: '2026-08-01T00:00:00+00:00', finished_at: '2026-08-01T00:10:00+00:00',
          parent_job_id: null, cache_bypass: false, run_id: 'run-1', cost_cny: 0.05,
          budget_stop: {
            reason: 'worst_case_estimate_exceeds_max_cost_cny',
            stage: 'chapter', limit_cny: 0.1, actual_cost_cny: 0.05,
          },
          capabilities: [{ capability: 'visual_evidence', state: 'gap', reason: 'visual_disabled' }],
          outputs: {
            note_path: 'out_note1', request_path: null, audit_path: 'out_audit1',
            product_artifacts: [{ preset: 'quick-summary', schema_name: 'q', sha256: 'a'.repeat(64), json: 'out_pj', markdown: 'out_pm' }],
          },
        },
      },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(screen.getByTestId('vk-job-row')).toBeInTheDocument())
    expect(screen.getByTestId('vk-job-row').textContent).toContain('失败')
    expect(screen.getByTestId('vk-job-row').textContent).toContain('10m0s')

    await user.click(screen.getByTestId('vk-job-row'))
    await waitFor(() => expect(screen.getByTestId('vk-job-detail')).toBeInTheDocument())
    expect(screen.getByTestId('vk-budget-stop').textContent).toContain('worst_case_estimate_exceeds_max_cost_cny')
    expect(screen.getByTestId('vk-evidence-coverage').textContent).toContain('visual_evidence=gap(visual_disabled)')
    expect(screen.queryByTestId('vk-output-note')).toBeNull()
    expect(screen.queryByTestId('vk-output-audit')).toBeNull()
    expect(screen.queryByTestId('vk-output-product-json-0')).toBeNull()
    expect(screen.getByTestId('vk-job-retry')).toBeInTheDocument()
  })

  it('opens a Markdown output in an in-app dialog and closes it', async () => {
    const user = userEvent.setup()
    const markdown = '# 测试笔记\n\n正文 **加粗**'
    const { calls } = stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': {
        body: [{
          job_id: 'run:run-1', kind: 'run', status: 'done',
          submitted_at: '2026-08-01T00:00:00+00:00', finished_at: '2026-08-01T00:10:00+00:00',
          parent_job_id: null, cache_bypass: false, run_id: 'run-1', cost_cny: 0.05,
        }],
      },
      'GET /vk/v1/jobs/run:run-1': {
        body: {
          job_id: 'run:run-1', kind: 'run', status: 'done',
          submitted_at: '2026-08-01T00:00:00+00:00', finished_at: '2026-08-01T00:10:00+00:00',
          parent_job_id: null, cache_bypass: false, run_id: 'run-1', cost_cny: 0.05,
          outputs: { note_path: 'notes/a.md', product_artifacts: [] },
        },
      },
      'GET /vk/v1/outputs/notes%2Fa.md': { body: markdown },
    })
    render(<VkPanel baseUrl={BASE} />)

    await user.click(await screen.findByTestId('vk-job-open-run:run-1'))
    await user.click(await screen.findByTestId('vk-output-note'))

    const dialog = await screen.findByRole('dialog')
    expect(screen.getByRole('heading', { level: 1, name: '测试笔记' })).toBeInTheDocument()
    expect(dialog.querySelector('strong')).toHaveTextContent('加粗')
    expect(screen.getByRole('button', { name: '复制内容' })).toBeInTheDocument()
    expect(calls.some((call) => call.key === 'GET /vk/v1/outputs/notes%2Fa.md')).toBe(true)

    await user.click(screen.getByRole('button', { name: /关闭/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('shows model call count and untracked cost in the job detail', async () => {
    const user = userEvent.setup()
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': {
        body: [{
          job_id: 'run:run-1', kind: 'run', status: 'done',
          submitted_at: '2026-08-01T00:00:00+00:00', finished_at: '2026-08-01T00:10:00+00:00',
          parent_job_id: null, cache_bypass: false, run_id: 'run-1', cost_cny: 0,
        }],
      },
      'GET /vk/v1/jobs/run:run-1': {
        body: {
          job_id: 'run:run-1', kind: 'run', status: 'done',
          submitted_at: '2026-08-01T00:00:00+00:00', finished_at: '2026-08-01T00:10:00+00:00',
          parent_job_id: null, cache_bypass: false, run_id: 'run-1', cost_cny: 0,
          progress: { model_calls: 8 },
          auto_route: { route: 'text_fast', confidence: 0.85 },
        },
      },
      'GET /vk/v1/providers': {
        body: { channels: [], roles: {}, role_assignments: {}, role_labels: {}, role_hints: {}, unassigned_roles: [], api_styles: [], importable: [], cc_switch: { available: false, path: '', reason: '', skipped: [], candidates: [] }, configured: true, cost_tracking: false },
      },
    })
    render(<VkPanel baseUrl={BASE} />)

    await user.click(await screen.findByTestId('vk-job-open-run:run-1'))
    const detail = await screen.findByTestId('vk-job-detail')
    expect(detail).toHaveTextContent('模型调用 8 次')
    expect(screen.getByTestId('vk-auto-route')).toHaveTextContent('自动方案:快速文本整理（置信度 85%）')
    expect(detail).not.toHaveTextContent('费用未统计')
  })

  it('explains third-party transcript transfer and disables a CNY cap when prices are unknown', async () => {
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/providers': {
        body: { channels: [], roles: {}, role_assignments: {}, role_labels: {}, role_hints: {}, unassigned_roles: [], api_styles: [], importable: [], cc_switch: { available: false, path: '', reason: '', skipped: [], candidates: [] }, configured: true, cost_tracking: false },
      },
    })
    render(<VkPanel baseUrl={BASE} />)

    expect(await screen.findByTestId('vk-third-party-data-notice')).toHaveTextContent('字幕或语音转写')
    expect(screen.getByTestId('vk-third-party-data-notice')).toHaveTextContent('第三方模型服务')
    await userEvent.click(screen.getByText('高级设置'))
    expect(screen.getByTestId('vk-max-cost')).toBeDisabled()
    expect(screen.getByText('当前通道未配置可靠单价，不能使用人民币费用上限')).toBeInTheDocument()
  })

  it('runs a knowledge-base query and renders citations', async () => {
    const user = userEvent.setup()
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'POST /vk/v1/query': {
        body: {
          status: 'answered',
          answer: '光速约每秒三十万公里',
          citations: [{
            document_id: 'doc-12345678', source_revision_id: 'rev-87654321',
            kind: 'transcript', artifact_sha256: 'b'.repeat(64),
          }],
        },
      },
    })
    render(<VkPanel baseUrl={BASE} />)
    await user.type(screen.getByTestId('vk-query-input'), '光速')
    await user.click(screen.getByTestId('vk-query-button'))
    await waitFor(() => expect(screen.getByTestId('vk-query-answer')).toBeInTheDocument())
    expect(screen.getByTestId('vk-query-answer').textContent).toContain('光速约每秒三十万公里')
    expect(screen.getByTestId('vk-query-citation').textContent).toContain('transcript')
  })

  it('keeps the local-download button fixed while progress is cancellable', async () => {
    let finishSaving: (saved: boolean) => void = () => undefined
    vi.mocked(saveTextFileAs).mockImplementation((_name, _content, options) => {
      options?.onProgress?.(37)
      return new Promise((resolve) => { finishSaving = resolve })
    })
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/outputs/note.md': { body: '# 解析结果' },
    })
    render(<VkPanel baseUrl={BASE} />)
    act(() => {
      window.dispatchEvent(new CustomEvent(VK_OPEN_OUTPUT_EVENT, {
        detail: { outputId: 'note.md', title: '知识笔记' },
      }))
    })

    const button = await screen.findByTestId('vk-output-viewer-download')
    expect(button).toHaveAttribute('data-state', 'idle')
    await userEvent.click(button)
    await waitFor(() => expect(button).toHaveAttribute('data-state', 'downloading'))
    expect(screen.getByTestId('vk-output-download-progress')).toHaveAttribute('aria-valuenow', '37')
    const options = vi.mocked(saveTextFileAs).mock.calls[0]?.[2]
    expect(options?.signal?.aborted).toBe(false)

    await userEvent.click(button)
    expect(options?.signal?.aborted).toBe(true)
    expect(button).toHaveAttribute('data-state', 'idle')
    finishSaving(false)
  })

  it('first-run: exposes runtime preparation through the single engine verdict', async () => {
    const user = userEvent.setup()
    const { calls } = stubRoutes({
      'GET /vk/v1/health': {
        body: {
          status: 'not-configured', reasonCode: 'not-installed',
          summary: 'video-knowledge runtime 未安装', apiVersion: null,
          packageVersion: null, capabilities: [], checkedAt: 't', retryable: false,
        },
      },
      'GET /vk/v1/jobs': { status: 503, body: { error: '未安装', reasonCode: 'not-installed' } },
      'GET /vk/v1/runtime/status': {
        body: { state: 'not-installed', version: null, reasonCode: null, summary: '解析引擎未安装', log: [], checkedAt: 't' },
      },
      'POST /vk/v1/runtime/install': {
        status: 202,
        body: { state: 'installing', version: null, reasonCode: null, summary: '正在安装解析引擎', log: ['manifest 核验通过', 'venv: uv.exe venv'], checkedAt: 't' },
      },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(screen.getByTestId('vk-verdict')).toHaveTextContent('解析引擎还没准备好'))
    await user.click(screen.getByTestId('vk-verdict-action'))
    await waitFor(() => expect(calls.some((item) => item.key === 'POST /vk/v1/runtime/install')).toBe(true))
    expect(screen.getByTestId('vk-verdict')).toHaveTextContent('正在准备解析环境')
    expect(calls.some((item) => item.key === 'POST /vk/v1/runtime/install')).toBe(true)
  })

  it('first-run: failed install shows typed reason with retry', async () => {
    stubRoutes({
      'GET /vk/v1/health': {
        body: {
          status: 'not-configured', reasonCode: 'not-installed',
          summary: '未安装', apiVersion: null, packageVersion: null,
          capabilities: [], checkedAt: 't', retryable: false,
        },
      },
      'GET /vk/v1/jobs': { status: 503, body: { error: '未安装', reasonCode: 'not-installed' } },
      'GET /vk/v1/runtime/status': {
        body: { state: 'failed', version: null, reasonCode: 'offline', summary: '网络不可达,独立 Python 下载失败', log: ['error sending request'], checkedAt: 't' },
      },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(screen.getByTestId('vk-verdict')).toHaveTextContent('解析环境没装成功'))
    expect(screen.getByTestId('vk-verdict-note')).toHaveTextContent('网络不可达')
    expect(screen.getByTestId('vk-verdict-action')).toHaveTextContent('重试')
  })

  it('keeps runtime selection internal and does not render a developer environment picker', async () => {
    const { calls } = stubRoutes({
      'GET /vk/v1/health': { body: { ...HEALTH, status: 'not-configured', reasonCode: 'not-installed', summary: '未安装' } },
      'GET /vk/v1/jobs': { status: 503, body: { error: '未安装', reasonCode: 'not-installed' } },
      'GET /vk/v1/runtime/status': { body: { state: 'not-installed', version: null, reasonCode: null, summary: '解析引擎未安装', log: [], checkedAt: 't' } },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(screen.getByTestId('vk-verdict')).toHaveTextContent('解析引擎还没准备好'))
    expect(calls.some((item) => item.key === 'POST /vk/v1/runtime/detect')).toBe(false)
    expect(calls.some((item) => item.key === 'POST /vk/v1/runtime/adopt')).toBe(false)
    expect(screen.queryByTestId('vk-developer-details')).not.toBeInTheDocument()
  })

  it('surfaces runtime preparation failures in the engine verdict', async () => {
    stubRoutes({
      'GET /vk/v1/health': { body: { ...HEALTH, status: 'not-configured', reasonCode: 'not-installed', summary: '未安装' } },
      'GET /vk/v1/jobs': { status: 503, body: { error: '未安装', reasonCode: 'not-installed' } },
      'GET /vk/v1/runtime/status': { body: { state: 'failed', version: null, reasonCode: 'offline', summary: '安装失败', log: [], checkedAt: 't' } },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(screen.getByTestId('vk-verdict')).toHaveTextContent('解析环境没装成功'))
    expect(screen.getByTestId('vk-verdict-note')).toHaveTextContent('安装失败')
    expect(screen.getByTestId('vk-verdict-action')).toHaveTextContent('重试')
  })

  it('keeps each task notice for exactly three seconds while its progress continuously decreases', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    const user = userEvent.setup()
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'POST /vk/v1/preview': { body: resolvedRequest() },
      'POST /vk/v1/jobs': { status: 201, body: { job_id: 'job-timed', kind: 'request' } },
    })
    render(<VkPanel baseUrl={BASE} />)
    await user.type(screen.getByTestId('vk-source'), 'https://example.com/v')
    await user.click(screen.getByTestId('vk-submit-button'))

    const progress = screen.getByTestId('vk-task-banner-progress')
    expect(progress).toHaveAttribute('aria-valuenow', '100')
    const progressTick = intervalSpy.mock.calls.find((call) => call[1] === 50)?.[0]
    const dismissAtThreeSeconds = timeoutSpy.mock.calls.find((call) => call[1] === 3_000)?.[0]
    expect(progressTick).toBeTypeOf('function')
    expect(dismissAtThreeSeconds).toBeTypeOf('function')

    nowSpy.mockReturnValue(101_500)
    act(() => { if (typeof progressTick === 'function') progressTick() })
    expect(screen.getByTestId('vk-task-banner')).toBeInTheDocument()
    expect(Number(progress.getAttribute('aria-valuenow'))).toBeLessThan(100)
    expect(Number(progress.getAttribute('aria-valuenow'))).toBeGreaterThan(0)
    act(() => { if (typeof dismissAtThreeSeconds === 'function') dismissAtThreeSeconds() })
    expect(screen.queryByTestId('vk-task-banner')).not.toBeInTheDocument()
    nowSpy.mockRestore()
    timeoutSpy.mockRestore()
    intervalSpy.mockRestore()
  })

  it('uses success, warning, and danger notices for completed, interrupted, and failed jobs', async () => {
    const row = (job_id: string, status: string, minute: number, finished_at: string | null = null) => ({
      job_id, kind: 'request', status,
      submitted_at: `2026-08-11T00:0${minute}:00+00:00`, finished_at,
      parent_job_id: null, cache_bypass: false,
    })
    const jobsRoute: Route = { body: [
      row('job-done-notice', 'running', 1),
      row('job-interrupted-notice', 'processing', 2),
      row('job-failed-notice', 'queued', 3),
    ] }
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': jobsRoute,
    })
    render(<VkPanel baseUrl={BASE} />)
    await screen.findByTestId('vk-job-open-job-done-notice')

    jobsRoute.body = [
      row('job-done-notice', 'done', 1, '2026-08-11T00:10:00+00:00'),
      row('job-interrupted-notice', 'completed_after_cancel_request', 2, '2026-08-11T00:10:00+00:00'),
      row('job-failed-notice', 'failed', 3, '2026-08-11T00:10:00+00:00'),
    ]
    await userEvent.click(screen.getByTestId('vk-jobs-refresh'))

    const completed = await screen.findByText(/\u4efb\u52a1\d+\u5df2\u5b8c\u6210/)
    const interrupted = screen.getByText(/\u4efb\u52a1\d+\u5df2\u4e2d\u65ad/)
    const failed = screen.getByText(/\u4efb\u52a1\d+\u9047\u5230\u4e86\u4e9b\u95ee\u9898/)
    expect(completed.closest('[data-testid="vk-task-banner"]')).toHaveAttribute('data-tone', 'success')
    expect(interrupted.closest('[data-testid="vk-task-banner"]')).toHaveAttribute('data-tone', 'warning')
    expect(failed.closest('[data-testid="vk-task-banner"]')).toHaveAttribute('data-tone', 'danger')
    expect(screen.getAllByTestId('vk-task-banner-progress').map((item) => item.className)).toEqual(
      expect.arrayContaining(['vk-task-banner-progress is-success', 'vk-task-banner-progress is-warning', 'vk-task-banner-progress is-danger']),
    )
  })

  it('does not poll-loop when an installed runtime is displayed', async () => {
    const { calls } = stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': {
        body: { state: 'installed', version: 'v1', reasonCode: null, summary: '解析引擎已就绪(v1)', log: [], checkedAt: 't' },
      },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(screen.queryByTestId('vk-verdict')).not.toBeInTheDocument())
    expect(screen.queryByTestId('vk-developer-details')).not.toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(calls.filter((item) => item.key === 'GET /vk/v1/health').length).toBeLessThanOrEqual(2)
    expect(calls.filter((item) => item.key === 'GET /vk/v1/runtime/status').length).toBeLessThanOrEqual(2)
  })

  it('shows a typed reason when the sidecar is not wired', async () => {
    stubRoutes({
      'GET /vk/v1/health': {
        body: {
          status: 'not-configured', reasonCode: 'not-configured',
          summary: 'video-knowledge runtime 未配置', apiVersion: null,
          packageVersion: null, capabilities: [], checkedAt: 't', retryable: false,
        },
      },
      'GET /vk/v1/jobs': { status: 503, body: { error: 'video-knowledge sidecar 未接线', reasonCode: 'not-configured' } },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => {
      expect(screen.getByTestId('vk-verdict')).toHaveTextContent('解析引擎没有响应')
    })
    await waitFor(() => {
      expect(screen.getByTestId('vk-verdict-note')).toHaveTextContent('video-knowledge runtime 未配置')
    })
  })
})
