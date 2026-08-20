import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Check, ChevronDown, ChevronUp, Copy, Eye, EyeOff, Lock, LockOpen, Pen, Plus, RefreshCw, Trash2, Wifi, X,
} from 'lucide-react'
import './VkProviderForm.css'
import { OverflowTooltip } from '../../components/OverflowTooltip'
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

function useDismissOnOutside(ref: { current: HTMLElement | null }, open: boolean, dismiss: () => void) {
  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Node && !ref.current?.contains(target)) dismiss()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [ref, open, dismiss])
}

function VisibilityButton({
  revealed,
  disabled,
  onClick,
  testId,
}: {
  revealed: boolean
  disabled: boolean
  onClick: () => void
  testId: string
}) {
  const [hovered, setHovered] = useState(false)
  const iconState = revealed
    ? (hovered ? 'eye' : 'eye-off')
    : (hovered ? 'eye-off' : 'eye')
  const Icon = iconState === 'eye' ? Eye : EyeOff

  return (
    <motion.button
      type="button"
      data-testid={testId}
      data-icon={iconState}
      onClick={onClick}
      onMouseEnter={() => { if (!disabled) setHovered(true) }}
      onMouseLeave={() => setHovered(false)}
      disabled={disabled}
      whileHover={disabled ? undefined : { scale: 1.02 }}
      whileTap={disabled ? undefined : { scale: 0.96 }}
      className="relative flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-[40px] border border-white/5 bg-white/[0.04] text-sm font-medium text-white transition-colors duration-150 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
      aria-label={revealed ? '隐藏 API key' : '显示 API key'}
      title={revealed ? '隐藏 API key' : '显示 API key'}
    >
      <span className="relative flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={iconState}
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.5, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 600, damping: 25 }}
            className="absolute inset-0 flex items-center justify-center"
          >
            <Icon className="h-4 w-4" />
          </motion.span>
        </AnimatePresence>
      </span>
    </motion.button>
  )
}

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
  enabled: boolean
  /** 点了「显示」之后取回的明文,只活在组件里 */
  revealed?: string
  /** 已存 key 点击输入框后进入编辑,但不改变当前明文显隐状态。 */
  key_editing?: boolean
}

const newId = () => `ch_${Math.random().toString(36).slice(2, 8)}`

function cloneDraft(draft: Draft): Draft {
  return { ...draft, extra_headers: { ...draft.extra_headers } }
}

function ActionIconButton({
  testId,
  label,
  onClick,
  disabled = false,
  children,
  tone = 'default',
  onHoverChange,
  iconState,
}: {
  testId: string
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
  tone?: 'default' | 'danger' | 'warning'
  onHoverChange?: (hovered: boolean) => void
  iconState?: string
}) {
  return (
    <motion.button
      type="button"
      data-testid={testId}
      data-icon={iconState}
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={() => { if (!disabled) onHoverChange?.(true) }}
      onMouseLeave={() => onHoverChange?.(false)}
      disabled={disabled}
      whileTap={disabled ? undefined : { opacity: 0.78 }}
      data-tooltip={label}
      className="vk-icon-action inline-flex h-8 w-8 items-center justify-center rounded-lg p-0 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        border: '1px solid var(--color-line)',
        color: tone === 'danger' ? 'var(--color-danger)' : tone === 'warning' ? 'var(--color-warning)' : 'var(--color-fg)',
      }}
    >
      {children}
    </motion.button>
  )
}

function DeleteActionButton({ testId, onClick, disabled = false }: { testId: string; onClick: () => void; disabled?: boolean }) {
  const [hovered, setHovered] = useState(false)
  return (
    <ActionIconButton testId={testId} label="删除" onClick={onClick} disabled={disabled} tone="danger" onHoverChange={setHovered} iconState="trash">
      <motion.span
        animate={hovered
          ? { y: [0, -2, 0, -2, 0], rotate: [0, -10, 10, -10, 0] }
          : { y: 0, rotate: 0 }}
        transition={{ duration: 0.4 }}
        className="inline-flex"
        aria-hidden="true"
      >
        <Trash2 size={14} />
      </motion.span>
    </ActionIconButton>
  )
}

function EditActionButton({ testId, onClick, disabled = false }: { testId: string; onClick: () => void; disabled?: boolean }) {
  const [hovered, setHovered] = useState(false)
  return (
    <ActionIconButton testId={testId} label="编辑" onClick={onClick} disabled={disabled} onHoverChange={setHovered} iconState={hovered ? 'check' : 'pen'}>
      <span className="inline-flex h-4 w-4 items-center justify-center" aria-hidden="true">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={hovered ? 'check' : 'pen'} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ type: 'spring', stiffness: 600, damping: 25 }} className="inline-flex">
            {hovered ? <Check size={14} /> : <Pen size={14} />}
          </motion.span>
        </AnimatePresence>
      </span>
    </ActionIconButton>
  )
}

function EnableActionButton({ testId, enabled, onClick, disabled = false }: { testId: string; enabled: boolean; onClick: () => void; disabled?: boolean }) {
  const [hovered, setHovered] = useState(false)
  const icon = enabled ? 'lock' : 'lock-open'
  const Icon = enabled ? Lock : LockOpen
  return (
    <ActionIconButton testId={testId} label={enabled ? '禁用' : '启用'} onClick={onClick} disabled={disabled} tone={enabled ? 'warning' : 'default'} onHoverChange={setHovered} iconState={icon}>
      <span className="inline-flex h-4 w-4 items-center justify-center" aria-hidden="true">
        <motion.span animate={hovered ? { x: [0, -1.5, 1.5, -1, 1, 0], rotate: [0, -5, 5, -3, 3, 0] } : { x: 0, rotate: 0 }} transition={{ type: 'tween', duration: 0.35, ease: 'easeOut' }} className="inline-flex">
          <Icon size={14} />
        </motion.span>
      </span>
    </ActionIconButton>
  )
}

function toDraft(channel: VkProviderSettings['channels'][number]): Draft {
  return {
    id: channel.id, name: channel.name, base_url: channel.base_url, model_id: channel.model_id,
    key_env: channel.key_env, api_style: channel.api_style, api_style_touched: true,
    reasoning_effort: channel.reasoning_effort_explicit ? channel.reasoning_effort : '',
    key_masked: channel.key_masked, extra_headers: { ...channel.extra_headers },
    api_key: '', key_touched: false, enabled: channel.enabled !== false,
  }
}

type ChannelEditorProps = {
  draft: Draft
  settings: VkProviderSettings
  saved?: VkProviderSettings['channels'][number]
  result?: VkProviderTestResult
  models: string[]
  availableReasoningEfforts: string[]
  channelBusy?: string
  onPatch: (id: string, next: Partial<Draft>) => void
  onPatchModel: (draft: Draft, modelId: string) => void
  onReveal: (draft: Draft) => void
  onTest: (draft: Draft) => void
  onClearError?: (field: string) => void
  errors?: Partial<Record<'base_url' | 'model_id' | 'api_key' | 'api_style' | 'reasoning_effort', string>>
}

function ChannelEditor({
  draft,
  settings,
  saved,
  result,
  models,
  availableReasoningEfforts,
  channelBusy,
  onPatch,
  onPatchModel,
  onReveal,
  onTest,
  onClearError,
  errors = {},
}: ChannelEditorProps) {
  const showMasked = !draft.key_touched && !draft.revealed && !draft.key_editing && draft.key_masked !== ''
  const channelIsBusy = Boolean(channelBusy)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  useDismissOnOutside(modelMenuRef, modelMenuOpen, () => setModelMenuOpen(false))
  const maskedKey = draft.key_masked ? '••••••••••••••••' : ''
  const field = (name: keyof typeof errors, label: string, child: ReactNode) => (
    <div className={`vk-validation-field ${errors[name] ? 'is-error' : ''}`}>
      <div className="mb-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}>{label}</div>
      {child}
      {errors[name] && <div className="vk-validation-message" role="alert">{errors[name]}</div>}
    </div>
  )
  return (
    <div className="space-y-2">
      {field('base_url', '接口地址（Base URL）', <input
        data-testid={`vk-channel-url-${draft.id}`}
        className={fieldClass} style={fieldStyle}
        placeholder="接口地址，例如 https://api.example.com/v1"
        value={draft.base_url}
        onChange={(e) => { onPatch(draft.id, { base_url: e.target.value }); onClearError?.('base_url') }}
      />)}
      {field('model_id', '模型 ID', <div className="relative flex items-start gap-2">
        <input
          data-testid={`vk-channel-model-${draft.id}`}
          className={fieldClass}
          style={{ ...fieldStyle, flex: 1, minWidth: 0 }}
          list={models.length ? `vk-models-${draft.id}` : undefined}
          placeholder="模型名称，例如 gpt-5.6-luna，可直接输入"
          value={draft.model_id}
          onChange={(e) => { onPatchModel(draft, e.target.value); onClearError?.('model_id') }}
        />
        <button
          type="button"
          data-testid={`vk-channel-models-fetch-${draft.id}`}
          className={outlineButton}
          style={{ ...outlineStyle, minHeight: '2.25rem', whiteSpace: 'nowrap' }}
          onClick={() => onTest(draft)}
          disabled={channelIsBusy}
        >
          <RefreshCw size={13} className={`mr-1 inline ${channelBusy === 'test' ? 'animate-spin' : ''}`} aria-hidden="true" />获取模型列表
        </button>
        {models.length > 0 && (
          <div ref={modelMenuRef} className="relative shrink-0">
            <button type="button" data-testid={`vk-channel-models-menu-${draft.id}`} aria-label="选择模型" title="选择模型" className="vk-icon-action inline-flex h-9 w-9 items-center justify-center rounded-lg" style={outlineStyle} onClick={() => setModelMenuOpen((open) => !open)}>
              <ChevronDown size={16} aria-hidden="true" />
            </button>
            {modelMenuOpen && <div role="listbox" className="vk-glass-menu absolute right-0 top-[calc(100%+0.35rem)] z-20 max-h-48 min-w-[14rem] overflow-auto rounded-lg p-1">
              {models.map((model) => <button key={model} type="button" role="option" aria-selected={model === draft.model_id} className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-white/5" onClick={() => { onPatchModel(draft, model); setModelMenuOpen(false) }}>
                <OverflowTooltip text={model} />
              </button>)}
            </div>}
          </div>
        )}
        <datalist id={`vk-models-${draft.id}`}>
          {models.map((model) => <option key={model} value={model} />)}
        </datalist>
      </div>)}

      <div className="flex flex-wrap items-center gap-2">
        <div className={`vk-validation-field min-w-0 flex-1 ${errors.api_key ? 'is-error' : ''}`}>
          <div className="mb-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}>API key</div>
          <input
            data-testid={`vk-channel-key-${draft.id}`}
            type={draft.revealed ? 'text' : 'password'}
            readOnly={showMasked}
            autoComplete="off"
            className={fieldClass}
            style={{ ...fieldStyle, color: showMasked ? 'var(--color-fg-dim)' : 'var(--color-fg)' }}
            placeholder="粘贴 API key"
            value={draft.revealed ?? (showMasked ? maskedKey : draft.api_key)}
            onFocus={() => { if (showMasked) onPatch(draft.id, { key_editing: true, api_key: '', key_touched: true, revealed: undefined }); onClearError?.('api_key') }}
            onChange={(e) => { onPatch(draft.id, { api_key: e.target.value, key_touched: true, key_editing: true, revealed: undefined }); onClearError?.('api_key') }}
          />
          {errors.api_key && <div className="vk-validation-message" role="alert">{errors.api_key}</div>}
        </div>
        <VisibilityButton
          testId={`vk-channel-reveal-${draft.id}`}
          revealed={Boolean(draft.revealed)}
          onClick={() => {
            if (draft.revealed) onPatch(draft.id, { revealed: undefined })
            else onReveal(draft)
          }}
          disabled={channelIsBusy || (!saved?.key_stored && !draft.key_masked)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {field('api_style', '接口协议', <select
          data-testid={`vk-channel-style-${draft.id}`}
          className="rounded-lg px-2 py-1.5 text-xs outline-none"
          style={fieldStyle}
          value={draft.api_style}
          onChange={(e) => { onPatch(draft.id, { api_style: e.target.value, api_style_touched: true }); onClearError?.('api_style') }}
        >
          {settings.api_styles.map((style) => <option key={style.id} value={style.id}>{style.label}</option>)}
        </select>)}
        <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
          <span>推理强度</span>
          <input
            data-testid={`vk-channel-reasoning-${draft.id}`}
            list={`vk-channel-reasoning-options-${draft.id}`}
            className="rounded-lg px-2 py-1.5 text-xs outline-none"
            style={fieldStyle}
            value={draft.reasoning_effort}
            disabled={channelIsBusy}
            placeholder="自动（跟随模型）"
            title={availableReasoningEfforts.length ? '下拉建议来自本次接口请求，也可以输入接口支持的其他值' : '接口未返回可枚举档位；可保持自动，或输入中转站支持的值'}
            onChange={(e) => { onPatch(draft.id, { reasoning_effort: e.target.value }); onClearError?.('reasoning_effort') }}
          />
          <datalist id={`vk-channel-reasoning-options-${draft.id}`}>
            {availableReasoningEfforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
          </datalist>
        </label>
        {result?.ok && availableReasoningEfforts.length === 0 && (
          <span data-testid={`vk-channel-reasoning-note-${draft.id}`} className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>中转站未返回可枚举档位；可保持自动，或输入其支持的值</span>
        )}
        <button type="button" data-testid={`vk-channel-test-${draft.id}`} onClick={() => onTest(draft)} disabled={channelIsBusy} className={outlineButton} style={outlineStyle}>
          <Wifi size={14} className="mr-1 inline" aria-hidden="true" />{channelBusy === 'test' ? '测试中…' : '测试连接'}
        </button>
        {saved?.key_from_environment && (
          <span className="text-xs" style={{ color: 'var(--color-fg-dim)' }} title="环境变量里的 key 会覆盖这里填的,要改得去环境变量改">key 来自系统环境变量，优先生效</span>
        )}
      </div>

      {result && (
        <div data-testid={`vk-channel-result-${draft.id}`} className="mt-2 text-xs" style={{ color: result.ok ? 'var(--color-success)' : 'var(--color-warning)' }}>
          {result.ok ? '✓ ' : '✗ '}{result.message}
        </div>
      )}
      {result && !result.ok && result.fix_hint && (
        <div data-testid={`vk-channel-fix-${draft.id}`} className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>下一步：{result.fix_hint}</div>
      )}
      {result && !result.ok && !result.retryable && draft.enabled && (
        <div data-testid={`vk-channel-invalid-${draft.id}`} className="mt-1 text-xs" style={{ color: 'var(--color-danger)' }}>此配置当前不可用。可修正后重试连接，或选择禁用/删除；爪爪不会自动删除。</div>
      )}
      {result?.normalization_notes?.map((note) => <div key={note} className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>{note}</div>)}
    </div>
  )
}

/**
 * 模型配置:一份通道清单 + 两个角色。
 *
 * 通道就是「地址 + 模型 + key」,官方站和中转站没有区别 —— 所以既没有内置预设,
 * 也没有「默认通道」:通道本来就是按用途建的,两个角色各指一条,"默认"没有语义。
 *
 * 三条贯穿全组件的纪律:
 *  · key 存过就**看得见存在**(全点号),点击输入框即可替换——不碰就不提交。
 *    明文只在点「显示」时单独取,取回来也只活在组件状态里。
 *  · 接口风格按模型名先填上,用户改过就不再覆盖。
 *  · 失败给根因 + 下一步;能自动修的当场修**并把改了什么写出来**。
 */
export function VkProviderForm({ baseUrl, onSaved }: { baseUrl?: string; onSaved?: () => void }) {
  const [settings, setSettings] = useState<VkProviderSettings | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [roles, setRoles] = useState<Record<string, string>>({})
  const [roleFallbacks, setRoleFallbacks] = useState<Record<string, string[]>>({})
  const [results, setResults] = useState<Record<string, VkProviderTestResult>>({})
  const [models, setModels] = useState<Record<string, string[]>>({})
  const [reasoningEfforts, setReasoningEfforts] = useState<Record<string, Record<string, string[]>>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [channelBusy, setChannelBusy] = useState<Record<string, string>>({})
  const [modalSession, setModalSession] = useState<{ id: string; original: Draft | null } | null>(null)
  const [saving, setSaving] = useState(false)
  const [ccSwitchPickerOpen, setCcSwitchPickerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [validationErrors, setValidationErrors] = useState<Record<string, Partial<Record<'name' | 'base_url' | 'model_id' | 'api_key' | 'api_style' | 'reasoning_effort', string>>>>({})
  const selectionGuard = useRef(false)
  const savingRef = useRef(false)
  const ccSwitchPickerRef = useRef<HTMLDivElement>(null)
  const modalId = modalSession?.id ?? null
  useDismissOnOutside(ccSwitchPickerRef, ccSwitchPickerOpen, () => setCcSwitchPickerOpen(false))

  const load = useCallback(async () => {
    try {
      const loaded = await fetchVkProviderSettings(baseUrl)
      setSettings(loaded)
      setDrafts(loaded.channels.map(toDraft))
      setRoles({ ...loaded.role_assignments })
      setRoleFallbacks(Object.fromEntries(
        Object.entries(loaded.role_fallbacks ?? {}).map(([role, ids]) => [role, [...ids]]),
      ))
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
      ...(model_id === draft.model_id ? {} : { reasoning_effort: '' }),
      ...(draft.api_style_touched ? {} : { api_style: inferApiStyle(model_id) }),
    })

  const openNewDraft = (draft: Draft) => {
    setDrafts((list) => [...list, draft])
    setValidationErrors((current) => { const next = { ...current }; delete next[draft.id]; return next })
    setModalSession({ id: draft.id, original: null })
  }

  const openEditor = (draft: Draft) => {
    setValidationErrors((current) => { const next = { ...current }; delete next[draft.id]; return next })
    setModalSession({ id: draft.id, original: cloneDraft(draft) })
  }

  const closeModal = (commit: boolean) => {
    if (!modalSession) return
    if (!commit) {
      setNotice(null)
      setDrafts((list) => modalSession.original
        ? list.map((draft) => draft.id === modalSession.id ? cloneDraft(modalSession.original!) : draft)
        : list.filter((draft) => draft.id !== modalSession.id))
      if (!modalSession.original) {
        setResults((current) => {
          const next = { ...current }
          delete next[modalSession.id]
          return next
        })
      }
    }
    setValidationErrors((current) => { const next = { ...current }; delete next[modalSession.id]; return next })
    setModalSession(null)
  }

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const addChannel = () => {
    const id = newId()
    const draft: Draft = {
      id, name: '新配置', base_url: '', model_id: '',
      key_env: `VK_CHANNEL_${id.toUpperCase()}_KEY`, api_style: 'openai_completions',
      api_style_touched: false, reasoning_effort: '', key_masked: '', extra_headers: {},
      api_key: '', key_touched: false, enabled: true,
    }
    openNewDraft(draft)
  }

  const importChannel = (item: VkProviderSettings['importable'][number]) => {
    const imported: Draft = {
      id: item.id, name: item.name, base_url: item.base_url, model_id: item.model_id,
      key_env: item.key_env, api_style: inferApiStyle(item.model_id), api_style_touched: false,
      reasoning_effort: '', key_masked: '', extra_headers: {}, api_key: '', key_touched: false,
      enabled: true,
    }
    const current = drafts.find((draft) => draft.id === item.id)
    if (current) openEditor(current)
    else openNewDraft(imported)
  }

  /** 从 cc-switch 导一条:地址、模型、接口风格、请求头、key 一次到位。 */
  const importFromCcSwitch = async (candidate: VkProviderSettings['cc_switch']['candidates'][number]) => {
    setCcSwitchPickerOpen(false)
    setBusy(`ccswitch:${candidate.ref}`)
    setError(null)
    try {
      const { channel, api_key } = await importVkCcSwitchChannel(
        candidate.ref, drafts.map((d) => d.id), baseUrl,
      )
      const imported: Draft = {
        id: channel.id, name: channel.name, base_url: channel.base_url,
        model_id: channel.model_id, key_env: channel.key_env, api_style: channel.api_style,
        api_style_touched: true, reasoning_effort: '', key_masked: '', extra_headers: channel.extra_headers,
        api_key, key_touched: true, enabled: true,
      }
      openNewDraft(imported)
    } catch (err) {
      setError(err instanceof Error ? err.message : '从 cc-switch 导入失败')
    } finally {
      setBusy(null)
    }
  }

  const channelPayload = (items: Draft[]): VkChannelPayload[] => items.map((draft) => ({
    id: draft.id, name: draft.name, base_url: draft.base_url, model_id: draft.model_id,
    key_env: draft.key_env, api_style: draft.api_style,
    reasoning_effort: draft.reasoning_effort || null,
    extra_headers: draft.extra_headers,
    enabled: draft.enabled,
    // 没碰过就不传 api_key —— 表示「不动已存的那把」,而不是清空。
    ...(draft.key_touched ? { api_key: draft.api_key } : {}),
  }))

  const persist = async (
    nextDrafts: Draft[],
    nextRoles: Record<string, string>,
    nextRoleFallbacks: Record<string, string[]>,
    showNotice = false,
  ): Promise<boolean> => {
    if (savingRef.current) return false
    savingRef.current = true
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const result = await saveVkProviderSettings({
        channels: channelPayload(nextDrafts), roles: nextRoles, role_fallbacks: nextRoleFallbacks,
      }, baseUrl)
      if (showNotice) {
        setNotice([
          '已保存并立即生效',
          ...result.normalization_notes,
          result.keys_written.length ? `已安全保存 ${result.keys_written.length} 把 key` : '',
        ].filter(Boolean).join('；'))
      }
      // 角色选择、启停、删除和备用顺序采用乐观更新。服务端保存响应不含完整
      // settings，立即重新读取会把尚未刷新的旧快照覆盖回页面。弹窗保存仍回读，
      // 以接收服务端的规范化结果。
      if (showNotice) await load()
      onSaved?.()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : '模型配置保存失败')
      void load()
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const save = () => persist(drafts, roles, roleFallbacks, true)

  const removeChannel = (id: string) => {
    const nextDrafts = drafts.filter((draft) => draft.id !== id)
    const nextRoles = Object.fromEntries(Object.entries(roles).filter(([, value]) => value !== id))
    const nextRoleFallbacks = Object.fromEntries(
      Object.entries(roleFallbacks).map(([role, ids]) => [role, ids.filter((item) => item !== id)]),
    )
    setDrafts(nextDrafts)
    setModalSession((current) => current?.id === id ? null : current)
    setRoles(nextRoles)
    setRoleFallbacks(nextRoleFallbacks)
    void persist(nextDrafts, nextRoles, nextRoleFallbacks)
  }

  const reuseChannel = (draft: Draft) => {
    const id = newId()
    const reused: Draft = {
      ...draft,
      id,
      name: `${draft.name || '新配置'} · 复用`,
      key_env: draft.key_env,
      // Keep a saved key reference, but do not force the user to submit a
      // plaintext key again. Unsaved text remains local to this draft.
      api_key: draft.key_touched ? draft.api_key : '',
      key_touched: draft.key_touched,
      revealed: undefined,
    }
    openNewDraft(reused)
  }

  const setChannelEnabled = (id: string, enabled: boolean) => {
    const nextDrafts = drafts.map((draft) => draft.id === id ? { ...draft, enabled } : draft)
    const nextRoles = enabled ? roles : Object.fromEntries(Object.entries(roles).filter(([, value]) => value !== id))
    const nextRoleFallbacks = enabled ? roleFallbacks : Object.fromEntries(
      Object.entries(roleFallbacks).map(([role, ids]) => [role, ids.filter((item) => item !== id)]),
    )
    setDrafts(nextDrafts)
    setRoles(nextRoles)
    setRoleFallbacks(nextRoleFallbacks)
    void persist(nextDrafts, nextRoles, nextRoleFallbacks)
  }

  const setRole = (role: string, value: string) => {
    const nextRoles = { ...roles }
    if (value) nextRoles[role] = value
    else delete nextRoles[role]
    setRoles(nextRoles)
    void persist(drafts, nextRoles, roleFallbacks)
  }

  const patchRoleFallback = (role: string, index: number, value: string) => {
    const next = [...(roleFallbacks[role] ?? [])]
    if (value) next[index] = value
    else next.splice(index, 1)
    const nextRoleFallbacks = { ...roleFallbacks, [role]: next }
    setRoleFallbacks(nextRoleFallbacks)
    void persist(drafts, roles, nextRoleFallbacks)
  }

  const moveRoleFallback = (role: string, index: number, offset: -1 | 1) => {
    const next = [...(roleFallbacks[role] ?? [])]
    const target = index + offset
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    const nextRoleFallbacks = { ...roleFallbacks, [role]: next }
    setRoleFallbacks(nextRoleFallbacks)
    void persist(drafts, roles, nextRoleFallbacks)
  }

  const addRoleFallback = (role: string, channelId: string) => {
    const nextRoleFallbacks = { ...roleFallbacks, [role]: [...(roleFallbacks[role] ?? []), channelId] }
    setRoleFallbacks(nextRoleFallbacks)
    void persist(drafts, roles, nextRoleFallbacks)
  }

  const reveal = async (draft: Draft) => {
    setChannelBusy((current) => ({ ...current, [draft.id]: 'reveal' }))
    setError(null)
    try {
      const result = await revealVkProviderKey(draft.key_env, baseUrl)
      patch(draft.id, { revealed: result.found ? (result.api_key ?? '') : '(尚未保存)' })
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取 key 失败')
    } finally {
      setChannelBusy((current) => {
        const next = { ...current }
        delete next[draft.id]
        return next
      })
    }
  }

  const runTest = async (draft: Draft) => {
    setChannelBusy((current) => ({ ...current, [draft.id]: 'test' }))
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
      setChannelBusy((current) => {
        const next = { ...current }
        delete next[draft.id]
        return next
      })
    }
  }

  const hasModalSelection = () => {
    const selection = window.getSelection()
    const modal = document.querySelector('[data-testid="vk-provider-modal"]')
    if (!modal) return false
    const focused = document.activeElement
    if ((focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement)
      && modal.contains(focused)
      && focused.selectionStart !== null
      && focused.selectionEnd !== null
      && focused.selectionStart !== focused.selectionEnd) return true
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false
    return modal.contains(selection.anchorNode) || modal.contains(selection.focusNode)
  }

  const saveModal = async (draft: Draft) => {
    const errors: Partial<Record<'name' | 'base_url' | 'model_id' | 'api_key' | 'api_style' | 'reasoning_effort', string>> = {}
    if (!draft.name.trim()) errors.name = '请输入配置名称'
    if (!draft.base_url.trim()) errors.base_url = '请输入接口地址'
    if (!draft.model_id.trim()) errors.model_id = '请输入模型 ID'
    if (!draft.key_masked && !draft.api_key.trim()) errors.api_key = '请输入 API key'
    if (Object.keys(errors).length) {
      setValidationErrors((current) => ({ ...current, [draft.id]: errors }))
      return
    }
    const ok = await save()
    if (ok) closeModal(true)
  }

  if (!settings) {
    return <div data-testid="vk-provider-form" className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>
      {error ?? '读取中…'}
    </div>
  }

  const roleKeys = Object.keys(settings.role_labels)

  return (
    <div data-testid="vk-provider-form" className="space-y-4">
      <section data-testid="vk-provider-channels-section" className="rounded-xl p-4"
        style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-sm font-medium">模型配置</div>
        <div className="flex items-center gap-2">
          {settings.cc_switch.available && (
            <div ref={ccSwitchPickerRef} className="relative">
              <ActionIconButton
                testId="vk-ccswitch-import"
                label="从 cc-switch 导入配置"
                onClick={() => setCcSwitchPickerOpen((open) => !open)}
                disabled={busy !== null || saving}
              >
                <img src="/cc-switch-icon.png" alt="" aria-hidden="true" className="h-4 w-4" />
              </ActionIconButton>
              {ccSwitchPickerOpen && (
                <div data-testid="vk-ccswitch-picker" role="menu" className="vk-glass-menu absolute right-0 top-10 z-20 min-w-56 rounded-lg p-1">
                  {settings.cc_switch.candidates.map((candidate) => (
                    <button
                      key={candidate.ref}
                      type="button"
                      role="menuitem"
                      data-testid={`vk-ccswitch-${candidate.ref}`}
                      disabled={busy !== null || saving}
                      title={`从 cc-switch 导入：${candidate.base_url} · ${candidate.model_id || '未指定模型'} · ${candidate.masked_key}`}
                      onClick={() => void importFromCcSwitch(candidate)}
                      className="block w-full rounded-md px-2 py-1.5 text-left text-xs disabled:opacity-50"
                      style={{ color: 'var(--color-fg)' }}
                    >
                      <OverflowTooltip text={candidate.name} labelClassName="text-xs" />
                      <OverflowTooltip text={candidate.model_id || '未指定模型'} labelClassName="text-[0.7rem]" labelStyle={{ color: 'var(--color-fg-dim)' }} />
                    </button>
                  ))}
                  {settings.cc_switch.skipped.map((note) => (
                    <div key={note} data-testid="vk-ccswitch-skipped" className="px-2 py-1.5 text-xs" style={{ color: 'var(--color-fg-dim)' }}>{note}</div>
                  ))}
                  {settings.cc_switch.candidates.length === 0 && settings.cc_switch.skipped.length === 0 && (
                    <div className="px-2 py-1.5 text-xs" style={{ color: 'var(--color-fg-dim)' }}>未发现可导入配置</div>
                  )}
                </div>
              )}
            </div>
          )}
          <button type="button" data-testid="vk-channel-add" onClick={addChannel}
            className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium"
            style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}>
            <Plus size={14} aria-hidden="true" /> 创建配置
          </button>
        </div>
      </div>

      {/* —— 通道清单 —— */}
      <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--color-line)' }}>
        <div
          className="grid min-w-[56rem] grid-cols-[1fr_1.35fr_1fr_.7fr_minmax(22rem,auto)] gap-3 px-3 py-2 text-xs font-medium"
          style={{ color: 'var(--color-fg-dim)', borderBottom: '1px solid var(--color-line)' }}
        >
          <span>名称</span><span>API key / 上游</span><span>模型</span><span>状态</span><span>操作</span>
        </div>
        <div className="divide-y" style={{ borderColor: 'var(--color-line)' }}>
          {drafts.length === 0 && (
            <div className="px-3 py-8 text-center text-sm" style={{ color: 'var(--color-fg-dim)' }}>暂无模型配置</div>
          )}
          {drafts.map((draft) => {
            const result = results[draft.id]
            const saved = settings.channels.find((channel) => channel.id === draft.id)
            const showMasked = !draft.key_touched && !draft.revealed && draft.key_masked !== ''
            let upstream = draft.base_url || '未填写上游地址'
            try { upstream = draft.base_url ? new URL(draft.base_url).hostname : upstream } catch { /* show the raw draft */ }
            const statusLabel = !draft.enabled
              ? '已禁用'
              : (result ? (result.ok ? '连接正常' : '连接失败') : '已启用')
            const statusColor = !draft.enabled
              ? 'var(--color-warning)'
              : (result
                ? (result.ok ? 'var(--color-success)' : 'var(--color-danger)')
                : 'var(--color-success)')
            return (
              <div key={draft.id} data-testid={`vk-channel-${draft.id}`} className="min-w-[56rem] px-3 py-3"
                style={{ background: 'var(--color-canvas)' }}>
                <div className="grid grid-cols-[1fr_1.35fr_1fr_.7fr_minmax(22rem,auto)] items-center gap-3">
                  <OverflowTooltip
                    testId={`vk-channel-name-${draft.id}`}
                    text={draft.name || '未命名配置'}
                    labelClassName="text-sm font-medium"
                  />
                  <div className="min-w-0">
                    <div className="truncate text-xs" style={{ color: 'var(--color-fg)' }}>
                      {showMasked ? draft.key_masked : (draft.key_touched && draft.api_key ? '未保存 key' : '未设置 key')}
                    </div>
                    <OverflowTooltip
                      text={upstream}
                      className="mt-1"
                      labelClassName="text-xs"
                      labelStyle={{ color: 'var(--color-fg-dim)' }}
                    >
                      {upstream}
                    </OverflowTooltip>
                    {saved?.key_from_environment && (
                      <div className="mt-1 truncate text-xs" style={{ color: 'var(--color-warning)' }}>key 来自系统环境变量，优先生效</div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <OverflowTooltip text={draft.model_id || '未指定模型'} labelClassName="text-sm" labelStyle={{ color: 'var(--color-fg)' }} />
                    <div className="mt-1 truncate text-xs" style={{ color: 'var(--color-fg-dim)' }}>{draft.api_style}</div>
                  </div>
                  <div className="flex items-center gap-2 text-xs" style={{ color: statusColor }}>
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor }} aria-hidden="true" />
                    <span>{statusLabel}</span>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    <ActionIconButton testId={`vk-channel-reuse-${draft.id}`} label="复用" onClick={() => reuseChannel(draft)} disabled={saving}>
                      <Copy size={14} aria-hidden="true" />
                    </ActionIconButton>
                    {modalId !== draft.id && (
                      <ActionIconButton
                        testId={`vk-channel-test-${draft.id}`}
                        label={channelBusy[draft.id] === 'test' ? '测试中…' : '测试连接'}
                        onClick={() => { void runTest(draft) }}
                        disabled={Boolean(channelBusy[draft.id]) || saving}
                      >
                        <RefreshCw size={14} className={channelBusy[draft.id] === 'test' ? 'animate-spin' : ''} aria-hidden="true" />
                      </ActionIconButton>
                    )}
                    <EditActionButton testId={`vk-channel-edit-${draft.id}`} onClick={() => openEditor(draft)} disabled={saving} />
                    <DeleteActionButton testId={`vk-channel-remove-${draft.id}`} onClick={() => removeChannel(draft.id)} disabled={saving} />
                    <EnableActionButton testId={`vk-channel-toggle-${draft.id}`} enabled={draft.enabled} onClick={() => setChannelEnabled(draft.id, !draft.enabled)} disabled={saving} />
                  </div>
                </div>

                {modalId !== draft.id && result && (
                  <div data-testid={`vk-channel-result-${draft.id}`} className="mt-2 text-xs"
                    style={{ color: result.ok ? 'var(--color-success)' : 'var(--color-warning)' }}>
                    {result.ok ? '✓ ' : '✗ '}{result.message}
                  </div>
                )}
                {modalId !== draft.id && result && !result.ok && result.fix_hint && (
                  <div data-testid={`vk-channel-fix-${draft.id}`} className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>
                    下一步：{result.fix_hint}
                  </div>
                )}
                {modalId !== draft.id && result && !result.ok && !result.retryable && draft.enabled && (
                  <div data-testid={`vk-channel-invalid-${draft.id}`} className="mt-1 text-xs" style={{ color: 'var(--color-danger)' }}>
                    此配置当前不可用。可修正后重试连接，或选择禁用/删除；爪爪不会自动删除。
                  </div>
                )}
                {modalId !== draft.id && result?.normalization_notes?.map((note) => (
                  <div key={note} className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>{note}</div>
                ))}
              </div>
            )
          })}
        </div>
      </div>

      </section>

      {modalId && (() => {
        const modalDraft = drafts.find((draft) => draft.id === modalId)
        if (!modalDraft) return null
        const modalSaved = settings.channels.find((channel) => channel.id === modalDraft.id)
        const modalResult = results[modalDraft.id]
        const modalEfforts = reasoningEfforts[modalDraft.id]?.[modalDraft.model_id] ?? []
        const isNew = modalSession?.original === null
        return (
          <div
            data-testid="vk-provider-modal-backdrop"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
            role="presentation"
            onMouseDown={() => { selectionGuard.current = hasModalSelection() }}
            onClick={(event) => {
              const blocked = selectionGuard.current || hasModalSelection()
              selectionGuard.current = false
              if (event.target === event.currentTarget && !blocked) closeModal(false)
            }}
          >
            <div data-testid="vk-provider-modal" role="dialog" aria-modal="true" aria-labelledby="vk-provider-modal-title" className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl p-5 shadow-2xl" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
              <div className="mb-4 flex items-center justify-between gap-3">
                <h3 id="vk-provider-modal-title" className="text-lg font-semibold">{isNew ? '创建配置' : '编辑配置'}</h3>
                <button type="button" aria-label="关闭模型配置弹窗" title="关闭" onClick={() => closeModal(false)} className="rounded-lg p-1.5" style={outlineStyle}><X size={18} /></button>
              </div>
              <div className="mb-3 grid gap-2 sm:grid-cols-2">
                <div className={`vk-validation-field ${validationErrors[modalDraft.id]?.name ? 'is-error' : ''}`}>
                  <label className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>
                    名称
                    <input data-testid="vk-modal-name" className={`${fieldClass} mt-1`} style={fieldStyle} placeholder="例如：日常总结" value={modalDraft.name} onChange={(event) => { patch(modalDraft.id, { name: event.target.value }); setValidationErrors((current) => ({ ...current, [modalDraft.id]: { ...current[modalDraft.id], name: undefined } })) }} />
                  </label>
                  {validationErrors[modalDraft.id]?.name && <div className="vk-validation-message" role="alert">{validationErrors[modalDraft.id].name}</div>}
                </div>
                <label className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>
                  分组 / 中转站
                  <input data-testid="vk-modal-group" className={`${fieldClass} mt-1`} style={fieldStyle} value={modalDraft.base_url ? (() => { try { return new URL(modalDraft.base_url).hostname } catch { return '' } })() : ''} readOnly placeholder="自动识别上游" />
                </label>
              </div>
              <ChannelEditor
                draft={modalDraft}
                settings={settings}
                saved={modalSaved}
                result={modalResult}
                models={models[modalDraft.id] ?? []}
                availableReasoningEfforts={modalEfforts}
                channelBusy={channelBusy[modalDraft.id]}
                onPatch={patch}
                onPatchModel={patchModel}
                onReveal={(item) => { void reveal(item) }}
                onTest={(item) => { void runTest(item) }}
                errors={validationErrors[modalDraft.id]}
                onClearError={(field) => setValidationErrors((current) => ({
                  ...current,
                  [modalDraft.id]: { ...current[modalDraft.id], [field]: undefined },
                }))}
              />
              <div className="mt-5 flex justify-end gap-2" style={{ borderTop: '1px solid var(--color-line)', paddingTop: '1rem' }}>
                <button type="button" data-testid="vk-provider-modal-cancel" onClick={() => closeModal(false)} className={outlineButton} style={outlineStyle}>取消</button>
                <button type="button" data-testid="vk-provider-modal-submit" onClick={() => { void saveModal(modalDraft) }} disabled={saving} className="rounded-lg px-4 py-1.5 text-sm font-medium disabled:opacity-50" style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}>{saving ? '保存中…' : '保存'}</button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* —— 角色指派 —— */}
      {drafts.length > 0 && (
        <section data-testid="vk-provider-routing-section" className="space-y-2 rounded-xl p-4" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
          <div className="text-sm font-medium">选择模型配置</div>
          {roleKeys.map((role) => {
            const fallbacks = roleFallbacks[role] ?? []
            const primary = roles[role] ?? ''
            const selected = new Set([primary, ...fallbacks].filter(Boolean))
            const available = drafts.filter((draft) => draft.enabled)
            return (
            <div key={role} data-testid={`vk-role-routing-${role}`} className="rounded-lg p-2" style={{ border: '1px solid var(--color-line)' }}>
              <div className="flex flex-wrap items-center gap-2">
              <span className="w-16 shrink-0 text-sm">{settings.role_labels[role]}</span>
              <select
                data-testid={`vk-role-${role}`}
                className="rounded-lg px-2 py-1.5 text-sm outline-none"
                style={{ ...fieldStyle, minWidth: '12rem' }}
                value={roles[role] ?? ''}
                disabled={saving}
                onChange={(event) => setRole(role, event.target.value)}
              >
                {/* 没有"跟随默认"了 —— 没指就是没指,跑到那一步会失败,得说出来。 */}
                <option value="">— 还没指定 —</option>
                {available.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <span className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>{settings.role_hints[role]}</span>
              </div>
              <div className="mt-2 space-y-1.5 pl-0 sm:pl-[4.5rem]">
                {fallbacks.map((channelId, index) => (
                  <div key={`${role}-${index}`} className="flex flex-wrap items-center gap-1.5">
                    <span className="w-14 text-xs" style={{ color: 'var(--color-fg-dim)' }}>备用 {index + 1}</span>
                    <select
                      data-testid={`vk-role-fallback-${role}-${index}`}
                      className="rounded-lg px-2 py-1.5 text-xs outline-none"
                      style={{ ...fieldStyle, minWidth: '12rem' }}
                      value={channelId}
                      disabled={saving}
                      onChange={(event) => patchRoleFallback(role, index, event.target.value)}
                    >
                      <option value="">— 删除这条备用 —</option>
                      {available.map((draft) => (
                        <option key={draft.id} value={draft.id} disabled={draft.id !== channelId && selected.has(draft.id)}>{draft.name}</option>
                      ))}
                    </select>
                    <button type="button" aria-label={`上移${settings.role_labels[role]}备用 ${index + 1}`} disabled={saving || index === 0}
                      onClick={() => moveRoleFallback(role, index, -1)} className={outlineButton} style={outlineStyle}><ChevronUp size={13} /></button>
                    <button type="button" aria-label={`下移${settings.role_labels[role]}备用 ${index + 1}`} disabled={saving || index === fallbacks.length - 1}
                      onClick={() => moveRoleFallback(role, index, 1)} className={outlineButton} style={outlineStyle}><ChevronDown size={13} /></button>
                    <button type="button" aria-label={`删除${settings.role_labels[role]}备用 ${index + 1}`} disabled={saving}
                      onClick={() => patchRoleFallback(role, index, '')} className={outlineButton} style={outlineStyle}><Trash2 size={13} /></button>
                  </div>
                ))}
                <button type="button" data-testid={`vk-role-fallback-add-${role}`}
                  disabled={saving || !primary || !available.some((draft) => !selected.has(draft.id))}
                  onClick={() => {
                    const next = available.find((draft) => !selected.has(draft.id))
                    if (next) addRoleFallback(role, next.id)
                  }} className={outlineButton} style={outlineStyle}>
                  <Plus size={13} className="mr-1 inline" />添加备用通道
                </button>
                {(settings.role_route_warnings?.[role] ?? []).map((warning) => (
                  <div key={warning} data-testid={`vk-role-warning-${role}`} className="text-xs" style={{ color: 'var(--color-warning)' }}>{warning}</div>
                ))}
              </div>
            </div>
          )})}
          <div data-testid="vk-role-routing-note" className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>
            每个角色只使用这里明确列出的顺序；仅超时、429 或上游 5xx 才切到下一条。鉴权、参数或模型不支持会直接停止，不会换通道掩盖配置问题。
          </div>
        </section>
      )}

      {/* —— 新增 / 导入 —— */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {settings.importable.map((item) => (
          <button key={item.id} type="button" data-testid={`vk-import-${item.id}`}
            title={`从本机既有配置导入：${item.model_id}`}
            onClick={() => importChannel(item)}
            className={outlineButton} style={{ ...outlineStyle, color: 'var(--color-accent)' }}>
            ↓ 导入 {item.name}
          </button>
        ))}
      </div>
      {notice && <div data-testid="vk-provider-notice" role="status" className="vk-provider-feedback vk-provider-feedback--success">{notice}</div>}
      {error && <div data-testid="vk-provider-error" role="alert" className="vk-provider-feedback vk-provider-feedback--error">{error}</div>}
    </div>
  )
}
