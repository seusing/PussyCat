import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Download, PlugZap, RefreshCw } from 'lucide-react'
import {
  fetchVkCapabilityPacks,
  fetchVkWrssStatus,
  postVkCapabilityPackInstall,
  saveVkWrss,
  testVkWrss,
  type VkCapabilityPack,
  type VkWrssStatus,
} from '../../host/vkClient'
import { copyText } from '../../lib/clipboard'

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
  const [wrss, setWrss] = useState<VkWrssStatus | null>(null)
  const [wrssUrl, setWrssUrl] = useState('http://127.0.0.1:8001')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [packResult, wrssResult] = await Promise.all([
        fetchVkCapabilityPacks(baseUrl),
        fetchVkWrssStatus(baseUrl),
      ])
      setPacks(packResult.packs)
      setWrss(wrssResult)
      setWrssUrl(wrssResult.base_url)
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

  const saveAndTestWrss = async () => {
    setBusy('wrss')
    setError(null)
    try {
      await saveVkWrss(wrssUrl, baseUrl)
      const result = await testVkWrss(baseUrl)
      setWrss(result)
      setWrssUrl(result.base_url)
    } catch (cause) {
      setError(errorText(cause, 'WeRSS 连接失败'))
    } finally {
      setBusy(null)
    }
  }

  const copyWrssUrl = async () => {
    if (await copyText(wrssUrl)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
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

        <article data-testid="vk-pack-wrss" className="rounded-lg p-3 md:col-span-2" style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)' }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium" style={{ color: 'var(--color-fg)' }}>公众号 WeRSS</div>
              <div className="mt-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}>连接你已经运行的 we-mp-rss；当前先接服务与 Web 界面，正文入库协议待后续对接。</div>
            </div>
            <span className="shrink-0 text-xs font-medium" style={{ color: wrss?.state === 'reachable' ? 'var(--color-success)' : 'var(--color-fg-dim)' }}>
              {wrss?.state === 'reachable' ? '服务可达' : wrss?.configured ? '待测试' : '未配置'}
            </span>
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              aria-label="WeRSS 地址"
              value={wrssUrl}
              onChange={(event) => setWrssUrl(event.target.value)}
              className="min-w-0 flex-1 rounded-lg px-3 py-2 text-xs outline-none"
              style={fieldStyle}
            />
            <button type="button" onClick={() => { void saveAndTestWrss() }} disabled={busy !== null} className="flex items-center justify-center gap-1 rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-50" style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}>
              <PlugZap size={13} aria-hidden="true" /> 保存并测试
            </button>
            <button type="button" onClick={() => { void copyWrssUrl() }} className="flex items-center justify-center gap-1 rounded-lg px-3 py-2 text-xs" style={fieldStyle}>
              {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
              {copied ? '已复制' : '复制地址'}
            </button>
          </div>
          <div className="mt-2 text-xs" style={{ color: wrss?.state === 'unreachable' || wrss?.state === 'timeout' ? 'var(--color-danger)' : 'var(--color-fg-dim)' }}>
            {wrss?.message ?? '正在读取 WeRSS 状态…'}
            {wrss?.status_code ? `（HTTP ${wrss.status_code}）` : ''}
          </div>
        </article>
      </div>
    </section>
  )
}
