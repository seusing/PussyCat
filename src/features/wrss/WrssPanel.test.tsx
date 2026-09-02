import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WrssPanel from './WrssPanel'

function response(value: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }))
}

const base = {
  summary: '公众号运行环境尚未启用', reason_code: null, progress_log: [], version: null,
  size_label: '约 356 MB（按需下载）', checked_at: '2026-08-11T00:00:00Z',
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('WrssPanel', () => {
  it('shows one enable button before installation', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response({ ...base, state: 'not-installed' })))
    render(<WrssPanel baseUrl="http://127.0.0.1:43117" />)
    expect(await screen.findByRole('button', { name: '启用公众号' })).toBeInTheDocument()
    expect(screen.getByText(/356 MB/)).toBeInTheDocument()
  })

  it('describes the enable action next to its control', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response({ ...base, state: 'not-installed' })))
    render(<WrssPanel />)

    const button = await screen.findByRole('button', { name: '启用公众号' })
    const description = screen.getByTestId('wrss-action-description-enable')
    expect(button).toHaveAttribute('aria-describedby', 'wrss-action-description-enable')
    expect(description).toBeVisible()
    expect(description.textContent?.trim()).not.toBe('')
  })

  it('shows a dark skeleton while installing without exposing logs', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response({ ...base, state: 'installing', progress_log: ['venv: internal path'] })))
    render(<WrssPanel />)
    expect(await screen.findByTestId('wrss-skeleton')).toHaveAccessibleName('正在安装公众号')
    expect(screen.queryByText('venv: internal path')).not.toBeInTheDocument()
  })

  it('embeds only loopback running UI and reveals it after iframe load', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response({ ...base, state: 'running', ui_url: 'http://127.0.0.1:4567' })))
    render(<WrssPanel />)
    const frame = await screen.findByTestId('wrss-iframe')
    expect(frame).toHaveAttribute('src', 'http://127.0.0.1:4567')
    expect(frame).toHaveAttribute('sandbox', expect.stringContaining('allow-popups'))
    expect(screen.getByTestId('wrss-skeleton')).toBeInTheDocument()
    fireEvent.load(frame)
    await waitFor(() => expect(frame).toHaveClass('is-ready'))
    expect(screen.getByTestId('wrss-skeleton')).toHaveClass('is-revealed')
    await waitFor(() => expect(screen.queryByTestId('wrss-skeleton')).not.toBeInTheDocument())
  })

  it('shows a status error instead of leaving the skeleton over it', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response({ error: 'host offline' }, 503)))
    render(<WrssPanel />)

    expect(await screen.findByRole('alert')).toHaveTextContent('host offline')
    expect(screen.queryByTestId('wrss-skeleton')).not.toBeInTheDocument()
  })

  it('offers retry for failed runtime without exposing reason in primary copy', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/enable')) return response({ ...base, state: 'installing' }, 202)
      return response({ ...base, state: 'failed', summary: '安装失败，请重试', reason_code: 'sha-mismatch', progress_log: ['secret_key=hidden'] })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<WrssPanel />)
    expect(await screen.findByText('安装失败，请重试')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '刷新公众号状态' })).not.toBeInTheDocument()
    expect(screen.getByText(/sha-mismatch/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/integrations/wrss/enable'),
      expect.objectContaining({ method: 'POST' }),
    ))
  })

  it('describes retry and diagnostics actions individually', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response({
      ...base,
      state: 'failed',
      summary: '安装失败，请重试',
      reason_code: 'runtime-error',
      progress_log: ['step failed'],
    })))
    render(<WrssPanel />)

    const retry = await screen.findByRole('button', { name: '重试' })
    const retryDescription = screen.getByTestId('wrss-action-description-retry')
    expect(retry).toHaveAttribute('aria-describedby', 'wrss-action-description-retry')
    expect(retryDescription).toBeVisible()
    expect(retryDescription.textContent?.trim()).not.toBe('')

    const technical = screen.getByTestId('wrss-action-description-diagnostics')
    expect(technical).toBeVisible()
    expect(technical.textContent?.trim()).not.toBe('')
    const summary = screen.getByText('设置与诊断')
    expect(summary).toHaveAttribute('aria-describedby', 'wrss-action-description-diagnostics')
  })
})

it('returns only diagnostics fields to the trusted running iframe without replacing it', async () => {
  const origin = 'http://127.0.0.1:4567'
  const fetchMock = vi.fn().mockImplementationOnce(() => response({ ...base, state: 'running', ui_url: origin }))
    .mockImplementation(() => response({ ...base, state: 'failed', summary: '进程退出', reason_code: 'runtime-exit', progress_log: ['line one', 'line two'], ui_url: origin, private_value: 'not-for-frame' }))
  vi.stubGlobal('fetch', fetchMock)
  render(<WrssPanel />)
  const iframe = await screen.findByTestId('wrss-iframe') as HTMLIFrameElement
  const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {})
  fireEvent(window, new MessageEvent('message', {
    source: iframe.contentWindow, origin, data: { type: 'pussycat-wrss-diagnostics-request' },
  }))
  await waitFor(() => expect(post).toHaveBeenCalledWith({
    type: 'pussycat-wrss-diagnostics',
    status: { state: 'failed', summary: '进程退出', reason_code: 'runtime-exit', progress_log: ['line one', 'line two'] },
  }, origin))
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(screen.getByTestId('wrss-iframe')).toBe(iframe)
})

it('ignores diagnostics requests from another source, origin, or message type', async () => {
  const origin = 'http://127.0.0.1:4567'
  const fetchMock = vi.fn(() => response({ ...base, state: 'running', ui_url: origin }))
  vi.stubGlobal('fetch', fetchMock)
  render(<WrssPanel />)
  const iframe = await screen.findByTestId('wrss-iframe') as HTMLIFrameElement
  const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {})
  for (const request of [
    { source: window, origin, data: { type: 'pussycat-wrss-diagnostics-request' } },
    { source: iframe.contentWindow, origin: 'http://127.0.0.1:9999', data: { type: 'pussycat-wrss-diagnostics-request' } },
    { source: iframe.contentWindow, origin, data: { type: 'other-request' } },
  ]) fireEvent(window, new MessageEvent('message', request))
  await act(async () => {})
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(post).not.toHaveBeenCalled()
})

it('returns a diagnostics request failure to the iframe and allows a fresh request', async () => {
  const origin = 'http://127.0.0.1:4567'
  const fetchMock = vi.fn().mockImplementationOnce(() => response({ ...base, state: 'running', ui_url: origin }))
    .mockImplementationOnce(() => response({ error: '日志读取失败' }, 503))
    .mockImplementation(() => response({ ...base, state: 'running', summary: '恢复运行', progress_log: ['ready'] }))
  vi.stubGlobal('fetch', fetchMock)
  render(<WrssPanel />)
  const iframe = await screen.findByTestId('wrss-iframe') as HTMLIFrameElement
  const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {})
  const request = () => fireEvent(window, new MessageEvent('message', {
    source: iframe.contentWindow, origin, data: { type: 'pussycat-wrss-diagnostics-request' },
  }))
  request()
  await waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'pussycat-wrss-diagnostics', error: '日志读取失败' }, origin))
  request()
  await waitFor(() => expect(post).toHaveBeenLastCalledWith({ type: 'pussycat-wrss-diagnostics', status: {
    state: 'running', summary: '恢复运行', reason_code: null, progress_log: ['ready'],
  } }, origin))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('keeps settings and diagnostics available for a failed runtime with no log lines', async () => {
  vi.stubGlobal('fetch', vi.fn(() => response({ ...base, state: 'failed', summary: '启动失败' })))
  render(<WrssPanel />)
  await screen.findByText('启动失败')
  const entry = screen.getByText('设置与诊断')
  expect(entry.tagName).toBe('SUMMARY')
  fireEvent.click(entry)
  expect(screen.getByRole('heading', { name: '运行日志' })).toBeInTheDocument()
  expect(screen.getByText('状态: failed')).toBeInTheDocument()
  expect(screen.queryByText('查看技术详情')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
})
