import { useCallback, useEffect, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import {
  fetchVkCapabilityPacks,
  postVkCapabilityPackInstall,
  type VkCapabilityPack,
} from '../../host/vkClient'

const fieldStyle = {
  background: 'var(--color-canvas)',
  border: '1px solid var(--color-line)',
  color: 'var(--color-fg)',
} as const

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}
function packTone(state: VkCapabilityPack['state']) {
  if (state === 'installed') return 'var(--color-success)'
  if (state === 'installing') return 'var(--color-accent)'
  if (state === 'partial') return 'var(--color-warning)'
  if (state === 'unavailable') return 'var(--color-danger)'
  return 'var(--color-fg-dim)'
}

function packLabel(state: VkCapabilityPack['state']) {
  return ({
    'not-installed': '未安装',
    installing: '安装中',
    installed: '已安装',
    partial: '部分安装',
    unavailable: '不可用',
  } as const)[state]
}

export function VkCapabilityPacksPanel({ baseUrl }: { baseUrl?: string }) {
  const [packs, setPacks] = useState<VkCapabilityPack[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const packResult = await fetchVkCapabilityPacks(baseUrl)
      setPacks(packResult.packs)
      setError(null)
    } catch (cause) {
      setError(errorText(cause, '能力状态获取失败'))
    }
  }, [baseUrl])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!packs.some((pack) => pack.state === 'installing')) return
    const timer = setInterval(() => { void refresh() }, 2000)
    return () => clearInterval(timer)
  }, [packs, refresh])

  const install = async (pack: VkCapabilityPack) => {
    setBusy(`install:${pack.id}`)
    setError(null)
    try {
      await postVkCapabilityPackInstall(pack.id, baseUrl)
      await refresh()
    } catch (cause) {
      setError(errorText(cause, '能力包安装启动失败'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section data-testid="vk-capability-packs" className="mt-2 rounded-lg p-3" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--color-fg)' }}>能力中心</h3>
          <p className="mt-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}>按需安装本地能力；大模型通道配置不会受影响。</p>
        </div>
        <button type="button" aria-label="刷新能力状态" title="刷新能力状态" onClick={() => { void refresh() }} className="rounded p-1.5" style={fieldStyle}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>

      {error && <div role="alert" className="mb-3 rounded px-3 py-2 text-xs" style={{ color: 'var(--color-danger)', border: '1px solid color-mix(in srgb, var(--color-danger) 45%, transparent)' }}>{error}</div>}

      <div className="grid gap-3 md:grid-cols-2">
        {packs.map((pack) => (
          <article key={pack.id} data-testid={`vk-pack-${pack.id}`} className="rounded-lg p-3" style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)' }}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium" style={{ color: 'var(--color-fg)' }}>{pack.name}</div>
                <div className="mt-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}>{pack.description}</div>
              </div>
              <span className="shrink-0 text-xs font-medium" style={{ color: packTone(pack.state) }}>{packLabel(pack.state)}</span>
            </div>
            <div className="mt-3 flex items-end justify-between gap-3">
              <div>
                <div className="text-xs font-medium" style={{ color: 'var(--color-fg)' }}>{pack.size_label}</div>
                <div className="mt-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}>{pack.detail}</div>
              </div>
              {pack.state !== 'installed' && pack.state !== 'installing' && (
                <button
                  type="button"
                  onClick={() => { void install(pack) }}
                  disabled={busy !== null || pack.state === 'unavailable'}
                  className="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
                  style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}
                >
                  <Download size={13} aria-hidden="true" /> 安装
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
