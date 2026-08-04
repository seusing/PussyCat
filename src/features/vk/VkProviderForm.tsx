import { useCallback, useEffect, useState } from 'react'
import {
  fetchVkProviderSettings,
  saveVkProviderSettings,
  testVkProvider,
  type VkProviderSettings,
  type VkProviderTestResult,
} from '../../host/vkClient'

const TIERS = ['luna', 'terra', 'sol'] as const
type Tier = (typeof TIERS)[number]

const TIER_LABELS: Record<Tier, string> = {
  luna: '经济档', terra: '标准档', sol: '质量档',
}
// 每档在哪些阶段被用到 —— 用户填 model_id 时最想知道的就是"这档管什么"。
const TIER_USED_BY: Record<Tier, string> = {
  luna: '快速总结、质检', terra: '章节划分、观点提取', sol: '暂未启用',
}

const fieldClass = 'w-full rounded-lg px-3 py-2 text-sm outline-none'
const fieldStyle = {
  background: 'var(--color-canvas)', border: '1px solid var(--color-line)', color: 'var(--color-fg)',
} as const
const outlineButton = 'rounded-lg px-2 py-1 text-xs disabled:opacity-50'
const outlineStyle = { border: '1px solid var(--color-line)', color: 'var(--color-fg)' } as const

type Draft = { relayBaseUrl: string; models: Record<string, string>; keys: Record<string, string> }

/**
 * 模型通道配置。
 *
 * 存在的理由:`providers.local.toml` 是 gitignore 的、永不进安装包,于是装机版从来
 * 没有过可用的模型通道 —— 真机上表现为下载转写跑满 7 分半,最后一步才 401。
 *
 * 两条贯穿全组件的纪律:
 *  · **key 只进不出**。输入框永远以空开始;后端只回「存过没有」。留空 = 不改动已存的。
 *  · **失败要说人话 + 给下一步**,并且能自动修的当场修给用户看(不可见的自动修会让
 *    用户下次继续填错,还怀疑表单在乱动他的输入)。
 */
export function VkProviderForm({ baseUrl, onSaved }: { baseUrl?: string; onSaved?: () => void }) {
  const [settings, setSettings] = useState<VkProviderSettings | null>(null)
  const [draft, setDraft] = useState<Draft>({ relayBaseUrl: '', models: {}, keys: {} })
  const [results, setResults] = useState<Record<string, VkProviderTestResult>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [discovered, setDiscovered] = useState<string[]>([])

  const load = useCallback(async () => {
    try {
      const loaded = await fetchVkProviderSettings(baseUrl)
      setSettings(loaded)
      setDraft({
        relayBaseUrl: loaded.relay_base_url,
        models: Object.fromEntries(TIERS.map((t) => [t, loaded.tiers[t]?.model_id ?? ''])),
        keys: {},                            // key 永远从空开始,不回显
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '模型配置读取失败')
    }
  }, [baseUrl])
  useEffect(() => { void load() }, [load])

  const keyEnvOf = (tier: Tier) => settings?.tiers[tier]?.key_env ?? `VK_RELAY_${tier.toUpperCase()}_KEY`

  const runTest = async (tier: Tier) => {
    setTesting(tier)
    setError(null)
    try {
      const result = await testVkProvider({
        relay_base_url: draft.relayBaseUrl,
        key_env: keyEnvOf(tier),
        ...(draft.keys[tier] ? { api_key: draft.keys[tier] } : {}),
      }, baseUrl)
      setResults((prev) => ({ ...prev, [tier]: result }))
      // 自动修:后端规整过的地址直接回填,让用户看见改成了什么。
      if (result.base_url && result.base_url !== draft.relayBaseUrl) {
        setDraft((d) => ({ ...d, relayBaseUrl: result.base_url as string }))
      }
      if (result.models?.length) setDiscovered(result.models)
    } catch (err) {
      setError(err instanceof Error ? err.message : '连接测试失败')
    } finally {
      setTesting(null)
    }
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const result = await saveVkProviderSettings({
        relay_base_url: draft.relayBaseUrl,
        tiers: Object.fromEntries(TIERS.map((t) => [t, {
          model_id: draft.models[t] ?? '',
          key_env: keyEnvOf(t),
          // 没填就不传 api_key —— 留空表示「不动已存的那把」,而不是把它清掉。
          ...(draft.keys[t] ? { api_key: draft.keys[t] } : {}),
        }])),
      }, baseUrl)
      setDraft((d) => ({ ...d, relayBaseUrl: result.relay_base_url, keys: {} }))
      setNotice([
        '已保存并立即生效',
        ...result.normalization_notes,
        result.keys_written.length ? `已安全保存 ${result.keys_written.length} 把 key` : '',
      ].filter(Boolean).join('；'))
      await load()
      onSaved?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : '模型配置保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (!settings) {
    return <div data-testid="vk-provider-form" className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>
      {error ?? '读取中…'}
    </div>
  }

  return (
    <div data-testid="vk-provider-form" className="rounded-lg p-3" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
      <div className="mb-2 text-sm font-medium">模型配置</div>
      <p className="mb-3 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
        填一次即可。API key 以加密形式存在本机，不会写进任何配置文件。
      </p>

      <label className="mb-1 block text-xs" htmlFor="vk-relay-base-url">接口地址</label>
      <input
        id="vk-relay-base-url"
        data-testid="vk-relay-base-url"
        className={fieldClass}
        style={fieldStyle}
        placeholder="https://中转站地址/v1"
        value={draft.relayBaseUrl}
        onChange={(e) => setDraft((d) => ({ ...d, relayBaseUrl: e.target.value }))}
      />

      <div className="mt-3 space-y-3">
        {TIERS.map((tier) => {
          const info = settings.tiers[tier]
          const result = results[tier]
          return (
            <div key={tier} data-testid={`vk-tier-${tier}`} className="rounded-lg p-2" style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)' }}>
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">{TIER_LABELS[tier]}</span>
                <span style={{ color: 'var(--color-fg-dim)' }}>用于：{TIER_USED_BY[tier]}</span>
                {info?.in_cny != null && (
                  <span style={{ color: 'var(--color-fg-dim)' }}>￥{info.in_cny}/￥{info.out_cny} 每百万字</span>
                )}
              </div>
              <input
                data-testid={`vk-model-${tier}`}
                className={`${fieldClass} mb-1`}
                style={fieldStyle}
                list="vk-discovered-models"
                placeholder="模型名称（测试连接后可从下拉里选）"
                value={draft.models[tier] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, models: { ...d.models, [tier]: e.target.value } }))}
              />
              <input
                data-testid={`vk-key-${tier}`}
                type="password"
                autoComplete="off"
                className={`${fieldClass} mb-1`}
                style={fieldStyle}
                placeholder={info?.key_stored ? '已保存，留空则不改动' : '粘贴 API key'}
                value={draft.keys[tier] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, keys: { ...d.keys, [tier]: e.target.value } }))}
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid={`vk-test-${tier}`}
                  onClick={() => { void runTest(tier) }}
                  disabled={testing !== null}
                  className={outlineButton}
                  style={outlineStyle}
                >
                  {testing === tier ? '测试中…' : '测试连接'}
                </button>
                {info?.key_from_environment && (
                  <span className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>key 来自环境变量</span>
                )}
                {result && (
                  <span
                    data-testid={`vk-test-result-${tier}`}
                    className="text-xs"
                    style={{ color: result.ok ? 'var(--color-success)' : 'var(--color-warning)' }}
                  >
                    {result.ok ? '✓ ' : '✗ '}{result.message}
                  </span>
                )}
              </div>
              {result && !result.ok && result.fix_hint && (
                <div data-testid={`vk-test-fix-${tier}`} className="mt-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
                  下一步：{result.fix_hint}
                </div>
              )}
              {result?.normalization_notes?.map((note) => (
                <div key={note} className="mt-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}>{note}</div>
              ))}
            </div>
          )
        })}
      </div>

      {/* 测试连接拿回来的真实可用模型 —— 省掉手抄模型名抄错 */}
      <datalist id="vk-discovered-models">
        {discovered.map((id) => <option key={id} value={id} />)}
      </datalist>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="vk-provider-save"
          onClick={() => { void save() }}
          disabled={saving}
          className="rounded-lg px-3 py-1 text-sm font-medium disabled:opacity-50"
          style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <span className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>
          价格快照 {settings.price_snapshot_id}
        </span>
      </div>
      {notice && <div data-testid="vk-provider-notice" role="status" className="mt-2 text-xs" style={{ color: 'var(--color-success)' }}>{notice}</div>}
      {error && <div data-testid="vk-provider-error" className="mt-2 text-xs" style={{ color: 'var(--color-danger)' }}>{error}</div>}
    </div>
  )
}
