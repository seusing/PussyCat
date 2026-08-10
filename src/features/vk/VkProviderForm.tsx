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

/**
 * 按模型名猜接口风格。**只用来填默认值**,用户改了就以用户的为准。
 *
 * 让用户在三个技术名词之间选是道送分不送分的题:他多半不知道自己的中转站是哪一种,
 * 而选错的表现是 404,极难自查。规则与后端 infer_api_style_from_model 同一张表
 * (后端那份是 API 直接调用时的兜底,这份负责让表单里的选择框先填对)。
 */
export function inferApiStyle(modelId: string): string {
  const name = (modelId ?? '').trim().toLowerCase()
  if (!name) return 'openai_completions'
  if (name.startsWith('claude') || name.includes('anthropic')) return 'anthropic_messages'
  // codex 系中转基本都走 responses —— 恰好是被打成 chat/completions 时通不了的那一类。
  if (/^(gpt-5|o[1-4](\b|-)|codex)/.test(name)) return 'openai_responses'
  return 'openai_completions'
}

/** 表单里的一条通道。 */
type Draft = {
  id: string
  name: string
  base_url: string
  model_id: string
  key_env: string
  api_style: string
  /** 用户手动选过风格 —— 之后改模型名不再覆盖他的选择。 */
  api_style_touched: boolean
  /** 空值表示跟随模型自动推断；其余值直接传给已有 provider 配置。 */
  reasoning_effort: string
  /** 已存 key 的打码值。**空输入框会被当成"没设过"**,所以存过就得看得见。 */
  key_masked: string
  /** 中转站要求的额外请求头(如 codex 的 x-openai-actor-authorization)。
   *  表单不给编辑,但必须原样带过保存 —— 丢了有些中转站会直接拒。 */
  extra_headers: Record<string, string>
  /** 用户这次输入的 key(未保存);未 touched 时不提交,表示"不改动已存的那把"。 */
  api_key: string
  key_touched: boolean
  /** 点了「显示」之后取回的明文,只活在组件里 */
  revealed?: string
}

const newId = () => `ch_${Math.random().toString(36).slice(2, 8)}`

function toDraft(channel: VkProviderSettings['channels'][number]): Draft {
  return {
    id: channel.id, name: channel.name, base_url: channel.base_url, model_id: channel.model_id,
    key_env: channel.key_env, api_style: channel.api_style, api_style_touched: true,
    reasoning_effort: channel.reasoning_effort_explicit ? channel.reasoning_effort : '',
    key_masked: channel.key_masked, extra_headers: { ...channel.extra_headers },
    api_key: '', key_touched: false,
  }
}

/**
 * 模型配置:一份通道清单 + 两个角色。
 *
 * 通道就是「地址 + 模型 + key」,官方站和中转站没有区别 —— 所以既没有内置预设,
 * 也没有「默认通道」:通道本来就是按用途建的,两个角色各指一条,"默认"没有语义。
 *
 * 三条贯穿全组件的纪律:
 *  · key 存过就**看得见存在**(打码值),但改它要先点「更换」—— 不碰就不提交。
 *    明文只在点「显示」时单独取,取回来也只活在组件状态里。
 *  · 接口风格按模型名先填上,用户改过就不再覆盖。
 *  · 失败给根因 + 下一步;能自动修的当场修**并把改了什么写出来**。
 */
export function VkProviderForm({ baseUrl, onSaved }: { baseUrl?: string; onSaved?: () => void }) {
  const [settings, setSettings] = useState<VkProviderSettings | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [roles, setRoles] = useState<Record<string, string>>({})
  const [results, setResults] = useState<Record<string, VkProviderTestResult>>({})
  const [models, setModels] = useState<Record<string, string[]>>({})
  const [reasoningEfforts, setReasoningEfforts] = useState<Record<string, Record<string, string[]>>>({})
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

  /** 改模型名时顺手把风格填对 —— 除非用户自己选过。 */
  const patchModel = (draft: Draft, model_id: string) =>
    patch(draft.id, {
      model_id,
      ...(draft.api_style_touched ? {} : { api_style: inferApiStyle(model_id) }),
    })

  const addChannel = () => {
    const id = newId()
    setDrafts((list) => [...list, {
      id, name: '新配置', base_url: '', model_id: '',
      key_env: `VK_CHANNEL_${id.toUpperCase()}_KEY`, api_style: 'openai_completions',
      api_style_touched: false, reasoning_effort: '', key_masked: '', extra_headers: {},
      api_key: '', key_touched: false,
    }])
  }

  const importChannel = (item: VkProviderSettings['importable'][number]) => {
    setDrafts((list) => list.some((d) => d.id === item.id) ? list : [...list, {
      id: item.id, name: item.name, base_url: item.base_url, model_id: item.model_id,
      key_env: item.key_env, api_style: inferApiStyle(item.model_id), api_style_touched: false,
      reasoning_effort: '', key_masked: '', extra_headers: {}, api_key: '', key_touched: false,
    }])
  }

  /** 从 cc-switch 导一条:地址、模型、接口风格、请求头、key 一次到位。 */
  const importFromCcSwitch = async (candidate: VkProviderSettings['cc_switch']['candidates'][number]) => {
    setBusy(`ccswitch:${candidate.ref}`)
    setError(null)
    try {
      const { channel, api_key } = await importVkCcSwitchChannel(
        candidate.ref, drafts.map((d) => d.id), baseUrl,
      )
      setDrafts((list) => [...list, {
        id: channel.id, name: channel.name, base_url: channel.base_url,
        model_id: channel.model_id, key_env: channel.key_env, api_style: channel.api_style,
        api_style_touched: true, reasoning_effort: '', key_masked: '', extra_headers: channel.extra_headers,
        api_key, key_touched: true,
      }])
      setNotice(`已从 cc-switch 导入「${channel.name}」，按「保存」后生效`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '从 cc-switch 导入失败')
    } finally {
      setBusy(null)
    }
  }

  const removeChannel = (id: string) => {
    setDrafts((list) => list.filter((d) => d.id !== id))
    setRoles((current) => Object.fromEntries(Object.entries(current).filter(([, v]) => v !== id)))
  }

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
        ...(draft.key_touched && draft.api_key ? { api_key: draft.api_key } : {}),
      }, baseUrl)
      setResults((prev) => ({ ...prev, [draft.id]: result }))
      // 后端规整过的地址直接回填 —— 看不见的自动修等于没修。
      if (result.base_url && result.base_url !== draft.base_url) patch(draft.id, { base_url: result.base_url })
      // Every click replaces the previous discovery result, including an empty
      // result. Keeping stale choices would make refresh look real while still
      // showing an older provider state.
      setModels((prev) => ({ ...prev, [draft.id]: result.models ?? [] }))
      setReasoningEfforts((prev) => ({
        ...prev,
        [draft.id]: result.reasoning_efforts ?? {},
      }))
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
        key_env: d.key_env, api_style: d.api_style,
        reasoning_effort: d.reasoning_effort || null,
        extra_headers: d.extra_headers,
        // 没碰过就不传 api_key —— 表示「不动已存的那把」,而不是清空。
        ...(d.key_touched ? { api_key: d.api_key } : {}),
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

  return (
    <div data-testid="vk-provider-form" className="rounded-xl p-4"
      style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
      <div className="text-sm font-medium">模型配置</div>
      {/* 第二句「下面把两种活儿各指一条」删掉:角色指派那一段本身就是两个带标签的下拉框,
          外加 role_hints 逐条解释,看见即懂 —— 用一句话预告接下来会看见什么,是纯重复。 */}
      <p className="mb-4 mt-0.5 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
        一条通道 = 地址 + 模型 + key
      </p>

      {/* —— 通道清单 —— */}
      <div className="space-y-3">
        {drafts.map((draft) => {
          const result = results[draft.id]
          const saved = settings.channels.find((c) => c.id === draft.id)
          const showMasked = !draft.key_touched && !draft.revealed && draft.key_masked !== ''
          const availableReasoningEfforts = reasoningEfforts[draft.id]?.[draft.model_id] ?? []
          return (
            <div key={draft.id} data-testid={`vk-channel-${draft.id}`} className="rounded-lg p-3"
              style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)' }}>
              <div className="mb-2 flex items-center gap-2">
                <input
                  data-testid={`vk-channel-name-${draft.id}`}
                  className="flex-1 rounded px-2 py-1 text-sm font-medium outline-none"
                  style={{ ...fieldStyle, background: 'transparent', border: '1px solid transparent' }}
                  value={draft.name}
                  placeholder="给它起个名字"
                  onChange={(e) => patch(draft.id, { name: e.target.value })}
                />
                <button type="button" data-testid={`vk-channel-remove-${draft.id}`}
                  onClick={() => removeChannel(draft.id)} className={outlineButton}
                  style={{ ...outlineStyle, color: 'var(--color-fg-dim)' }}>删除</button>
              </div>

              <div className="space-y-2">
                <input
                  data-testid={`vk-channel-url-${draft.id}`}
                  className={fieldClass} style={fieldStyle}
                  placeholder="接口地址，通常以 /v1 结尾"
                  value={draft.base_url}
                  onChange={(e) => patch(draft.id, { base_url: e.target.value })}
                />
                <input
                  data-testid={`vk-channel-model-${draft.id}`}
                  className={fieldClass} style={fieldStyle}
                  list={`vk-models-${draft.id}`}
                  placeholder="模型名称（测试连接后可从下拉里选）"
                  value={draft.model_id}
                  onChange={(e) => patchModel(draft, e.target.value)}
                />
                <datalist id={`vk-models-${draft.id}`}>
                  {(models[draft.id] ?? []).map((m) => <option key={m} value={m} />)}
                </datalist>

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    data-testid={`vk-channel-key-${draft.id}`}
                    type={draft.revealed || showMasked ? 'text' : 'password'}
                    readOnly={showMasked}
                    autoComplete="off"
                    className={fieldClass}
                    style={{ ...fieldStyle, flex: 1, minWidth: '12rem',
                             color: showMasked ? 'var(--color-fg-dim)' : 'var(--color-fg)' }}
                    placeholder="粘贴 API key"
                    value={draft.revealed ?? (showMasked ? draft.key_masked : draft.api_key)}
                    onChange={(e) => patch(draft.id, { api_key: e.target.value, key_touched: true, revealed: undefined })}
                  />
                  <button type="button" data-testid={`vk-channel-reveal-${draft.id}`}
                    onClick={() => {
                      if (draft.revealed) patch(draft.id, { revealed: undefined })
                      else void reveal(draft)
                    }}
                    disabled={busy !== null || (!saved?.key_stored && !draft.key_masked)}
                    className={outlineButton} style={outlineStyle}>
                    {draft.revealed ? '隐藏' : '显示'}
                  </button>
                  {showMasked && (
                    <button type="button" data-testid={`vk-channel-replace-${draft.id}`}
                      onClick={() => patch(draft.id, { key_touched: true, api_key: '', revealed: undefined })}
                      className={outlineButton} style={outlineStyle}>更换</button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    data-testid={`vk-channel-style-${draft.id}`}
                    className="rounded-lg px-2 py-1.5 text-xs outline-none"
                    style={fieldStyle}
                    value={draft.api_style}
                    onChange={(e) => patch(draft.id, { api_style: e.target.value, api_style_touched: true })}
                  >
                    {settings.api_styles.map((style) => (
                      <option key={style.id} value={style.id}>{style.label}</option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
                    <span>推理强度</span>
                    <input
                      data-testid={`vk-channel-reasoning-${draft.id}`}
                      className="rounded-lg px-2 py-1.5 text-xs outline-none"
                      style={fieldStyle}
                      list={`vk-reasoning-efforts-${draft.id}`}
                      value={draft.reasoning_effort}
                      placeholder="自动（跟随模型）"
                      title={availableReasoningEfforts.length
                        ? '可选档位来自本次接口请求'
                        : '接口未返回可选档位；留空为自动，也可手动填写服务商支持的值'}
                      onChange={(e) => patch(draft.id, { reasoning_effort: e.target.value })}
                    />
                    <datalist id={`vk-reasoning-efforts-${draft.id}`}>
                      {availableReasoningEfforts.map((effort) => (
                        <option key={effort} value={effort} />
                      ))}
                    </datalist>
                  </label>
                  <button type="button" data-testid={`vk-channel-test-${draft.id}`}
                    onClick={() => { void runTest(draft) }} disabled={busy !== null}
                    className={outlineButton} style={outlineStyle}>
                    {busy === `test:${draft.id}` ? '测试中…' : '测试连接'}
                  </button>
                  {saved?.key_from_environment && (
                    <span className="text-xs" style={{ color: 'var(--color-fg-dim)' }}
                      title="环境变量里的 key 会覆盖这里填的,要改得去环境变量改">
                      key 来自系统环境变量，优先生效
                    </span>
                  )}
                </div>
              </div>

              {result && (
                <div data-testid={`vk-channel-result-${draft.id}`} className="mt-2 text-xs"
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

      {/* —— 角色指派 —— */}
      {drafts.length > 0 && (
        <div className="mt-4 space-y-2">
          {roleKeys.map((role) => (
            <div key={role} className="flex flex-wrap items-center gap-2">
              <span className="w-16 shrink-0 text-sm">{settings.role_labels[role]}</span>
              <select
                data-testid={`vk-role-${role}`}
                className="rounded-lg px-2 py-1.5 text-sm outline-none"
                style={{ ...fieldStyle, minWidth: '12rem' }}
                value={roles[role] ?? ''}
                onChange={(e) => setRoles((r) => {
                  const next = { ...r }
                  if (e.target.value) next[role] = e.target.value
                  else delete next[role]
                  return next
                })}
              >
                {/* 没有"跟随默认"了 —— 没指就是没指,跑到那一步会失败,得说出来。 */}
                <option value="">— 还没指定 —</option>
                {drafts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <span className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>{settings.role_hints[role]}</span>
            </div>
          ))}
        </div>
      )}

      {/* —— 新增 / 导入 —— */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" data-testid="vk-channel-add" onClick={addChannel}
          className={outlineButton} style={outlineStyle}>+ 新增配置</button>
        {settings.importable.map((item) => (
          <button key={item.id} type="button" data-testid={`vk-import-${item.id}`}
            title={`从本机既有配置导入：${item.model_id}`}
            onClick={() => importChannel(item)}
            className={outlineButton} style={{ ...outlineStyle, color: 'var(--color-accent)' }}>
            ↓ 导入 {item.name}
          </button>
        ))}
        {settings.cc_switch.available && settings.cc_switch.candidates.map((candidate) => (
          <button key={candidate.ref} type="button"
            data-testid={`vk-ccswitch-${candidate.ref}`}
            disabled={busy !== null}
            title={`从 cc-switch 导入：${candidate.base_url} · ${candidate.model_id || '未指定模型'} · ${candidate.masked_key}`}
            onClick={() => void importFromCcSwitch(candidate)}
            className={outlineButton} style={{ ...outlineStyle, color: 'var(--color-accent)' }}>
            ↓ {candidate.name}
          </button>
        ))}
      </div>
      {/* 认得出但导不了的,说清楚为什么 —— 比让它凭空消失强。 */}
      <div data-testid="vk-ccswitch">
        {settings.cc_switch.skipped.map((note) => (
          <div key={note} className="mt-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}>· {note}</div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="vk-provider-save"
          onClick={() => { void save() }}
          disabled={saving}
          className="rounded-lg px-4 py-1.5 text-sm font-medium disabled:opacity-50"
          style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {/* 没指到通道的角色点名说 —— 跑到那一步才失败更糟。 */}
        {settings.unassigned_roles.length > 0 && (
          <span data-testid="vk-unassigned" className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>
            还没指定：{settings.unassigned_roles.map((r) => settings.role_labels[r]).join('、')}
          </span>
        )}
      </div>
      {notice && <div data-testid="vk-provider-notice" role="status" className="mt-2 text-xs" style={{ color: 'var(--color-success)' }}>{notice}</div>}
      {error && <div data-testid="vk-provider-error" className="mt-2 text-xs" style={{ color: 'var(--color-danger)' }}>{error}</div>}
    </div>
  )
}
