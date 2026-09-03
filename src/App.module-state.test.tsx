import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { CatalogSource } from './host'
import { useAppStore } from './store/appStore'

vi.mock('./features/vk/VkProviderForm', () => ({
  VkProviderForm: ({ onSaved }: { onSaved?: () => void }) => <button onClick={onSaved}>保存模型配置</button>,
}))

const initialState = useAppStore.getState()

const snapshot = {
  schemaVersion: 1 as const,
  generatedAt: 1,
  opencliVersion: 'test',
  source: 'test',
  listSha256: 'test',
  manifestSha256: 'test',
  commands: [],
}

const catalogSource: CatalogSource = {
  kind: 'live',
  load: async () => ({ snapshot }),
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubVkHost() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/vk/v1/health')) return json({ status: 'stopped', summary: 'test' })
    if (url.endsWith('/vk/v1/runtime/status')) {
      return json({
        state: 'not-available', version: null, reasonCode: null,
        summary: 'test', log: [], checkedAt: '2026-09-02T00:00:00Z',
      })
    }
    if (url.endsWith('/vk/v1/providers')) {
      return json({
        channels: [], roles: {}, role_assignments: {}, role_fallbacks: {}, role_routes: {},
        role_route_warnings: {}, role_labels: {}, role_hints: {}, unassigned_roles: [],
        api_styles: [], importable: [],
        cc_switch: { available: false, path: '', reason: '', skipped: [], candidates: [] },
        configured: false, cost_tracking: false,
      })
    }
    if (url.endsWith('/vk/v1/jobs')) return json([])
    return json({})
  }))
}

describe('module page state', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    useAppStore.setState({ activeModule: 'vk' })
    stubVkHost()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps video解析输入 when switching to model configuration and back', async () => {
    render(<App catalogSource={catalogSource} mode="connected" baseUrl="http://127.0.0.1:43117" />)

    const source = await screen.findByTestId('vk-source')
    const link = 'https://example.com/video'
    await userEvent.clear(source)
    await userEvent.type(source, link)
    expect(source).toHaveValue(link)

    await userEvent.click(screen.getByTestId('module-tab-providers'))
    await waitFor(() => expect(useAppStore.getState().activeModule).toBe('providers'))
    await userEvent.click(screen.getByTestId('module-tab-vk'))
    await waitFor(() => expect(useAppStore.getState().activeModule).toBe('vk'))

    expect(screen.getByTestId('vk-source')).toHaveValue(link)
  })

  it('refreshes the retained video panel after model settings are saved', async () => {
    render(<App catalogSource={catalogSource} mode="connected" baseUrl="http://127.0.0.1:43117" />)
    const source = await screen.findByTestId('vk-source')
    await userEvent.type(source, 'https://example.com/video')
    await userEvent.click(screen.getByTestId('module-tab-providers'))
    const providerReads = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/vk/v1/providers')).length
    const readsBeforeSave = providerReads()

    await userEvent.click(screen.getByRole('button', { name: '保存模型配置' }))
    await waitFor(() => expect(providerReads()).toBe(readsBeforeSave + 1))
    await userEvent.click(screen.getByTestId('module-tab-vk'))

    expect(screen.getByTestId('vk-source')).toBe(source)
    expect(source).toHaveValue('https://example.com/video')
  })
})
