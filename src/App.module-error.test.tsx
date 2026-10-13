import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { CatalogSource } from './host'
import { useAppStore } from './store/appStore'

const providerForm = vi.hoisted(() => ({ broken: true }))

vi.mock('./features/vk/VkProviderForm', () => ({
  VkProviderForm: () => {
    if (providerForm.broken) throw new Error('模型配置渲染失败')
    return <div data-testid="provider-form-ok">模型配置正常</div>
  },
}))

const initialState = useAppStore.getState()

const catalogSource: CatalogSource = {
  kind: 'live',
  load: async () => ({
    snapshot: {
      schemaVersion: 1 as const,
      generatedAt: 1,
      opencliVersion: 'test',
      source: 'test',
      listSha256: 'test',
      manifestSha256: 'test',
      commands: [],
    },
  }),
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('页面级错误边界', () => {
  beforeEach(() => {
    providerForm.broken = true
    useAppStore.setState(initialState, true)
    useAppStore.setState({ activeModule: 'vk' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/vk/v1/health')) return json({ status: 'stopped', summary: 'test' })
      if (url.endsWith('/vk/v1/runtime/status')) {
        return json({ state: 'not-available', version: null, reasonCode: null, summary: 'test', log: [], checkedAt: '2026-09-02T00:00:00Z' })
      }
      if (url.endsWith('/vk/v1/jobs')) return json([])
      return json({})
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('模型配置渲染出错只让这一页显示兜底,侧栏和视频解析页照常', async () => {
    render(<App catalogSource={catalogSource} mode="connected" baseUrl="http://127.0.0.1:43117" />)
    await screen.findByTestId('vk-source')

    await userEvent.click(screen.getByTestId('module-tab-providers'))

    expect(await screen.findByTestId('module-error-fallback')).toHaveTextContent('这个页面出错了')
    expect(screen.getByTestId('app-root')).toBeInTheDocument()
    expect(screen.getByTestId('module-tab-vk')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('module-tab-vk'))
    await waitFor(() => expect(useAppStore.getState().activeModule).toBe('vk'))
    expect(screen.getByTestId('vk-source')).toBeVisible()
  })

  it('点「重新加载此页」后重新渲染模型配置', async () => {
    render(<App catalogSource={catalogSource} mode="connected" baseUrl="http://127.0.0.1:43117" />)
    await screen.findByTestId('vk-source')
    await userEvent.click(screen.getByTestId('module-tab-providers'))
    await screen.findByTestId('module-error-fallback')

    providerForm.broken = false
    await userEvent.click(screen.getByTestId('module-error-reload'))

    expect(await screen.findByTestId('provider-form-ok')).toBeInTheDocument()
    expect(screen.queryByTestId('module-error-fallback')).not.toBeInTheDocument()
  })
})
