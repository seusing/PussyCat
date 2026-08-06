import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VkPanel } from './VkPanel'
import { useAppStore } from '../../store/appStore'
import type { VkProcessingRequest } from '../../host/vkClient'

const initialState = useAppStore.getState()
beforeEach(() => {
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
    quality_profile: 'fast',
    budget_profile: 'economy',
    provider_profile: 'default',
    audit_requested: false,
    requested_capabilities: [],
    user_metadata: {},
    max_cost_cny: 1.5,
    ...overrides,
  }
}

type Route = { status?: number; body: unknown }

function stubRoutes(routes: Record<string, Route>) {
  const calls: Array<{ key: string; init?: RequestInit }> = []
  // 显式参数类型:calls[i] 才能被 tsc 正确推断(仓内 BrowserBridgeStatus.test 同款)
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const pathname = new URL(url).pathname
    const key = `${init?.method ?? 'GET'} ${pathname}`
    calls.push({ key, init })
    const route = routes[key]
    if (!route) return { ok: false, status: 404, json: async () => ({ error: `no stub for ${key}` }) }
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      json: async () => route.body,
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

  it('想再查一次状态只有一个键 —— 原先「重新检测」和会话诊断/重建/检测已有环境挤在一起', async () => {
    const { calls } = stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'POST /vk/v1/runtime/detect': { body: { candidates: [candidate({ active: true })], checkedAt: 'x' } },
      'GET /vk/v1/providers': { body: { channels: [], roles: {}, role_assignments: {}, role_labels: {}, role_hints: {}, unassigned_roles: [], api_styles: [], importable: [], cc_switch: { available: false, path: '', reason: '', skipped: [], candidates: [] }, configured: true } },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(screen.getByTestId('vk-verdict')).toHaveTextContent('解析引擎就绪'))

    const before = calls.filter((c) => c.key === 'GET /vk/v1/health').length
    await userEvent.click(screen.getByTestId('vk-refresh'))

    // 一下点三路:健康、runtime、模型通道 —— 用户要的是"再查一次",不是查哪一路。
    await waitFor(() => {
      expect(calls.filter((c) => c.key === 'GET /vk/v1/health').length).toBeGreaterThan(before)
    })
    await waitFor(() => expect(calls.some((c) => c.key === 'GET /vk/v1/runtime/status')).toBe(true))
    await waitFor(() => expect(calls.some((c) => c.key === 'GET /vk/v1/providers')).toBe(true))
  })

  it('正常时版面上没有第二个同义的检测按钮', async () => {
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'POST /vk/v1/runtime/detect': { body: { candidates: [candidate({ active: true })], checkedAt: 'x' } },
      'GET /vk/v1/providers': { body: { channels: [], roles: {}, role_assignments: {}, role_labels: {}, role_hints: {}, unassigned_roles: [], api_styles: [], importable: [], cc_switch: { available: false, path: '', reason: '', skipped: [], candidates: [] }, configured: true } },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(screen.getByTestId('vk-verdict')).toHaveTextContent('解析引擎就绪'))

    expect(screen.queryByTestId('vk-health-recheck')).not.toBeInTheDocument()
    // 开发者信息里也不再套第二层「环境与能力管理」。
    expect(screen.queryByTestId('vk-runtime-details-toggle')).not.toBeInTheDocument()
  })

  it('模型通道没配时,在提交之前就说出来 —— 不让用户跑满 7 分半才发现', async () => {
    // 真机上的原始症状:下载 + 转写成功耗时 7m33s,最后一步 401。通道不通必须在
    // 第 1 秒可见,而不是第 7.5 分钟。
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'POST /vk/v1/runtime/detect': { body: { candidates: [candidate({ active: true })], checkedAt: 'x' } },
      'GET /vk/v1/providers': { body: { relay_base_url: '', tiers: {}, stage_tiers: {}, price_snapshot_id: 'v14', configured: false } },
    })
    render(<VkPanel baseUrl={BASE} />)

    await waitFor(() => expect(screen.getByTestId('vk-verdict')).toHaveTextContent('还没配置模型通道'))
    expect(screen.getByTestId('vk-verdict-action')).toHaveTextContent('去配置')
    // 结论 + 动作,到此为止:按钮已经说清下一步,再补一段解释后果的话只是噪声。
    expect(screen.queryByTestId('vk-verdict-note')).not.toBeInTheDocument()
  })

  it('配好之后回到一句就绪,配置入口仍在但收着', async () => {
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'POST /vk/v1/runtime/detect': { body: { candidates: [candidate({ active: true })], checkedAt: 'x' } },
      'GET /vk/v1/providers': { body: { relay_base_url: 'https://x/v1', tiers: {}, stage_tiers: {}, price_snapshot_id: 'v14', configured: true } },
    })
    render(<VkPanel baseUrl={BASE} />)

    await waitFor(() => expect(screen.getByTestId('vk-verdict')).toHaveTextContent('解析引擎就绪'))
    // key 会过期,配置入口必须一直够得着 —— 但平时不占版面。
    expect(screen.getByTestId('vk-provider-toggle')).toBeInTheDocument()
    expect(screen.queryByTestId('vk-provider-form')).not.toBeInTheDocument()
  })

  it('一切正常时只有一句结论,不给按钮 —— 没问题就没有要用户点的东西', async () => {
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'GET /vk/v1/runtime/status': { body: RUNTIME_INSTALLED },
      'POST /vk/v1/runtime/detect': { body: { candidates: [candidate({ active: true })], checkedAt: 'x' } },
    })
    render(<VkPanel baseUrl={BASE} />)

    await waitFor(() => expect(screen.getByTestId('vk-verdict')).toHaveTextContent('解析引擎就绪'))
    expect(screen.queryByTestId('vk-verdict-action')).not.toBeInTheDocument()
    // 路径、版本、能力这些开发者信息默认折叠 —— 在 DOM 里但不展开。
    expect(screen.getByTestId('vk-developer-details')).not.toHaveAttribute('open')
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

  it('renders every submission control plus the health summary', async () => {
    stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => {
      expect(screen.getByTestId('vk-health-summary').textContent).toContain('就绪')
    })
    for (const id of ['vk-source', 'vk-preset', 'vk-content-type', 'vk-media-policy',
      'vk-quality', 'vk-budget-profile', 'vk-max-cost', 'vk-audit',
      'vk-cap-word_timestamps', 'vk-cap-speaker_diarization', 'vk-cap-visual_evidence',
      'vk-cap-query_ready', 'vk-preview-button', 'vk-submit-button',
      'vk-query-input', 'vk-jobs-refresh']) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    expect(screen.getByTestId('vk-health-summary').textContent).toContain('api 1.2.0')
    expect(screen.getByTestId('vk-advanced-settings')).not.toHaveAttribute('open')
    expect(screen.getByTestId('vk-preset')).toHaveAccessibleName('处理目的')
    expect(screen.getByRole('option', { name: '快速总结' })).toHaveValue('quick-summary')
  })

  it('previews via the proxy, shows the resolved projection with estimates, then confirms and submits', async () => {
    const user = userEvent.setup()
    const { calls } = stubRoutes({
      'GET /vk/v1/health': { body: HEALTH },
      'GET /vk/v1/jobs': { body: [] },
      'POST /vk/v1/preview': { body: resolvedRequest() },
      'POST /vk/v1/jobs': { status: 201, body: { job_id: 'job-1', kind: 'request' } },
    })
    render(<VkPanel baseUrl={BASE} />)
    await user.type(screen.getByTestId('vk-source'), 'https://example.com/v')
    await user.type(screen.getByTestId('vk-max-cost'), '1.5')
    await user.click(screen.getByTestId('vk-preview-button'))

    await waitFor(() => expect(screen.getByTestId('vk-preview')).toBeInTheDocument())
    const previewCall = calls.find((item) => item.key === 'POST /vk/v1/preview')
    expect(previewCall).toBeDefined()
    const projection = JSON.parse(String(previewCall!.init!.body))
    expect(projection).toMatchObject({ source: 'https://example.com/v', preset: 'quick-summary', max_cost_cny: 1.5 })
    expect(screen.getByTestId('vk-preview').textContent).toContain('知识笔记、快速摘要')
    expect(screen.getByTestId('vk-preview-estimates').textContent).toContain('¥0.25 – ¥1.06')
    expect(screen.getByTestId('vk-preview-estimates').textContent).toContain('8.3 – 27.4 分钟')

    await user.click(screen.getByTestId('vk-submit-button'))
    expect(screen.getByTestId('vk-cost-dialog').textContent).toContain('估算不是承诺')
    await user.click(screen.getByTestId('vk-cost-confirm'))

    await waitFor(() => {
      expect(calls.some((item) => item.key === 'POST /vk/v1/jobs')).toBe(true)
    })
    const submit = calls.find((item) => item.key === 'POST /vk/v1/jobs')
    const payload = JSON.parse(String(submit!.init!.body))
    // 1.3.0:提交走投影(原始 source 只在执行通道),不回投 preview 的脱敏回显
    expect(payload.request).toBeUndefined()
    expect(payload).toMatchObject({
      source: 'https://example.com/v',
      preset: 'quick-summary',
      max_cost_cny: 1.5,
    })
    expect(payload.idempotency_key).toMatch(/[0-9a-f-]{36}/)
    expect(payload.client_job_id).toMatch(/[0-9a-f-]{36}/)
    await waitFor(() => expect(screen.queryByTestId('vk-cost-dialog')).toBeNull())
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

  // 金额精度按量级走。真正要防的是「把花掉的钱显示成 0」—— 单条任务低到 ¥0.003 是常态,
  // 一律两位小数会写成 ¥0.00。这条不变量比"好看"重要得多,单独钉住。
  it.each([
    [0.42, '¥0.42'],       // 够得着分:去掉 toFixed(4) 的两个尾零
    [0.003, '¥0.0030'],    // 分以下:必须保留四位,绝不能压成 ¥0.00
    [0, '¥0'],             // 真零:不写 ¥0.0000
  ])('cost_cny=%s 显示成 %s', async (cost, expected) => {
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
    expect(screen.getByTestId('vk-job-row').textContent).toContain(`实际费用 ${expected}`)
  })

  it('lists jobs with real status/elapsed/cost and surfaces budget_stop plus outputs in the detail', async () => {
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
    expect(screen.getByTestId('vk-job-row').textContent).toContain('实际费用 ¥0.05')
    expect(screen.getByTestId('vk-job-row').textContent).toContain('10m0s')

    await user.click(screen.getByTestId('vk-job-open-run:run-1'))
    await waitFor(() => expect(screen.getByTestId('vk-job-detail')).toBeInTheDocument())
    expect(screen.getByTestId('vk-budget-stop').textContent).toContain('worst_case_estimate_exceeds_max_cost_cny')
    expect(screen.getByTestId('vk-evidence-coverage').textContent).toContain('visual_evidence=gap(visual_disabled)')
    expect(screen.getByTestId('vk-output-note')).toBeInTheDocument()
    expect(screen.getByTestId('vk-output-audit')).toBeInTheDocument()
    expect(screen.getByTestId('vk-output-product-json-0')).toBeInTheDocument()
    expect(screen.getByTestId('vk-job-retry')).toBeInTheDocument()
    expect(screen.getByTestId('vk-job-refresh')).toBeInTheDocument()
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

  it('first-run: renders the runtime install card, posts install, shows live log while installing', async () => {
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
    await waitFor(() => expect(screen.getByTestId('vk-runtime-card')).toBeInTheDocument())
    expect(screen.getByTestId('vk-runtime-summary').textContent).toContain('未安装')
    await user.click(screen.getByTestId('vk-runtime-install'))
    await waitFor(() => {
      expect(screen.getByTestId('vk-runtime-summary').textContent).toContain('正在安装')
    })
    expect(screen.getByTestId('vk-runtime-log').textContent).toContain('manifest 核验通过')
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
    await waitFor(() => expect(screen.getByTestId('vk-runtime-card')).toBeInTheDocument())
    expect(screen.getByTestId('vk-runtime-summary').textContent).toContain('offline')
    expect(screen.getByTestId('vk-runtime-install').textContent).toContain('重试安装')
  })

  it('detects an existing Python environment and adopts only a compatible candidate', async () => {
    const user = userEvent.setup()
    const { calls } = stubRoutes({
      'GET /vk/v1/health': { body: { ...HEALTH, status: 'not-configured', reasonCode: 'not-installed', summary: '未安装' } },
      'GET /vk/v1/jobs': { status: 503, body: { error: '未安装', reasonCode: 'not-installed' } },
      'GET /vk/v1/runtime/status': {
        body: { state: 'not-installed', version: null, reasonCode: null, summary: '解析引擎未安装', log: [], checkedAt: 't' },
      },
      'POST /vk/v1/runtime/detect': {
        body: {
          candidates: [{
            pythonPath: 'C:/Python312/python.exe', source: '本机 PATH', version: '3.12.8', apiVersion: '1.2.0',
            schemaVersion: '1.1.0', capabilities: [
              { capability: 'word_timestamps', runtime: 'missing_dependency', detail: 'whisperx' },
              { capability: 'visual_evidence', runtime: 'ready', detail: null },
            ], compatible: true, reason: null,
          }, {
            pythonPath: 'C:/Python311/python.exe', source: '本机 PATH', version: '3.11.9', apiVersion: null,
            schemaVersion: null, capabilities: [], compatible: false, reason: 'Python 版本不兼容',
          }],
          checkedAt: 't',
        },
      },
      'POST /vk/v1/runtime/adopt': {
        body: { state: 'installed', version: 'external-3.12.8', reasonCode: null, summary: '外部环境已就绪', log: [], checkedAt: 't' },
      },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(screen.getByTestId('vk-runtime-card')).toBeInTheDocument())
    expect(screen.getByTestId('vk-runtime-install').textContent).toContain('初始化爪爪专用解析环境（基础版）')
    await user.click(screen.getByTestId('vk-runtime-detect'))
    await waitFor(() => expect(screen.getByTestId('vk-runtime-candidates')).toBeInTheDocument())
    expect(screen.getByTestId('vk-runtime-candidates').textContent).toContain('本机 PATH')
    expect(screen.getByTestId('vk-runtime-candidates').textContent).not.toContain('Python 版本不兼容')
    expect(screen.getByTestId('vk-runtime-incompatible-toggle')).toHaveTextContent('查看 1 个不兼容环境')
    await user.click(screen.getByTestId('vk-runtime-incompatible-toggle'))
    expect(screen.getByTestId('vk-runtime-candidates').textContent).toContain('Python 版本不兼容')
    expect(screen.getAllByTestId('vk-runtime-capabilities')[0].textContent).toContain('word_timestamps')
    expect(screen.getByTestId('vk-runtime-adopt-0')).toBeEnabled()
    expect(screen.getByTestId('vk-runtime-adopt-1')).toBeDisabled()
    await user.click(screen.getByTestId('vk-runtime-adopt-0'))
    await waitFor(() => expect(calls.some((item) => item.key === 'POST /vk/v1/runtime/adopt')).toBe(true))
    const adopt = calls.find((item) => item.key === 'POST /vk/v1/runtime/adopt')
    expect(JSON.parse(String(adopt!.init!.body))).toEqual({ pythonPath: 'C:/Python312/python.exe' })
    expect(screen.getByTestId('vk-runtime-summary').textContent).toContain('外部环境')
    expect(screen.getByTestId('vk-runtime-adopt-notice')).toHaveTextContent('已切换至 C:/Python312/python.exe')
    expect(screen.getByTestId('vk-runtime-adopt-0')).toHaveTextContent('当前使用')
    expect(screen.getByTestId('vk-runtime-adopt-0')).toBeDisabled()
  })

  it('surfaces detect and adopt failures without hiding the dedicated install retry', async () => {
    const user = userEvent.setup()
    stubRoutes({
      'GET /vk/v1/health': { body: { ...HEALTH, status: 'not-configured', reasonCode: 'not-installed', summary: '未安装' } },
      'GET /vk/v1/jobs': { status: 503, body: { error: '未安装', reasonCode: 'not-installed' } },
      'GET /vk/v1/runtime/status': { body: { state: 'failed', version: null, reasonCode: 'offline', summary: '安装失败', log: [], checkedAt: 't' } },
      'POST /vk/v1/runtime/detect': { status: 503, body: { error: '检测失败', reasonCode: 'detect-failed' } },
    })
    render(<VkPanel baseUrl={BASE} />)
    await waitFor(() => expect(screen.getByTestId('vk-runtime-card')).toBeInTheDocument())
    await user.click(screen.getByTestId('vk-runtime-detect'))
    await waitFor(() => expect(screen.getByTestId('vk-runtime-detect-error').textContent).toContain('检测失败'))
    expect(screen.getByTestId('vk-runtime-install').textContent).toContain('重试安装')
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
    await waitFor(() => expect(screen.getByTestId('vk-runtime-card')).toBeInTheDocument())
    expect(screen.getByTestId('vk-runtime-install').textContent).toContain('重建爪爪专用环境')
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
      expect(screen.getByTestId('vk-health-summary').textContent).toContain('未配置')
    })
    await waitFor(() => {
      expect(screen.getByTestId('vk-panel').textContent).toContain('not-configured')
    })
  })
})
