import { useCallback, useEffect, useState } from 'react'
import {
  fetchVkProviderSettings,
  importVkCcSwitchChannel,
  revealVkProviderKey,
  saveVkProviderSettings,
  testVkProvider,
  type VkChannelPayload,
  type VkProviderSettings,
  type VkProviderTestResult,
} from '../../host/vkClient'

const fieldClass = 'w-full rounded-lg px-3 py-2 text-sm outline-none'
const fieldStyle = {
  background: 'var(--color-canvas)', border: '1px solid var(--color-line)', color: 'var(--color-fg)',
} as const
const outlineButton = 'rounded-lg px-2 py-1 text-xs disabled:opacity-50'
const outlineStyle = { border: '1px solid var(--color-line)', color: 'var(--color-fg)' } as const

/** 表单里的一条通道。key 单独存:**加载时永远是空**,留空表示不改动已存的那把。 */
type Draft = {
  id: string
  name: string
  base_url: string
  model_id: string
  key_env: string
  api_style: string
  in_cny: string
  out_cny: string
  is_default: boolean
  /** 中转站要求的额外请求头(如 codex 的 x-openai-actor-authorization)。
   *  表单不给编辑,但**必须原样带过保存** —— 丢了它有些中转站会直接拒。 */
  extra_headers: Record<string, string>
  /** 用户这次输入的 key(未保存);空 = 不改动 */
  api_key: string
  /** 点了「显示」之后取回的明文,只活在组件里 */
  revealed?: string
}

const newId = () => `ch_${Math.random().toString(36).slice(2, 8)}`

function toDraft(channel: VkProviderSettings['channels'][number]): Draft {
  return {
    id: channel.id, name: channel.name, base_url: channel.base_url, model_id: channel.model_id,
    key_env: channel.key_env, api_style: channel.api_style,
    in_cny: channel.in_cny == null ? '' : String(channel.in_cny),
    out_cny: channel.out_cny == null ? '' : String(channel.out_cny),
    is_default: channel.is_default, extra_headers: { ...channel.extra_headers }, api_key: '',
  }
}

/**
 * 模型配置:一份通道清单 + 两个角色。
 *
 * 取代原先写死的三档。档位名 cheap/mid/high 是我们替用户起的,和他脑子里的东西对不上;
 * 他想的是"哪一步用好模型、哪一步用便宜的",所以只有**深度分析**与**基础处理**两个角色。
 *
 * 两条贯穿全组件的纪律:
 *  · key 输入框**永远从空开始**,留空 = 不改动已存的那把。明文只在点「显示」时单独取,
 *    取回来也只活在组件状态里,收起面板即散。
 *  · 失败给根因 + 下一步;能自动修的当场修**并把改了什么写出来**。
 */
export function VkProviderForm({ baseUrl, onSaved }: { baseUrl?: string; onSaved?: () => void }) {
  const [settings, setSettings] = useState<VkProviderSettings | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [roles, setRoles] = useState<Record<string, string>>({})
  const [results, setResults] = useState<Record<string, VkProviderTestResult>>({})
  const [models, setModels] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const loaded = await fetchVkProviderSettings(baseUrl)
      setSettings(loaded)
      setDrafts(loaded.channels.map(toDraft))
      setRoles({ ...loaded.role_assignments })
    } catch (err) {
      setError(err instanceof Error ? err.message : '模型配置读取失败')
    }
  }, [baseUrl])
  useEffect(() => { void load() }, [load])

  const patch = (id: string, next: Partial<Draft>) =>
    setDrafts((list) => list.map((d) => (d.id === id ? { ...d, ...next } : d)))

  const addChannel = (base?: { base_url?: string; name?: string }) => {
    const id = newId()
    setDrafts((list) => [...list, {
      id, name: base?.name ?? '新配置', base_url: base?.base_url ?? '', model_id: '',
      key_env: `VK_CHANNEL_${id.toUpperCase()}_KEY`, api_style: 'openai_completions',
      in_cny: '', out_cny: '', extra_headers: {},
      // 第一条自动成为默认 —— 「默认」必须始终存在,否则角色解析无处可退。
      is_default: drafts.length === 0, api_key: '',
    }])
  }

  const importChannel = (item: VkProviderSettings['importable'][number]) => {
    setDrafts((list) => list.some((d) => d.id === item.id) ? list : [...list, {
      id: item.id, name: item.name, base_url: item.base_url, model_id: item.model_id,
      key_env: item.key_env, api_style: 'openai_completions',
      in_cny: item.in_cny == null ? '' : String(item.in_cny),
      out_cny: item.out_cny == null ? '' : String(item.out_cny),
      is_default: list.length === 0, extra_headers: {}, api_key: '',
    }])
  }

  /** 从 cc-switch 导一条:地址、模型、接口风格、请求头、key 一次到位,只剩单价要填。 */
  const importFromCcSwitch = async (candidate: VkProviderSettings['cc_switch']['candidates'][number]) => {
    setBusy(`ccswitch:${candidate.ref}`)
    setError(null)
    try {
      const result = await importVkCcSwitchChannel(
        candidate.ref, drafts.map((d) => d.id), baseUrl,
      )
      const channel = result.channel
      setDrafts((list) => [...list, {
        id: channel.id, name: channel.name, base_url: channel.base_url,
        model_id: channel.model_id, key_env: channel.key_env, api_style: channel.api_style,
        in_cny: '', out_cny: '', extra_headers: channel.extra_headers,
        is_default: list.length === 0, api_key: result.api_key,
      }])
      // 单价栏是空的,得说清楚是「按设计没导」而不是漏了。
      setNotice([`已从 cc-switch 导入「${channel.name}」，按「保存」后生效`, ...result.notes].join('；'))
    } catch (err) {
      setError(err instanceof Error ? err.message : '从 cc-switch 导入失败')
    } finally {
      setBusy(null)
    }
  }

  const removeChannel = (id: string) => {
    setDrafts((list) => {
      const next = list.filter((d) => d.id !== id)
      // 删掉的正好是默认那条时,必须立刻指定新的默认,不能留下"没有默认"的中间态。
      if (next.length > 0 && !next.some((d) => d.is_default)) next[0] = { ...next[0], is_default: true }
      return next
    })
    setRoles((current) => Object.fromEntries(Object.entries(current).filter(([, v]) => v !== id)))
  }

  const setDefault = (id: string) =>
    setDrafts((list) => list.map((d) => ({ ...d, is_default: d.id === id })))

  const reveal = async (draft: Draft) => {
    setBusy(`reveal:${draft.id}`)
    setError(null)
    try {
      const result = await revealVkProviderKey(draft.key_env, baseUrl)
      patch(draft.id, { revealed: result.found ? (result.api_key ?? '') : '(尚未保存)' })
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取 key 失败')
    } finally {
      setBusy(null)
    }
  }

  const runTest = async (draft: Draft) => {
    setBusy(`test:${draft.id}`)
    setError(null)
    try {
      const result = await testVkProvider({
        base_url: draft.base_url,
        key_env: draft.key_env,
        api_style: draft.api_style,
        ...(draft.api_key ? { api_key: draft.api_key } : {}),
      }, baseUrl)
      setResults((prev) => ({ ...prev, [draft.id]: result }))
      // 后端规整过的地址直接回填 —— 看不见的自动修等于没修。
      if (result.base_url && result.base_url !== draft.base_url) patch(draft.id, { base_url: result.base_url })
      if (result.models?.length) setModels((prev) => ({ ...prev, [draft.id]: result.models ?? [] }))
    } catch (err) {
      setError(err instanceof Error ? err.message : '连接测试失败')
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const payload: VkChannelPayload[] = drafts.map((d) => ({
        id: d.id, name: d.name, base_url: d.base_url, model_id: d.model_id,
        key_env: d.key_env, api_style: d.api_style, extra_headers: d.extra_headers,
        in_cny: d.in_cny, out_cny: d.out_cny, is_default: d.is_default,
        // 没填就不传 api_key —— 留空表示「不动已存的那把」,而不是清空。
        ...(d.api_key ? { api_key: d.api_key } : {}),
      }))
      const result = await saveVkProviderSettings({ channels: payload, roles }, baseUrl)
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

  const roleKeys = Object.keys(settings.role_labels)
  const defaultId = drafts.find((d) => d.is_default)?.id

  return (
    <div data-testid="vk-provider-form" className="rounded-lg p-3" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
      <div className="mb-1 text-sm font-medium">模型配置</div>
      <p className="mb-3 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
        API key 以加密形式存在本机，不会写进任何配置文件。
      </p>

      {/* —— 通道清单 —— */}
      <div className="space-y-3">
        {drafts.map((draft) => {
          const result = results[draft.id]
          const saved = settings.channels.find((c) => c.id === draft.id)
          return (
            <div key={draft.id} data-testid={`vk-channel-${draft.id}`} className="rounded-lg p-2"
              style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)' }}>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <input
                  data-testid={`vk-channel-name-${draft.id}`}
                  className="rounded px-2 py-1 text-sm font-medium outline-none"
                  style={{ ...fieldStyle, width: '12rem' }}
                  value={draft.name}
                  placeholder="给它起个名字"
                  onChange={(e) => patch(draft.id, { name: e.target.value })}
                />
                {draft.is_default
                  ? <span className="text-xs" style={{ color: 'var(--color-success)' }}>默认</span>
                  : <button type="button" data-testid={`vk-channel-default-${draft.id}`}
                      onClick={() => setDefault(draft.id)} className={outlineButton} style={outlineStyle}>设为默认</button>}
                <button type="button" data-testid={`vk-channel-remove-${draft.id}`}
                  onClick={() => removeChannel(draft.id)} className={outlineButton}
                  style={{ ...outlineStyle, color: 'var(--color-danger)' }}>删除</button>
                {saved && !saved.priced && (
                  <span data-testid={`vk-channel-unpriced-${draft.id}`} className="text-xs" style={{ color: 'var(--color-warning)' }}>
                    单价未知 · 该通道上预算上限不可用
                  </span>
                )}
              </div>

              <input
                data-testid={`vk-channel-url-${draft.id}`}
                className={`${fieldClass} mb-1`} style={fieldStyle}
                placeholder="接口地址，通常以 /v1 结尾"
                value={draft.base_url}
                onChange={(e) => patch(draft.id, { base_url: e.target.value })}
              />
              <input
                data-testid={`vk-channel-model-${draft.id}`}
                className={`${fieldClass} mb-1`} style={fieldStyle}
                list={`vk-models-${draft.id}`}
                placeholder="模型名称（测试连接后可从下拉里选）"
                value={draft.model_id}
                onChange={(e) => patch(draft.id, { model_id: e.target.value })}
              />
              <datalist id={`vk-models-${draft.id}`}>
                {(models[draft.id] ?? []).map((m) => <option key={m} value={m} />)}
              </datalist>

              <div className="mb-1 flex flex-wrap items-center gap-2">
                <input
                  data-testid={`vk-channel-key-${draft.id}`}
                  type={draft.revealed ? 'text' : 'password'}
                  autoComplete="off"
                  className={fieldClass} style={{ ...fieldStyle, flex: 1, minWidth: '12rem' }}
                  placeholder={saved?.key_stored ? '已保存，留空则不改动' : '粘贴 API key'}
                  value={draft.revealed ?? draft.api_key}
                  onChange={(e) => patch(draft.id, { api_key: e.target.value, revealed: undefined })}
                />
                <button type="button" data-testid={`vk-channel-reveal-${draft.id}`}
                  onClick={() => {
                    if (draft.revealed) patch(draft.id, { revealed: undefined })
                    else void reveal(draft)
                  }}
                  disabled={busy !== null} className={outlineButton} style={outlineStyle}>
                  {draft.revealed ? '隐藏' : '显示'}
                </button>
              </div>

              <div className="mb-1 flex flex-wrap items-center gap-2">
                <select
                  data-testid={`vk-channel-style-${draft.id}`}
                  className="rounded px-2 py-1 text-xs outline-none"
                  style={{ ...fieldStyle }}
                  value={draft.api_style}
                  onChange={(e) => patch(draft.id, { api_style: e.target.value })}
                >
                  {settings.api_styles.map((style) => (
                    <option key={style.id} value={style.id}>{style.label}</option>
                  ))}
                </select>
                <input data-testid={`vk-channel-in-${draft.id}`} className="rounded px-2 py-1 text-xs outline-none"
                  style={{ ...fieldStyle, width: '9rem' }} placeholder="输入单价 ￥/百万"
                  value={draft.in_cny} onChange={(e) => patch(draft.id, { in_cny: e.target.value })} />
                <input data-testid={`vk-channel-out-${draft.id}`} className="rounded px-2 py-1 text-xs outline-none"
                  style={{ ...fieldStyle, width: '9rem' }} placeholder="输出单价 ￥/百万"
                  value={draft.out_cny} onChange={(e) => patch(draft.id, { out_cny: e.target.value })} />
                <button type="button" data-testid={`vk-channel-test-${draft.id}`}
                  onClick={() => { void runTest(draft) }} disabled={busy !== null}
                  className={outlineButton} style={outlineStyle}>
                  {busy === `test:${draft.id}` ? '测试中…' : '测试连接'}
                </button>
                {saved?.key_from_environment && (
                  <span className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>
                    key 来自系统环境变量 · 它优先于这里填的
                  </span>
                )}
              </div>

              {result && (
                <div data-testid={`vk-channel-result-${draft.id}`} className="text-xs"
                  style={{ color: result.ok ? 'var(--color-success)' : 'var(--color-warning)' }}>
                  {result.ok ? '✓ ' : '✗ '}{result.message}
                </div>
              )}
              {result && !result.ok && result.fix_hint && (
                <div data-testid={`vk-channel-fix-${draft.id}`} className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>
                  下一步：{result.fix_hint}
                </div>
              )}
              {result?.normalization_notes?.map((note) => (
                <div key={note} className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>{note}</div>
              ))}
            </div>
          )
        })}
      </div>

      {/* —— 新增:预设 / 从本机导入 —— */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {settings.presets.map((preset) => (
          <button key={preset.id} type="button" data-testid={`vk-preset-${preset.id}`}
            title={preset.note}
            onClick={() => addChannel({ base_url: preset.base_url, name: preset.name })}
            className={outlineButton} style={outlineStyle}>
            + {preset.name}
          </button>
        ))}
        {settings.importable.map((item) => (
          <button key={item.id} type="button" data-testid={`vk-import-${item.id}`}
            title={`从本机既有配置导入：${item.model_id}`}
            onClick={() => importChannel(item)}
            className={outlineButton} style={{ ...outlineStyle, color: 'var(--color-accent)' }}>
            ↓ 导入 {item.name}
          </button>
        ))}
      </div>

      {/* —— 从 cc-switch 一键读取 —— */}
      <div data-testid="vk-ccswitch" className="mt-3 rounded-lg p-2"
        style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)' }}>
        <div className="mb-1 flex items-center gap-2 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
          <span style={{ color: 'var(--color-fg)' }}>从 cc-switch 读取</span>
          {settings.cc_switch.available
            ? <span>地址、模型、接口风格、key 一次到位，只剩单价要填</span>
            : <span data-testid="vk-ccswitch-reason">{settings.cc_switch.reason}</span>}
        </div>
        {settings.cc_switch.available && (
          <div className="flex flex-wrap items-center gap-2">
            {settings.cc_switch.candidates.map((candidate) => (
              <button key={candidate.ref} type="button"
                data-testid={`vk-ccswitch-${candidate.ref}`}
                disabled={busy !== null}
                title={`${candidate.base_url} · ${candidate.model_id || '未指定模型'} · ${candidate.masked_key}`}
                onClick={() => void importFromCcSwitch(candidate)}
                className={outlineButton} style={{ ...outlineStyle, color: 'var(--color-accent)' }}>
                ↓ {candidate.name}
                {candidate.is_current && <span style={{ color: 'var(--color-fg-dim)' }}> · 在用</span>}
              </button>
            ))}
            {settings.cc_switch.candidates.length === 0 && (
              <span className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>
                cc-switch 里没有能导的中转站配置
              </span>
            )}
          </div>
        )}
        {/* 认得出但导不了的,说清楚为什么 —— 比让它凭空消失强。 */}
        {settings.cc_switch.skipped.map((note) => (
          <div key={note} className="mt-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}>· {note}</div>
        ))}
      </div>

      {/* —— 角色指派 —— */}
      {drafts.length > 0 && (
        <div className="mt-4 space-y-2">
          {roleKeys.map((role) => (
            <div key={role} className="flex flex-wrap items-center gap-2">
              <span className="w-20 shrink-0 text-sm">{settings.role_labels[role]}</span>
              <select
                data-testid={`vk-role-${role}`}
                className="rounded-lg px-2 py-1 text-sm outline-none"
                style={{ ...fieldStyle, minWidth: '12rem' }}
                value={roles[role] ?? ''}
                onChange={(e) => setRoles((r) => {
                  const next = { ...r }
                  if (e.target.value) next[role] = e.target.value
                  else delete next[role]
                  return next
                })}
              >
                <option value="">跟随默认{defaultId ? `（${drafts.find((d) => d.id === defaultId)?.name}）` : ''}</option>
                {drafts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <span className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>{settings.role_hints[role]}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" data-testid="vk-channel-add" onClick={() => addChannel()}
          className={outlineButton} style={outlineStyle}>+ 新增配置</button>
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
      </div>
      {notice && <div data-testid="vk-provider-notice" role="status" className="mt-2 text-xs" style={{ color: 'var(--color-success)' }}>{notice}</div>}
      {error && <div data-testid="vk-provider-error" className="mt-2 text-xs" style={{ color: 'var(--color-danger)' }}>{error}</div>}
    </div>
  )
}
