import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VkCapabilityPacksPanel } from './VkCapabilityPacksPanel'

function response(value: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }))
}

const packs = {
  packs: [
    { id: 'local-asr', name: '本地语音转写', description: '无字幕时转写音频', size_label: '约 1.2 GB', state: 'not-installed', detail: '依赖未安装', installed_extras: [] },
    { id: 'precision-transcript', name: '逐词时间轴 + 说话人分离', description: '精确到词', size_label: '约 +329 MB', state: 'installed', detail: '依赖已安装', installed_extras: ['alignment-whisperx', 'diarization-pyannote'] },
  ],
  checked_at: '2026-08-10T00:00:00Z',
}
const wrss = {
  configured: false, base_url: 'http://127.0.0.1:8001', state: 'not-configured',
  message: '尚未连接 WeRSS', status_code: null, protocol_verified: false, checked_at: null,
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('VkCapabilityPacksPanel', () => {
  it('renders two install packs and an independent WeRSS connection card', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/capability-packs') ? response(packs) : response(wrss)))
    render(<VkCapabilityPacksPanel />)
    expect(await screen.findByText('本地语音转写')).toBeInTheDocument()
    expect(screen.getByText('逐词时间轴 + 说话人分离')).toBeInTheDocument()
    expect(screen.getByText('公众号 WeRSS')).toBeInTheDocument()
    expect(screen.getByText('未安装')).toBeInTheDocument()
    expect(screen.getByText('已安装')).toBeInTheDocument()
  })

  it('uses only the fixed pack id when installing', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/capability-packs/install')) return response({ state: 'installing' }, 202)
      if (url.endsWith('/capability-packs')) return response(packs)
      return response(wrss)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<VkCapabilityPacksPanel />)
    await screen.findByText('本地语音转写')
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/capability-packs/install'),
      expect.objectContaining({ body: JSON.stringify({ pack_id: 'local-asr' }) }),
    ))
  })

  it('saves then tests the local WeRSS URL', async () => {
    const reachable = { ...wrss, configured: true, state: 'reachable', message: '服务可达', status_code: 200 }
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/capability-packs')) return response(packs)
      if (url.endsWith('/integrations/wrss/config')) return response({ ...wrss, configured: true, state: 'saved' })
      if (url.endsWith('/integrations/wrss/test')) return response(reachable)
      return response(wrss)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<VkCapabilityPacksPanel />)
    await screen.findByText('公众号 WeRSS')
    fireEvent.click(screen.getByRole('button', { name: '保存并测试' }))
    expect(await screen.findByText('服务可达（HTTP 200）')).toBeInTheDocument()
  })
})
