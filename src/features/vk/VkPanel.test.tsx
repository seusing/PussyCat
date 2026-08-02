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
    expect(screen.getByTestId('vk-preview').textContent).toContain('markdown_note、quick_summary')
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
    expect(screen.getByTestId('vk-job-row').textContent).toContain('实际费用 ¥0.0500')
    expect(screen.getByTestId('vk-job-row').textContent).toContain('已耗时 10m0s')

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
