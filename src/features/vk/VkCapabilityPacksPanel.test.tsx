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
    { id: 'local-asr', name: '本地语音识别', description: '为没有字幕的视频安装并校验本地语音识别依赖与模型。', size_label: '依赖约 1.9 GiB + 模型约 2.0 GiB', state: 'not-installed', detail: '依赖未安装', installed_extras: [], dependencies_installed: false, model_downloaded: false },
    { id: 'precision-transcript', name: '逐词时间轴 + 说话人分离', description: '精确到词', size_label: '约 +329 MB', state: 'installed', detail: '依赖已安装', installed_extras: ['alignment-whisperx', 'diarization-pyannote'] },
  ],
  checked_at: '2026-08-10T00:00:00Z',
}

const runtimeVersions = {
  versions: [],
  reclaimableBytes: 0,
  checkedAt: '2026-08-10T00:00:00Z',
}

function readResponse(url: string) {
  return url.endsWith('/runtime/versions') ? response(runtimeVersions) : response(packs)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('VkCapabilityPacksPanel', () => {
  it('renders capability packs without the legacy WeRSS URL card', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => readResponse(url)))
    render(<VkCapabilityPacksPanel />)
    expect(await screen.findByText('本地语音识别')).toBeInTheDocument()
    expect(screen.getByText('逐词时间轴 + 说话人分离')).toBeInTheDocument()
    expect(screen.getByText('依赖约 1.9 GiB + 模型约 2.0 GiB')).toBeInTheDocument()
    expect(screen.queryByText(/首次使用/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('vk-pack-wrss')).not.toBeInTheDocument()
  })

  it('uses only the fixed pack id when installing', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/capability-packs/install')) return response({ state: 'installing' }, 202)
      return readResponse(url)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<VkCapabilityPacksPanel />)
    await screen.findByText('本地语音识别')
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/capability-packs/install'),
      expect.objectContaining({ body: JSON.stringify({ pack_id: 'local-asr' }) }),
    ))
  })

  it('offers verification and reuse when a complete local ASR cache is available', async () => {
    const availablePacks = {
      ...packs,
      packs: packs.packs.map((pack) => pack.id === 'local-asr'
        ? { ...pack, local_cache_state: 'available' }
        : pack),
    }
    vi.stubGlobal('fetch', vi.fn((url: string) => (
      url.endsWith('/runtime/versions') ? response(runtimeVersions) : response(availablePacks)
    )))
    render(<VkCapabilityPacksPanel />)
    expect(await screen.findByRole('button', { name: '校验并复用' })).toBeInTheDocument()
  })

  it('offers verification and completion when the local ASR cache is partial', async () => {
    const partialPacks = {
      ...packs,
      packs: packs.packs.map((pack) => pack.id === 'local-asr'
        ? { ...pack, local_cache_state: 'partial' }
        : pack),
    }
    vi.stubGlobal('fetch', vi.fn((url: string) => (
      url.endsWith('/runtime/versions') ? response(runtimeVersions) : response(partialPacks)
    )))
    render(<VkCapabilityPacksPanel />)
    expect(await screen.findByRole('button', { name: '校验并补齐' })).toBeInTheDocument()
  })

  it('does not expose a WeRSS URL input or save/copy controls', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => readResponse(url)))
    render(<VkCapabilityPacksPanel />)
    await screen.findByText('本地语音识别')
    expect(screen.queryByLabelText('WeRSS 地址')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存并测试' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '复制地址' })).not.toBeInTheDocument()
  })

  it('offers rollback and one-click cleanup for retained runtime versions', async () => {
    const history = {
      versions: [
        { version: 'v3', installedAt: '2026-08-03', extras: ['media-asr'], active: true, current: true, legacyUnreproducible: false, retainedForRollback: false, removable: false, sizeBytes: 1024 ** 3 },
        { version: 'v2', installedAt: '2026-08-02', extras: ['media-asr'], active: false, current: false, legacyUnreproducible: false, retainedForRollback: true, removable: false, sizeBytes: 900 * 1024 ** 2 },
        { version: 'v1', installedAt: '2026-08-01', extras: [], active: false, current: false, legacyUnreproducible: true, retainedForRollback: false, removable: true, sizeBytes: 700 * 1024 ** 2 },
      ],
      reclaimableBytes: 700 * 1024 ** 2,
      checkedAt: '2026-08-10T00:00:00Z',
    }
    const changed = vi.fn()
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/runtime/versions')) return response(history)
      if (url.endsWith('/runtime/rollback')) return response({ state: 'installed', version: 'v2' })
      if (url.endsWith('/runtime/cleanup')) return response({ ...history, reclaimableBytes: 0 })
      return response(packs)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<VkCapabilityPacksPanel onRuntimeChanged={changed} />)

    await screen.findByRole('heading', { name: '解析引擎版本（用于回滚）' })
    expect(screen.getByText(/独立的 Python 运行环境/)).toHaveTextContent('不是 ASR/WhisperX 模型')
    fireEvent.click(screen.getByTitle('回滚到 v2'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/runtime/rollback'),
      expect.objectContaining({ body: JSON.stringify({ version: 'v2' }) }),
    ))
    expect(changed).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /清理 700 MB/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/runtime/cleanup'),
      expect.objectContaining({ body: JSON.stringify({}) }),
    ))
  })
})
