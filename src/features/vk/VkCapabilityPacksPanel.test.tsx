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

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('VkCapabilityPacksPanel', () => {
  it('renders capability packs without the legacy WeRSS URL card', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response(packs)))
    render(<VkCapabilityPacksPanel />)
    expect(await screen.findByText('本地语音转写')).toBeInTheDocument()
    expect(screen.getByText('逐词时间轴 + 说话人分离')).toBeInTheDocument()
    expect(screen.queryByTestId('vk-pack-wrss')).not.toBeInTheDocument()
  })

  it('uses only the fixed pack id when installing', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/capability-packs/install')) return response({ state: 'installing' }, 202)
      return response(packs)
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

  it('does not expose a WeRSS URL input or save/copy controls', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response(packs)))
    render(<VkCapabilityPacksPanel />)
    await screen.findByText('本地语音转写')
    expect(screen.queryByLabelText('WeRSS 地址')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存并测试' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '复制地址' })).not.toBeInTheDocument()
  })
})
