import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleCheck, Download, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import {
  fetchVkCapabilityPacks,
  fetchVkRuntimeVersions,
  postVkCapabilityPackInstall,
  postVkRuntimeCleanup,
  postVkRuntimeRollback,
  type VkCapabilityPack,
  type VkRuntimeVersionsResponse,
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

function sizeLabel(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

function installLabel(pack: VkCapabilityPack) {
  if (pack.id === 'local-asr' && pack.local_cache_state === 'verified') return '验证运行环境'
  if (pack.id === 'local-asr' && pack.local_cache_state === 'available') return '校验并复用'
  if (pack.id === 'local-asr' && pack.local_cache_state === 'partial') return '校验并补齐'
  return '安装'
}

export function VkCapabilityPacksPanel({
  baseUrl,
  onRuntimeChanged,
}: {
  baseUrl?: string
  onRuntimeChanged?: () => void
}) {
  const [packs, setPacks] = useState<VkCapabilityPack[]>([])
  const [runtimeVersions, setRuntimeVersions] = useState<VkRuntimeVersionsResponse | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refreshFlightRef = useRef<Promise<void> | null>(null)
  const runtimeChangedRef = useRef(onRuntimeChanged)
  const installCompletionPendingRef = useRef(false)

  useEffect(() => {
    runtimeChangedRef.current = onRuntimeChanged
  }, [onRuntimeChanged])

  const refresh = useCallback(async () => {
    if (refreshFlightRef.current) return refreshFlightRef.current
    const flight = (async () => {
      setRefreshing(true)
      try {
        const [packResult, versionResult] = await Promise.all([
          fetchVkCapabilityPacks(baseUrl),
          fetchVkRuntimeVersions(baseUrl),
        ])
        setPacks(packResult.packs)
        setRuntimeVersions(versionResult)
        setError(null)
        const installing = packResult.packs.some((pack) => pack.state === 'installing')
        if (installCompletionPendingRef.current && !installing) {
          installCompletionPendingRef.current = false
          runtimeChangedRef.current?.()
        }
      } catch (cause) {
        setError(errorText(cause, '能力状态获取失败'))
      } finally {
        setRefreshing(false)
      }
    })()
    refreshFlightRef.current = flight
    flight.then(
      () => { if (refreshFlightRef.current === flight) refreshFlightRef.current = null },
      () => { if (refreshFlightRef.current === flight) refreshFlightRef.current = null },
    )
    return flight
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
    installCompletionPendingRef.current = true
    try {
      await postVkCapabilityPackInstall(pack.id, baseUrl)
      await refresh()
    } catch (cause) {
      installCompletionPendingRef.current = false
      setError(errorText(cause, '能力包安装启动失败'))
    } finally {
      setBusy(null)
    }
  }

  const rollback = async (version: string) => {
    setBusy(`rollback:${version}`)
    setError(null)
    try {
      await postVkRuntimeRollback(version, baseUrl)
      await refresh()
      runtimeChangedRef.current?.()
    } catch (cause) {
      setError(errorText(cause, '解析引擎回滚失败'))
    } finally {
      setBusy(null)
    }
  }

  const cleanup = async () => {
    setBusy('cleanup')
    setError(null)
    try {
      setRuntimeVersions(await postVkRuntimeCleanup(baseUrl))
    } catch (cause) {
      setError(errorText(cause, '解析引擎清理失败'))
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
        <button
          type="button"
          aria-label="刷新能力状态"
          title="刷新能力状态"
          aria-busy={refreshing}
          disabled={refreshing}
          onClick={() => { void refresh() }}
          className="rounded p-1.5 disabled:opacity-50"
          style={fieldStyle}
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} aria-hidden="true" />
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
            {pack.state === 'installing' && (
              <div className="mt-3" data-testid={`vk-pack-${pack.id}-progress`}>
                <div
                  role="progressbar"
                  aria-label={`${pack.name}安装进度`}
                  aria-valuetext="安装中"
                  className="h-1.5 overflow-hidden rounded-full"
                  style={{ background: 'color-mix(in srgb, var(--color-fg) 12%, transparent)' }}
                >
                  <div className="h-full w-2/5 animate-pulse rounded-full" style={{ background: 'var(--color-accent)' }} />
                </div>
              </div>
            )}
            <div className="mt-3 flex items-end justify-between gap-3">
              <div>
                <div className="text-xs font-medium" style={{ color: 'var(--color-fg)' }}>{pack.size_label}</div>
                {pack.state !== 'installed' && (
                  <div className="mt-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}>{pack.detail}</div>
                )}
              </div>
              {pack.state !== 'installed' && pack.state !== 'installing' && (
                <button
                  type="button"
                  onClick={() => { void install(pack) }}
                  disabled={busy !== null || pack.state === 'unavailable'}
                  className="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
                  style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}
                >
                  {pack.id === 'local-asr' && pack.local_cache_state === 'verified'
                    ? <CircleCheck size={13} aria-hidden="true" />
                    : <Download size={13} aria-hidden="true" />}
                  {installLabel(pack)}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>

      {runtimeVersions && runtimeVersions.versions.length > 1 && (
        <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--color-line)' }}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold" style={{ color: 'var(--color-fg)' }}>解析引擎版本（用于回滚）</h3>
              <p className="mt-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}>这里是独立的 Python 运行环境，不是 ASR/WhisperX 模型；只清理非活动且非保留回滚版本。</p>
            </div>
            {runtimeVersions.reclaimableBytes > 0 && (
              <button
                type="button"
                onClick={() => { void cleanup() }}
                disabled={busy !== null}
                className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
                style={fieldStyle}
              >
                <Trash2 size={13} aria-hidden="true" /> 清理 {sizeLabel(runtimeVersions.reclaimableBytes)}
              </button>
            )}
          </div>
          <div className="divide-y" style={{ borderColor: 'var(--color-line)' }}>
            {runtimeVersions.versions.map((runtimeVersion) => (
              <div key={runtimeVersion.version} className="flex min-w-0 items-center gap-3 py-2 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="break-all font-medium" style={{ color: 'var(--color-fg)' }}>{runtimeVersion.version}</div>
                  <div className="mt-0.5" style={{ color: 'var(--color-fg-dim)' }}>
                    {sizeLabel(runtimeVersion.sizeBytes)} · {runtimeVersion.active ? '当前使用' : runtimeVersion.retainedForRollback ? '保留回滚' : '可清理'}
                  </div>
                </div>
                {!runtimeVersion.active && (
                  <button
                    type="button"
                    title={`回滚到 ${runtimeVersion.version}`}
                    onClick={() => { void rollback(runtimeVersion.version) }}
                    disabled={busy !== null}
                    className="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 font-medium disabled:opacity-50"
                    style={fieldStyle}
                  >
                    <RotateCcw size={13} aria-hidden="true" /> 回滚
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
