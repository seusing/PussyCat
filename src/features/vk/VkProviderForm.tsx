import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { MorphIcon } from 'morphicons/react'
import { Activity as MorphActivity, Download as MorphDownload, Plus as MorphPlus, type IconNode } from 'lucide'
import {
  Check, Copy, Eye, EyeOff, Lock, LockOpen, Pen, Trash2, X,
} from 'lucide-react'
import './VkProviderForm.css'
import { AppAlert } from '../../components/AppAlert'
import { AppNotificationPortal } from '../../components/AppNotificationPortal'
import { AppNotificationStack } from '../../components/AppNotificationStack'
import { GlassCombobox, GlassMultiSelect, GlassSelect } from '../../components/GlassMenu'
import { useGlassMenuSurface } from '../../components/GlassMenu'
import { OverflowTooltip } from '../../components/OverflowTooltip'
import {
  fetchVkProviderSettings,
  fetchVkJevConfigs,
  saveVkJevConfigItem,
  enableVkJevConfig,
  deleteVkJevConfig,
  testVkJevConfig,
  saveVkJevConfig,
  importVkCcSwitchChannel,
  revealVkProviderKey,
  saveVkProviderSettings,
  testVkProvider,
  type VkChannelPayload,
  type VkProviderSettings,
  type VkProviderTestResult,
  type VkJevConfig,
  fetchVkRuntimeStatus,
  postVkRuntimeInstall,
} from '../../host/vkClient'
import { HostRequestError } from '../../host/errors'

const fieldClass = 'w-full rounded-lg px-3 py-2 text-sm outline-none'
const fieldStyle = {
  background: 'var(--color-canvas)', border: '1px solid var(--color-line)', color: 'var(--color-fg)',
} as const
const outlineButton = 'rounded-lg px-2 py-1 text-xs disabled:opacity-50'
const outlineStyle = { border: '1px solid var(--color-line)', color: 'var(--color-fg)' } as const

type AlertLocation = 'form' | 'modal'

type Notice = {
  id: number
  message: string
  tone: 'success' | 'error'
  location: AlertLocation
  dismissible?: boolean
}

type ChannelBusyState = {
  models?: boolean
  test?: boolean
  reveal?: boolean
}

type ScopedError = { message: string; location: AlertLocation }
type PersistResult = { ok: boolean; noticeMessage?: string; error?: string }
type RouteSnapshot = {
  drafts: Draft[]
  roles: Record<string, string>
  roleFallbacks: Record<string, string[]>
  roleCompositeEnabled: Record<string, boolean>
}

const NOTICE_DURATION_MS = 2000
const ROUTING_ROLES = ['deep_analysis', 'basic'] as const

function useDismissOnOutside(ref: { current: HTMLElement | null }, open: boolean, dismiss: () => void, portalRef?: { current: HTMLElement | null }) {
  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Node && !ref.current?.contains(target) && !portalRef?.current?.contains(target)) dismiss()
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
  }, [ref, portalRef, open, dismiss])
}

function VisibilityButton({
  visible,
  disabled,
  onClick,
  testId,
}: {
  visible: boolean
  disabled: boolean
  onClick: () => void
  testId: string
}) {
  const [hovered, setHovered] = useState(false)
  const iconState = visible
    ? (hovered ? 'eye' : 'eye-off')
    : (hovered ? 'eye-off' : 'eye')
  const Icon = iconState === 'eye' ? Eye : EyeOff
  const label = visible ? '隐藏 API key' : '显示 API key'

  return (
    <motion.button
      type="button"
      data-testid={testId}
      data-icon={iconState}
      data-tooltip={label}
      onClick={onClick}
      onMouseEnter={() => { if (!disabled) setHovered(true) }}
      onMouseLeave={() => setHovered(false)}
      disabled={disabled}
      whileHover={disabled ? undefined : { scale: 1.02 }}
      className="vk-icon-action vk-key-eye-button relative flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-[40px] border border-white/5 bg-white/[0.04] text-sm font-medium text-white transition-colors duration-150 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
      aria-label={label}
      title={label}
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

function MorphActionGlyph({ icon, size = 14, className }: { icon: IconNode; size?: number; className?: string }) {
  return (
    <MorphIcon
      icon={icon}
      size={size}
      strokeWidth={2}
      reducedMotion="user"
      className={className}
      aria-hidden="true"
    />
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
  /** 默认为 medium；用户输入的其他值直接传给已有 provider 配置。 */
  reasoning_effort: string
  /** 已存 key 的打码值。**空输入框会被当成"没设过"**,所以存过就得看得见。 */
  key_masked: string
  /** 中转站要求的额外请求头(如 codex 的 x-openai-actor-authorization)。
   *  表单不给编辑,但必须原样带过保存 —— 丢了有些中转站会直接拒。 */
  extra_headers: Record<string, string>
  /** 用户这次输入的 key(未保存);未 touched 时不提交,表示"不改动已存的那把"。 */
  api_key: string
  key_touched: boolean
  /** 组件内存里是否已持有真实明文。 */
  key_loaded: boolean
  /** 当前输入框是否按明文显示。隐藏时仍保留完整 api_key,由 password input 负责打点。 */
  key_visible: boolean
  enabled: boolean
}

const newId = () => `ch_${Math.random().toString(36).slice(2, 8)}`

function cloneDraft(draft: Draft): Draft {
  return { ...draft, extra_headers: { ...draft.extra_headers } }
}

function routeHasDuplicateHost(route: string[], drafts: Draft[]): boolean {
  const byId = new Map(drafts.filter((draft) => draft.enabled).map((draft) => [draft.id, draft]))
  const hosts = route.flatMap((id) => {
    const baseUrl = byId.get(id)?.base_url
    if (!baseUrl) return []
    try { return [new URL(baseUrl).hostname.toLocaleLowerCase()] } catch { return [] }
  })
  return hosts.length !== new Set(hosts).size
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
  appearance = 'default',
  size = 'sm',
  state,
  className = '',
  opacity,
}: {
  testId: string
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
  tone?: 'default' | 'danger' | 'warning'
  onHoverChange?: (hovered: boolean) => void
  iconState?: string
  appearance?: 'default' | 'primary'
  size?: 'sm' | 'md'
  state?: string
  className?: string
  opacity?: number
}) {
  const color = appearance === 'primary'
    ? 'var(--color-on-accent)'
    : tone === 'danger'
      ? 'var(--color-danger)'
      : tone === 'warning'
        ? 'var(--color-warning)'
        : 'var(--color-fg)'
  return (
    <motion.button
      type="button"
      data-testid={testId}
      data-icon={iconState}
      data-state={state}
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={() => { if (!disabled) onHoverChange?.(true) }}
      onMouseLeave={() => onHoverChange?.(false)}
      disabled={disabled}
      animate={opacity === undefined ? undefined : { opacity }}
      whileTap={disabled ? undefined : { opacity: 0.78 }}
      data-tooltip={label}
      className={`vk-icon-action inline-flex ${size === 'md' ? 'h-9 w-9' : 'h-8 w-8'} items-center justify-center rounded-lg p-0 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${appearance === 'primary' ? 'vk-icon-action--primary' : ''} ${className}`}
      style={{
        border: appearance === 'primary' ? '1px solid transparent' : '1px solid var(--color-line)',
        color,
        ...(appearance === 'primary' ? { background: 'var(--color-accent)' } : {}),
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

function EnableActionButton({ testId, enabled, onClick, disabled = false, mutedWhenDisabled = false }: { testId: string; enabled: boolean; onClick: () => void; disabled?: boolean; mutedWhenDisabled?: boolean }) {
  const [hovered, setHovered] = useState(false)
  const icon = enabled ? 'lock' : 'lock-open'
  const Icon = enabled ? Lock : LockOpen
  const activeDisabled = mutedWhenDisabled && enabled && disabled
  return (
    <ActionIconButton testId={testId} label={enabled ? '禁用' : '启用'} onClick={onClick} disabled={disabled} tone={enabled ? 'warning' : 'default'} onHoverChange={setHovered} iconState={icon} state={activeDisabled ? 'active-disabled' : enabled ? 'enabled' : 'available'} className={activeDisabled ? 'vk-jev-enable-action vk-jev-enable-action--active' : undefined} opacity={disabled ? 0.5 : 1}>
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
    reasoning_effort: channel.reasoning_effort_explicit && channel.reasoning_effort?.trim()
      ? channel.reasoning_effort
      : 'medium',
    key_masked: channel.key_masked, extra_headers: { ...channel.extra_headers },
    api_key: '', key_touched: false, key_loaded: false, key_visible: false, enabled: channel.enabled !== false,
  }
}

function formatTestNotice(result: VkProviderTestResult): string {
  return [
    result.message,
    !result.ok && result.fix_hint ? `下一步：${result.fix_hint}` : '',
    ...(result.normalization_notes ?? []),
  ].filter(Boolean).join('；')
}

function getModelLabel(modelId: string, labels?: Record<string, string>): string {
  return labels?.[modelId] ?? modelId
}

function isJevNotFound(error: unknown): boolean {
  if (!(error instanceof HostRequestError)) return false
  if (error.status !== 404) return false
  return /not\s*found/i.test(error.summary)
}

function normalizeJevConfigsResult(value: unknown): Partial<{
  configured: boolean
  configs: VkJevConfig[]
  active_id: string | null
}> {
  if (!value || typeof value !== 'object') return {}
  let record = value as Record<string, unknown>
  for (let depth = 0; depth < 3; depth += 1) {
    const wrapped = record.data ?? record.result
    if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped)) break
    record = wrapped as Record<string, unknown>
  }
  const activeId = typeof record.active_id === 'string' ? record.active_id : null
  const configs = Array.isArray(record.configs)
    ? (record.configs as VkJevConfig[]).map((item) => ({ ...item, enabled: activeId ? item.id === activeId : item.enabled === true }))
    : undefined
  return { ...record, ...(configs ? { configs } : {}), ...(activeId !== null || 'active_id' in record ? { active_id: activeId } : {}) } as Partial<{ configured: boolean; configs: VkJevConfig[]; active_id: string | null }>
}

type ChannelEditorProps = {
  draft: Draft
  settings: VkProviderSettings
  saved?: VkProviderSettings['channels'][number]
  result?: VkProviderTestResult
  models: string[]
  modelLabels: Record<string, string>
  availableReasoningEfforts: string[]
  channelBusy?: ChannelBusyState
  onPatch: (id: string, next: Partial<Draft>) => void
  onPatchModel: (draft: Draft, modelId: string) => void
  onReveal: (draft: Draft) => void
  onTest: (draft: Draft, probeGeneration: boolean) => void
  onClearError?: (field: string) => void
  errors?: Partial<Record<'base_url' | 'model_id' | 'api_key' | 'api_style' | 'reasoning_effort', string>>
}

function ChannelEditor({
  draft,
  settings,
  saved,
  result,
  models,
  modelLabels,
  availableReasoningEfforts,
  channelBusy,
  onPatch,
  onPatchModel,
  onReveal,
  onTest,
  onClearError,
  errors = {},
}: ChannelEditorProps) {
  const showSavedMask = !draft.key_loaded && !draft.key_touched && draft.key_masked !== ''
  const canRevealOrToggle = draft.key_loaded || Boolean(saved?.key_stored || draft.key_masked)
  const keyValue = showSavedMask ? draft.key_masked : draft.api_key
  const keyType = draft.key_visible ? 'text' : 'password'
  const channelIsBusy = Boolean(channelBusy?.models || channelBusy?.test || channelBusy?.reveal)
  const modelsBusy = Boolean(channelBusy?.models)
  const testBusy = Boolean(channelBusy?.test)
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
        <GlassCombobox
          data-testid={`vk-channel-model-${draft.id}`}
          aria-label="模型 ID"
          className={fieldClass}
          style={{ ...fieldStyle, flex: 1, minWidth: 0 }}
          options={models.map((model) => ({ value: model, label: getModelLabel(model, modelLabels) }))}
          placeholder="模型名称，例如 gpt-5.6-luna，可直接输入"
          value={draft.model_id}
          onChange={(value) => { onPatchModel(draft, value); onClearError?.('model_id') }}
        />
        <ActionIconButton
          testId={`vk-channel-models-fetch-${draft.id}`}
          label="获取模型列表"
          onClick={() => onTest(draft, false)}
          disabled={modelsBusy}
          iconState="download"
          size="md"
        >
          <MorphActionGlyph icon={MorphDownload} size={15} className={modelsBusy ? 'vk-provider-icon--busy' : ''} />
        </ActionIconButton>
      </div>)}

      <div className={`vk-validation-field vk-key-field ${errors.api_key ? 'is-error' : ''}`}>
        <div className="mb-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}>API key</div>
        <div className="vk-key-control-row">
          <input
            data-testid={`vk-channel-key-${draft.id}`}
            type={keyType}
            readOnly={showSavedMask}
            autoComplete="off"
            className={`${fieldClass} vk-key-input`}
            style={{ ...fieldStyle, color: showSavedMask ? 'var(--color-fg-dim)' : 'var(--color-fg)' }}
            placeholder="粘贴 API key"
            value={keyValue}
            onFocus={() => {
              onClearError?.('api_key')
              if (showSavedMask) onReveal(draft)
              else if (draft.key_loaded && !draft.key_visible) onPatch(draft.id, { key_visible: true })
            }}
            onChange={(e) => {
              onPatch(draft.id, {
                api_key: e.target.value,
                key_touched: true,
                key_loaded: true,
                key_visible: true,
              })
              onClearError?.('api_key')
            }}
          />
          <VisibilityButton
            testId={`vk-channel-reveal-${draft.id}`}
            visible={draft.key_loaded && draft.key_visible}
            onClick={() => {
              if (draft.key_loaded) onPatch(draft.id, { key_visible: !draft.key_visible })
              else onReveal(draft)
            }}
            disabled={channelIsBusy || !canRevealOrToggle}
          />
        </div>
        {errors.api_key && <div className="vk-validation-message" role="alert">{errors.api_key}</div>}
      </div>

      <div className="vk-provider-protocol-row" data-testid={`vk-channel-protocol-row-${draft.id}`}>
        {field('api_style', '接口协议', <GlassSelect
          data-testid={`vk-channel-style-${draft.id}`}
          aria-label="接口协议"
          className="vk-provider-protocol-control rounded-lg px-2 py-1.5 text-xs outline-none"
          style={fieldStyle}
          value={draft.api_style}
          onChange={(value) => { onPatch(draft.id, { api_style: value, api_style_touched: true }); onClearError?.('api_style') }}
          options={settings.api_styles.map((style) => ({ value: style.id, label: style.label }))}
        />)}
        <div className={`vk-validation-field ${errors.reasoning_effort ? 'is-error' : ''}`}>
          <div className="mb-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}>推理强度</div>
          <GlassCombobox
            data-testid={`vk-channel-reasoning-${draft.id}`}
            aria-label="推理强度"
            className="vk-provider-protocol-control rounded-lg px-2 py-1.5 text-xs outline-none"
            style={fieldStyle}
            value={draft.reasoning_effort}
            disabled={testBusy}
            placeholder="默认 medium"
            title={availableReasoningEfforts.length ? '默认 medium；下拉建议来自本次接口请求，也可以输入接口支持的其他值' : '默认 medium，也可输入中转站支持的值'}
            onChange={(value) => { onPatch(draft.id, { reasoning_effort: value }); onClearError?.('reasoning_effort') }}
            options={availableReasoningEfforts.map((effort) => ({ value: effort, label: effort }))}
          />
          {errors.reasoning_effort && <div className="vk-validation-message" role="alert">{errors.reasoning_effort}</div>}
        </div>
        <div className="vk-provider-protocol-action">
          <ActionIconButton
            testId={`vk-channel-test-${draft.id}`}
            label="测试连接"
            onClick={() => onTest(draft, true)}
            disabled={testBusy}
            iconState="activity"
            size="md"
          >
            <MorphActionGlyph icon={MorphActivity} size={15} className={testBusy ? 'vk-provider-icon--busy' : ''} />
          </ActionIconButton>
        </div>
        {saved?.key_from_environment && (
          <span className="vk-provider-protocol-note text-xs" style={{ color: 'var(--color-fg-dim)' }} title="环境变量里的 key 会覆盖这里填的,要改得去环境变量改">key 来自系统环境变量，优先生效</span>
        )}
      </div>

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
 *  · key 存过就**看得见存在**(打码值),点击输入框或「显示」才取明文——不碰就不提交。
 *    明文只活在组件状态里。
 *  · 接口风格按模型名先填上,用户改过就不再覆盖。
 *  · 失败给根因 + 下一步;能自动修的当场修**并把改了什么写出来**。
 */
export function VkProviderForm({ baseUrl, onSaved }: { baseUrl?: string; onSaved?: () => void }) {
  const [settings, setSettings] = useState<VkProviderSettings | null>(null)
  const [jevConfigs, setJevConfigs] = useState<VkJevConfig[]>([])
  const [jevActiveId, setJevActiveId] = useState<string | null>(null)
  const [jevName, setJevName] = useState('')
  const [jevEditingId, setJevEditingId] = useState<string | null>(null)
  const [jevModalOpen, setJevModalOpen] = useState(false)
  const [jevKey, setJevKey] = useState('')
  const [jevKeyMasked, setJevKeyMasked] = useState('')
  const [jevKeyTouched, setJevKeyTouched] = useState(false)
  const [jevKeyVisible, setJevKeyVisible] = useState(false)
  const [jevBusy, setJevBusy] = useState(false)
  const [jevTesting, setJevTesting] = useState<Record<string, boolean>>({})
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [roles, setRoles] = useState<Record<string, string>>({})
  const [roleFallbacks, setRoleFallbacks] = useState<Record<string, string[]>>({})
  const [roleCompositeEnabled, setRoleCompositeEnabled] = useState<Record<string, boolean>>({})
  const [results, setResults] = useState<Record<string, VkProviderTestResult>>({})
  const [models, setModels] = useState<Record<string, string[]>>({})
  const [modelLabels, setModelLabels] = useState<Record<string, Record<string, string>>>({})
  const [reasoningEfforts, setReasoningEfforts] = useState<Record<string, Record<string, string[]>>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [channelBusy, setChannelBusy] = useState<Record<string, ChannelBusyState>>({})
  const [modalSession, setModalSession] = useState<{ id: string; original: Draft | null } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Draft | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const deleteDialogRef = useRef<HTMLDialogElement>(null)
  const deleteCancelRef = useRef<HTMLButtonElement>(null)
  const [saving, setSaving] = useState(false)
  const [ccSwitchPickerOpen, setCcSwitchPickerOpen] = useState(false)
  const [error, setError] = useState<ScopedError | null>(null)
  const [notices, setNotices] = useState<Notice[]>([])
  const [validationErrors, setValidationErrors] = useState<Record<string, Partial<Record<'name' | 'base_url' | 'model_id' | 'api_key' | 'api_style' | 'reasoning_effort', string>>>>({})
  const selectionGuard = useRef(false)
  const savingRef = useRef(false)
  const routeSaveRunning = useRef(false)
  const pendingRouteSnapshot = useRef<RouteSnapshot | null>(null)
  const noticeSeq = useRef(0)
  const settingsLoaded = useRef(false)
  const runtimeSyncRef = useRef<Promise<boolean> | null>(null)
  const ccSwitchPickerRef = useRef<HTMLDivElement>(null)
  const ccSwitchPickerMenuRef = useRef<HTMLDivElement>(null)
  const [ccSwitchPickerPosition, setCcSwitchPickerPosition] = useState({ top: 0, left: 0, width: 224, maxHeight: 320 })
  const modalId = modalSession?.id ?? null
  useDismissOnOutside(ccSwitchPickerRef, ccSwitchPickerOpen, () => setCcSwitchPickerOpen(false), ccSwitchPickerMenuRef)
  useGlassMenuSurface(ccSwitchPickerMenuRef, ccSwitchPickerOpen)
  useLayoutEffect(() => {
    if (!ccSwitchPickerOpen || !ccSwitchPickerRef.current || !ccSwitchPickerMenuRef.current) return
    const anchor = ccSwitchPickerRef.current.getBoundingClientRect()
    const menuHeight = ccSwitchPickerMenuRef.current.getBoundingClientRect().height
    const margin = 8
    const width = Math.min(224, window.innerWidth - margin * 2)
    const below = window.innerHeight - anchor.bottom - margin - 6
    const above = anchor.top - margin - 6
    const openAbove = below < Math.min(menuHeight, 200) && above > below
    setCcSwitchPickerPosition({
      top: openAbove ? Math.max(margin, anchor.top - menuHeight - 6) : anchor.bottom + 6,
      left: Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin)),
      width,
      maxHeight: Math.max(96, openAbove ? above : below),
    })
  }, [ccSwitchPickerOpen])
  useEffect(() => {
    if (!ccSwitchPickerOpen) return
    const close = () => setCcSwitchPickerOpen(false)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [ccSwitchPickerOpen])

  useEffect(() => {
    if (!pendingDelete) return
    deleteDialogRef.current?.showModal()
    deleteCancelRef.current?.focus()
  }, [pendingDelete])

  const showNotice = useCallback((tone: Notice['tone'], message: string, location: AlertLocation, dismissible = false) => {
    const notice = { id: ++noticeSeq.current, tone, message, location, dismissible }
    setNotices((current) => [notice, ...current])
  }, [])

  const syncLegacyRuntime = useCallback(() => {
    if (runtimeSyncRef.current) return runtimeSyncRef.current
    const task = (async () => {
      const status = await fetchVkRuntimeStatus(baseUrl)
      if (status.state !== 'installed' || status.current !== false) return false
      showNotice('error', '解析引擎版本过旧，正在更新，请稍后重试', 'form', true)
      await postVkRuntimeInstall(baseUrl, { rebuild: false })
      return true
    })().finally(() => { runtimeSyncRef.current = null })
    runtimeSyncRef.current = task
    return task
  }, [baseUrl, showNotice])

  const load = useCallback(async () => {
    try {
      const loaded = await fetchVkProviderSettings(baseUrl)
      settingsLoaded.current = true
      setSettings(loaded)
      setDrafts(loaded.channels.map(toDraft))
      setRoles({ ...loaded.role_assignments })
      setRoleFallbacks(Object.fromEntries(
        Object.entries(loaded.role_fallbacks ?? {}).map(([role, ids]) => [role, [...ids]]),
      ))
      setRoleCompositeEnabled(Object.fromEntries(
        Object.keys(loaded.role_labels).map((role) => [
          role,
          loaded.role_composite_enabled?.[role] ?? Boolean(loaded.role_fallbacks?.[role]?.length),
        ]),
      ))
    } catch (err) {
      const message = err instanceof Error ? err.message : '模型配置读取失败'
      if (settingsLoaded.current) showNotice('error', message, 'form', true)
      else setError({ message, location: 'form' })
    }
  }, [baseUrl, showNotice])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    void fetchVkJevConfigs(baseUrl)
      .then((value) => { const normalized = normalizeJevConfigsResult(value); setJevConfigs(Array.isArray(normalized.configs) ? normalized.configs : []); setJevActiveId(normalized.active_id ?? null) })
      .catch(async (err) => {
        if (!isJevNotFound(err)) return
        try {
          await syncLegacyRuntime()
        } catch (runtimeError) {
          showNotice('error', `解析引擎更新失败：${runtimeError instanceof Error ? runtimeError.message : '未知错误'}`, 'form', true)
        }
      })
  }, [baseUrl, showNotice, syncLegacyRuntime])

  const reloadJevConfigs = async () => {
    const value = await fetchVkJevConfigs(baseUrl)
    const normalized = normalizeJevConfigsResult(value)
    setJevConfigs(Array.isArray(normalized.configs) ? normalized.configs : []); setJevActiveId(normalized.active_id ?? null)
  }

  const saveJev = async () => {
    setJevBusy(true)
    try {
      const requestedName = jevName.trim() || `Jev ${jevConfigs.length + 1}`
      let usedLegacyFallback = false
      let result: { configured: boolean; configs: VkJevConfig[]; active_id: string | null }
      try { result = await saveVkJevConfigItem(requestedName, jevKeyTouched ? jevKey.trim() : '', jevEditingId ?? undefined, baseUrl) }
      catch (err) {
        if (!isJevNotFound(err)) throw err
        usedLegacyFallback = true
        try { if (await syncLegacyRuntime()) return } catch (runtimeError) { showNotice('error', `解析引擎更新失败：${runtimeError instanceof Error ? runtimeError.message : '未知错误'}`, 'form', true); return }
        const legacy = await saveVkJevConfig(jevKeyTouched ? jevKey.trim() : '', baseUrl)
        result = { ...legacy, configs: jevConfigs, active_id: jevActiveId }
      }
      const normalized = normalizeJevConfigsResult(result)
      let configs = Array.isArray(normalized.configs) ? normalized.configs : []
      let activeId = normalized.active_id ?? null
      const hasSavedItem = configs.length > 0 && (jevEditingId
        ? configs.some((item) => item.id === jevEditingId)
        : configs.some((item) => item.name === requestedName))
      if (!usedLegacyFallback && !hasSavedItem) {
        const refreshed = normalizeJevConfigsResult(await fetchVkJevConfigs(baseUrl))
        configs = Array.isArray(refreshed.configs) ? refreshed.configs : []
        activeId = refreshed.active_id ?? null
      }
      setJevConfigs(configs); setJevActiveId(activeId)
      setJevKey('')
      setJevName(''); setJevEditingId(null); setJevModalOpen(false)
      showNotice('success', result.configured ? 'Jev Key 已安全保存' : 'Jev Key 已清除', 'form')
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Jev Key 保存失败', 'form', true)
    } finally { setJevBusy(false) }
  }

  const enableJev = async (id: string) => { setJevBusy(true); try { const result = normalizeJevConfigsResult(await enableVkJevConfig(id, baseUrl)); setJevConfigs(result.configs ?? []); setJevActiveId(result.active_id ?? null) } catch (err) { showNotice('error', err instanceof Error ? err.message : 'Jev 启用失败', 'form', true) } finally { setJevBusy(false) } }
  const removeJev = async (id: string) => { setJevBusy(true); try { const result = normalizeJevConfigsResult(await deleteVkJevConfig(id, baseUrl)); setJevConfigs(result.configs ?? []); setJevActiveId(result.active_id ?? null) } catch (err) { showNotice('error', err instanceof Error ? err.message : 'Jev 删除失败', 'form', true) } finally { setJevBusy(false) } }
  const testJevItem = async (id: string) => {
    if (jevTesting[id]) return
    setJevTesting((current) => ({ ...current, [id]: true }))
    try {
      const result = await testVkJevConfig(id, baseUrl)
      showNotice(result.ok ? 'success' : 'error', result.message, 'form', !result.ok)
      await reloadJevConfigs()
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Jev 测试失败', 'form', true)
    } finally {
      setJevTesting((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
    }
  }
  const openNewJev = () => { setJevEditingId(null); setJevName(`Jev ${jevConfigs.length + 1}`); setJevKey(''); setJevKeyMasked(''); setJevKeyTouched(false); setJevKeyVisible(false); setJevModalOpen(true) }
  const openEditJev = (item: VkJevConfig) => { setJevEditingId(item.id); setJevName(item.name); setJevKey(''); setJevKeyMasked(item.masked_key); setJevKeyTouched(false); setJevKeyVisible(false); setJevModalOpen(true) }

  const patch = (id: string, next: Partial<Draft>) =>
    setDrafts((list) => list.map((d) => (d.id === id ? { ...d, ...next } : d)))

  /** 改模型名时顺手把风格填对 —— 除非用户自己选过。 */
  const patchModel = (draft: Draft, model_id: string) =>
    patch(draft.id, {
      model_id,
      ...(model_id === draft.model_id || draft.reasoning_effort.trim()
        ? {}
        : { reasoning_effort: 'medium' }),
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
    setNotices((current) => current.filter((notice) => notice.location !== 'modal'))
    if (!commit) {
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
    if (!error) return
    const timer = window.setTimeout(() => {
      setError((current) => current === error ? null : current)
    }, NOTICE_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [error])

  const addChannel = () => {
    const id = newId()
    const draft: Draft = {
      id, name: '新配置', base_url: '', model_id: '',
      key_env: `VK_CHANNEL_${id.toUpperCase()}_KEY`, api_style: 'openai_completions',
      api_style_touched: false, reasoning_effort: 'medium', key_masked: '', extra_headers: {},
      api_key: '', key_touched: false, key_loaded: true, key_visible: false, enabled: true,
    }
    openNewDraft(draft)
  }

  const importChannel = (item: VkProviderSettings['importable'][number]) => {
    const imported: Draft = {
      id: item.id, name: item.name, base_url: item.base_url, model_id: item.model_id,
      key_env: item.key_env, api_style: inferApiStyle(item.model_id), api_style_touched: false,
      reasoning_effort: 'medium', key_masked: '', extra_headers: {}, api_key: '', key_touched: false,
      key_loaded: false, key_visible: false, enabled: true,
    }
    const current = drafts.find((draft) => draft.id === item.id)
    if (current) openEditor(current)
    else openNewDraft(imported)
  }

  /** 从 cc-switch 导一条:地址、模型、接口风格、请求头、key 一次到位。 */
  const importFromCcSwitch = async (candidate: VkProviderSettings['cc_switch']['candidates'][number]) => {
    setCcSwitchPickerOpen(false)
    setBusy(`ccswitch:${candidate.ref}`)
    try {
      const { channel, api_key } = await importVkCcSwitchChannel(
        candidate.ref, drafts.map((d) => d.id), baseUrl,
      )
      const imported: Draft = {
        id: channel.id, name: channel.name, base_url: channel.base_url,
        model_id: channel.model_id, key_env: channel.key_env, api_style: channel.api_style,
        api_style_touched: true, reasoning_effort: 'medium', key_masked: '', extra_headers: channel.extra_headers,
        api_key, key_touched: true, key_loaded: true, key_visible: false, enabled: true,
      }
      openNewDraft(imported)
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : '从 cc-switch 导入失败', 'form', true)
    } finally {
      setBusy(null)
    }
  }

  const channelPayload = (items: Draft[]): VkChannelPayload[] => items.map((draft) => ({
    id: draft.id, name: draft.name, base_url: draft.base_url, model_id: draft.model_id,
    key_env: draft.key_env, api_style: draft.api_style,
    reasoning_effort: draft.reasoning_effort.trim() || 'medium',
    extra_headers: draft.extra_headers,
    enabled: draft.enabled,
    // 没碰过就不传 api_key —— 表示「不动已存的那把」,而不是清空。
    ...(draft.key_touched ? { api_key: draft.api_key } : {}),
  }))

  const persist = async (
    nextDrafts: Draft[],
    nextRoles: Record<string, string>,
    nextRoleFallbacks: Record<string, string[]>,
    nextRoleCompositeEnabled = roleCompositeEnabled,
    withNotice = false,
    errorLocation: AlertLocation | null = 'form',
  ): Promise<PersistResult> => {
    if (savingRef.current) return { ok: false }
    savingRef.current = true
    setSaving(true)
    try {
      const result = await saveVkProviderSettings({
        channels: channelPayload(nextDrafts), roles: nextRoles, role_fallbacks: nextRoleFallbacks,
        role_composite_enabled: nextRoleCompositeEnabled,
      }, baseUrl)
      let noticeMessage: string | undefined
      if (withNotice) {
        noticeMessage = [
          '已保存并立即生效',
          ...result.normalization_notes,
          result.keys_written.length ? `已安全保存 ${result.keys_written.length} 把 key` : '',
        ].filter(Boolean).join('；')
        if (errorLocation === 'form') showNotice('success', noticeMessage, 'form')
      }
      // 角色选择、启停和备用顺序采用乐观更新。服务端保存响应不含完整
      // settings，立即重新读取会把尚未刷新的旧快照覆盖回页面。弹窗保存仍回读，
      // 以接收服务端的规范化结果。
      if (withNotice) await load()
      onSaved?.()
      return { ok: true, noticeMessage }
    } catch (err) {
      const message = err instanceof Error ? err.message : '模型配置保存失败'
      if (errorLocation !== null) showNotice('error', message, errorLocation, true)
      void load()
      return { ok: false, error: message }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const save = (errorLocation: AlertLocation) => persist(drafts, roles, roleFallbacks, roleCompositeEnabled, true, errorLocation)

  const queueRouteSave = (snapshot: RouteSnapshot) => {
    pendingRouteSnapshot.current = snapshot
    if (routeSaveRunning.current) return
    routeSaveRunning.current = true
    void (async () => {
      try {
        while (pendingRouteSnapshot.current) {
          const next = pendingRouteSnapshot.current
          pendingRouteSnapshot.current = null
          await saveVkProviderSettings({
            channels: channelPayload(next.drafts), roles: next.roles,
            role_fallbacks: next.roleFallbacks,
            role_composite_enabled: next.roleCompositeEnabled,
          }, baseUrl)
        }
        onSaved?.()
      } catch (err) {
        pendingRouteSnapshot.current = null
        showNotice('error', err instanceof Error ? err.message : '模型配置保存失败', 'form', true)
        await load()
      } finally {
        routeSaveRunning.current = false
        if (pendingRouteSnapshot.current) queueRouteSave(pendingRouteSnapshot.current)
      }
    })()
  }

  const applyRoute = (role: string, route: string[], composite = roleCompositeEnabled) => {
    const nextRoles = { ...roles }
    const nextFallbacks = { ...roleFallbacks }
    if (route.length) nextRoles[role] = route[0]
    else delete nextRoles[role]
    nextFallbacks[role] = route.slice(1)
    setRoles(nextRoles)
    setRoleFallbacks(nextFallbacks)
    queueRouteSave({ drafts, roles: nextRoles, roleFallbacks: nextFallbacks, roleCompositeEnabled: composite })
  }

  const removeChannel = async (id: string) => {
    if (savingRef.current) return
    setDeleteError(null)
    const nextDrafts = drafts.filter((draft) => draft.id !== id)
    const nextRoles = { ...roles }
    const nextRoleFallbacks = { ...roleFallbacks }
    for (const role of ROUTING_ROLES) {
      const route = [roles[role], ...(roleFallbacks[role] ?? [])].filter((item): item is string => Boolean(item) && item !== id)
      if (route.length) nextRoles[role] = route[0]
      else delete nextRoles[role]
      nextRoleFallbacks[role] = route.slice(1)
    }
    const result = await persist(nextDrafts, nextRoles, nextRoleFallbacks, roleCompositeEnabled, false, null)
    if (!result.ok) {
      setDeleteError(result.error ?? '模型配置保存失败')
      return
    }
    setDrafts(nextDrafts)
    setModalSession((current) => current?.id === id ? null : current)
    setRoles(nextRoles)
    setRoleFallbacks(nextRoleFallbacks)
    deleteDialogRef.current?.close()
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
      key_loaded: draft.key_touched && draft.key_loaded,
      key_visible: false,
    }
    openNewDraft(reused)
  }

  const setChannelEnabled = (id: string, enabled: boolean) => {
    const nextDrafts = drafts.map((draft) => draft.id === id ? { ...draft, enabled } : draft)
    const nextRoles = { ...roles }
    const nextRoleFallbacks = { ...roleFallbacks }
    if (!enabled) for (const role of ROUTING_ROLES) {
      const route = [roles[role], ...(roleFallbacks[role] ?? [])].filter((item): item is string => Boolean(item) && item !== id)
      if (route.length) nextRoles[role] = route[0]
      else delete nextRoles[role]
      nextRoleFallbacks[role] = route.slice(1)
    }
    setDrafts(nextDrafts)
    setRoles(nextRoles)
    setRoleFallbacks(nextRoleFallbacks)
    queueRouteSave({ drafts: nextDrafts, roles: nextRoles, roleFallbacks: nextRoleFallbacks, roleCompositeEnabled })
  }

  const setRole = (role: string, value: string) => {
    if (!value) { applyRoute(role, []); return }
    const previous = [roles[role], ...(roleFallbacks[role] ?? [])].filter(Boolean) as string[]
    applyRoute(role, [value, ...previous.slice(1).filter((item) => item !== value)])
  }

  const setCompositeEnabled = (role: string, enabled: boolean) => {
    const next = { ...roleCompositeEnabled, [role]: enabled }
    setRoleCompositeEnabled(next)
    queueRouteSave({ drafts, roles, roleFallbacks, roleCompositeEnabled: next })
  }

  const reveal = async (draft: Draft) => {
    const location: AlertLocation = modalId === draft.id ? 'modal' : 'form'
    setChannelBusy((current) => ({ ...current, [draft.id]: { ...current[draft.id], reveal: true } }))
    try {
      const result = await revealVkProviderKey(draft.key_env, baseUrl)
      patch(draft.id, {
        api_key: result.found ? (result.api_key ?? '') : '',
        key_loaded: true,
        key_visible: true,
        key_touched: false,
      })
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : '读取 key 失败', location, true)
    } finally {
      setChannelBusy((current) => {
        const next = { ...current }
        const state = { ...next[draft.id], reveal: false }
        if (state.models || state.test) next[draft.id] = state
        else delete next[draft.id]
        return next
      })
    }
  }

  const runTest = async (draft: Draft, probeGeneration = true) => {
    const location: AlertLocation = modalId === draft.id ? 'modal' : 'form'
    const operation: 'models' | 'test' = probeGeneration ? 'test' : 'models'
    setChannelBusy((current) => ({
      ...current,
      [draft.id]: { ...current[draft.id], [operation]: true },
    }))
    try {
      const startedAt = performance.now()
      const result = await testVkProvider({
        base_url: draft.base_url,
        key_env: draft.key_env,
        api_style: draft.api_style,
        probe_generation: probeGeneration,
        ...(probeGeneration ? {
          model_id: draft.model_id,
          reasoning_effort: draft.reasoning_effort.trim() || 'medium',
          extra_headers: draft.extra_headers,
        } : {}),
        ...(draft.key_touched ? { api_key: draft.api_key } : {}),
      }, baseUrl)
      const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt))
      setResults((prev) => ({ ...prev, [draft.id]: result }))
      const probe = result.generation_probe
      const successNotice = !probeGeneration
        ? `获取到 ${(result.models ?? []).length} 个模型`
        : !probe
          ? `连接成功 · ${elapsedMs} ms`
        : probe?.first_text_ms != null
          ? `连接成功 · 首字 ${probe.first_text_ms} ms · 总耗时 ${probe.total_ms} ms`
          : probe?.ok
            ? `连接成功 · 同步 · 总耗时 ${probe.total_ms} ms`
            : result.message
      showNotice(result.ok ? 'success' : 'error', result.ok ? successNotice : formatTestNotice(result), location)
      // 后端规整过的地址直接回填 —— 看不见的自动修等于没修。
      if (result.base_url && result.base_url !== draft.base_url) patch(draft.id, { base_url: result.base_url })
      if (!probeGeneration) {
        // Discovery owns the model menu. A generation probe must not replace or
        // clear the list that the separate discovery action just produced.
        setModels((prev) => ({ ...prev, [draft.id]: result.models ?? [] }))
        setModelLabels((prev) => ({ ...prev, [draft.id]: result.model_labels ?? {} }))
        setReasoningEfforts((prev) => ({
          ...prev,
          [draft.id]: result.reasoning_efforts ?? {},
        }))
      }
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : '连接测试失败', location)
    } finally {
      setChannelBusy((current) => {
        const next = { ...current }
        const state = { ...next[draft.id], [operation]: false }
        if (state.models || state.test || state.reveal) next[draft.id] = state
        else delete next[draft.id]
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
    const result = await save('modal')
    if (result.ok) {
      closeModal(true)
      if (result.noticeMessage) showNotice('success', result.noticeMessage, 'form')
    }
  }

  if (!settings) {
    return <div data-testid="vk-provider-form" className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>
      {error?.message ?? '读取中…'}
    </div>
  }

  const roleKeys = Object.keys(settings.role_labels)
  const alertSlot = (location: AlertLocation) => {
    const scopedNotices = notices.filter((notice) => notice.location === location)
    if (!scopedNotices.length) return null
    const alerts = (
      <div className={`vk-provider-alert-slot vk-provider-alert-slot--${location}`}>
        <AppNotificationStack onOverflow={location === 'form' ? (count) => setNotices((current) => {
          const scoped = current.filter((notice) => notice.location === 'form')
          const remove = new Set(scoped.slice(Math.max(1, scoped.length - count)).map((notice) => notice.id))
          return current.filter((notice) => !remove.has(notice.id))
        }) : undefined}>
          {scopedNotices.map((scopedNotice) => (
            <AppAlert
              key={scopedNotice.id}
              testId={scopedNotice.dismissible ? 'vk-provider-error' : 'vk-provider-notice'}
              tone={scopedNotice.tone}
              title={scopedNotice.message}
              role={scopedNotice.dismissible ? 'alert' : 'status'}
              className={`vk-provider-alert vk-provider-alert--${scopedNotice.tone}`}
              durationMs={NOTICE_DURATION_MS}
              onExpire={() => setNotices((current) => current.filter((notice) => notice.id !== scopedNotice.id))}
              onClose={scopedNotice.dismissible
                ? () => setNotices((current) => current.filter((notice) => notice.id !== scopedNotice.id))
                : undefined}
              progressTestId={scopedNotice.dismissible ? undefined : 'vk-provider-notice-progress'}
            />
          ))}
        </AppNotificationStack>
      </div>
    )
    return location === 'form'
      ? <AppNotificationPortal>{alerts}</AppNotificationPortal>
      : alerts
  }

  return (
    <div data-testid="vk-provider-form" className="space-y-4">
      {alertSlot('form')}
      <section data-testid="vk-jev-settings" className="rounded-xl p-4" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
        <div className="mb-3 flex items-center justify-between gap-3"><div className="text-sm font-medium">Jev配置</div><ActionIconButton testId="vk-jev-add" label="新增配置" onClick={openNewJev} disabled={jevBusy} appearance="primary" size="md"><MorphActionGlyph icon={MorphPlus} size={16} /></ActionIconButton></div>
        <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--color-line)' }}>
          <div className="grid min-w-[48rem] grid-cols-[1fr_1.3fr_.8fr_1fr_minmax(16rem,auto)] gap-3 px-3 py-2 text-xs font-medium" style={{ color: 'var(--color-fg-dim)', borderBottom: '1px solid var(--color-line)' }}><span>名称</span><span>API Key</span><span>模型</span><span>累计消费估算</span><span className="text-right pr-2">操作</span></div>
          {jevConfigs.length === 0 && <div className="px-3 py-6 text-center text-sm" style={{ color: 'var(--color-fg-dim)' }}>暂无 Jev 配置</div>}
          {jevConfigs.map((item) => { const testing = Boolean(jevTesting[item.id]); const active = jevActiveId ? item.id === jevActiveId : item.enabled === true; return <div key={item.id} data-testid={`vk-jev-config-${item.id}`} className="grid min-w-[48rem] grid-cols-[1fr_1.3fr_.8fr_1fr_minmax(16rem,auto)] items-center gap-3 px-3 py-3" style={{ background: active ? 'color-mix(in srgb, var(--color-accent) 10%, var(--color-canvas))' : 'var(--color-canvas)', borderBottom: '1px solid var(--color-line)' }}><div><div className="text-sm font-medium">{item.name}</div>{active && <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--color-fg-dim)' }}><span data-testid={`vk-jev-status-light-${item.id}`} className="inline-block h-2 w-2 rounded-full" style={{ background: '#22c55e' }} aria-hidden="true" />使用中</div>}</div><span className="text-sm">{item.masked_key}</span><span className="text-sm">jev-latest</span><div className="text-sm">${(item.estimated_cost_usd ?? 0).toFixed(6)}<div className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>{(item.input_tokens ?? 0).toLocaleString()} 输入 Token</div>{item.last_used_at && <div className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>{`最近使用 ${new Date(item.last_used_at).toLocaleString()}`}</div>}</div><div className="flex justify-end gap-2"><EnableActionButton testId={`vk-jev-enable-${item.id}`} enabled={active} onClick={() => void enableJev(item.id)} disabled={jevBusy || testing || active} mutedWhenDisabled /><ActionIconButton testId={`vk-jev-test-${item.id}`} label="测试连接" onClick={() => void testJevItem(item.id)} disabled={jevBusy || testing} iconState="activity"><MorphActionGlyph icon={MorphActivity} size={14} className={testing ? 'vk-provider-icon--busy' : ''} /></ActionIconButton><EditActionButton testId={`vk-jev-edit-${item.id}`} onClick={() => openEditJev(item)} disabled={jevBusy || testing} /><DeleteActionButton testId={`vk-jev-delete-${item.id}`} onClick={() => void removeJev(item.id)} disabled={jevBusy || testing} /></div></div> })}
        </div>
      </section>
      {jevModalOpen && <div className="vk-provider-modal-backdrop" data-testid="vk-jev-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !jevBusy) setJevModalOpen(false) }}><div className="vk-provider-modal-shell"><div role="dialog" aria-modal="true" aria-labelledby="vk-jev-modal-title" data-testid="vk-jev-modal" className="vk-provider-modal"><h3 id="vk-jev-modal-title" className="text-lg font-semibold">{jevEditingId ? '编辑 Jev 配置' : '新增 Jev 配置'}</h3><div className="mt-4 space-y-3"><label className="block text-xs" style={{ color: 'var(--color-fg-dim)' }}>配置名称<input aria-label="Jev 配置名称" value={jevName} onChange={(event) => setJevName(event.target.value)} placeholder="配置名称" className={`${fieldClass} mt-1`} style={fieldStyle} /></label><label className="block text-xs" style={{ color: 'var(--color-fg-dim)' }}>API Key<div className="vk-key-control-row mt-1"><input data-testid="vk-jev-key" type={jevKeyVisible ? 'text' : 'password'} value={jevKeyTouched ? jevKey : jevKeyMasked} onChange={(event) => { setJevKey(event.target.value); setJevKeyTouched(true) }} placeholder={jevEditingId ? '留空以保留当前 Key；输入新 Key 可替换' : '粘贴 Jev Key'} className={`${fieldClass} vk-key-input`} style={fieldStyle} /><VisibilityButton testId="vk-jev-reveal" visible={jevKeyVisible} disabled={jevBusy || (!jevKeyTouched && !jevKeyMasked)} onClick={() => setJevKeyVisible((value) => !value)} /></div></label></div><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => { if (!jevBusy) { setJevModalOpen(false); setJevName(''); setJevKey(''); setJevKeyMasked(''); setJevKeyTouched(false); setJevKeyVisible(false); setJevEditingId(null) } }} className={outlineButton} style={outlineStyle}>取消</button><button type="button" onClick={() => void saveJev()} disabled={jevBusy || !jevName.trim() || (!jevEditingId && !jevKeyTouched && !jevKey.trim())} className={outlineButton} style={outlineStyle}>保存</button></div></div></div></div>}
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
              {ccSwitchPickerOpen && createPortal(
                <div ref={ccSwitchPickerMenuRef} data-testid="vk-ccswitch-picker" role="menu" className="glass-menu-effect fixed z-20 overflow-auto rounded-lg p-1" style={ccSwitchPickerPosition}>
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
                </div>,
                document.body,
              )}
            </div>
          )}
          <ActionIconButton
            testId="vk-channel-add"
            label="创建配置"
            onClick={addChannel}
            disabled={busy !== null || saving}
            appearance="primary"
            size="md"
          >
            <MorphActionGlyph icon={MorphPlus} size={16} />
          </ActionIconButton>
        </div>
      </div>

      {/* —— 通道清单 —— */}
      <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--color-line)' }}>
        <div
          className="grid min-w-[56rem] grid-cols-[1fr_1.35fr_1fr_.7fr_minmax(22rem,auto)] gap-3 px-3 py-2 text-xs font-medium"
          style={{ color: 'var(--color-fg-dim)', borderBottom: '1px solid var(--color-line)' }}
        >
          <span>名称</span><span>API key / 上游</span><span>模型</span><span>状态</span><span className="text-right pr-2">操作</span>
        </div>
        <div className="divide-y" style={{ borderColor: 'var(--color-line)' }}>
          {drafts.length === 0 && (
            <div className="px-3 py-8 text-center text-sm" style={{ color: 'var(--color-fg-dim)' }}>暂无模型配置</div>
          )}
          {drafts.map((draft) => {
            const saved = settings.channels.find((channel) => channel.id === draft.id)
            const showSavedMask = !draft.key_touched && draft.key_masked !== ''
            let upstream = draft.base_url || '未填写上游地址'
            try { upstream = draft.base_url ? new URL(draft.base_url).hostname : upstream } catch { /* show the raw draft */ }
            const statusLabel = draft.enabled ? '已启用' : '已禁用'
            const statusColor = draft.enabled ? 'var(--color-success)' : 'var(--color-warning)'
            const configuredModelLabel = draft.model_id
              ? getModelLabel(draft.model_id, modelLabels[draft.id])
            : '未指定模型'
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
                      {showSavedMask ? draft.key_masked : (draft.key_touched && draft.api_key ? '未保存 key' : '未设置 key')}
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
                    <OverflowTooltip
                      text={configuredModelLabel}
                      testId={`vk-channel-model-label-${draft.id}`}
                      labelClassName="text-sm"
                      labelStyle={{ color: 'var(--color-fg)' }}
                    />
                    {draft.model_id && configuredModelLabel !== draft.model_id && (
                      <div className="truncate text-xs" style={{ color: 'var(--color-fg-dim)' }}>{draft.model_id}</div>
                    )}
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
                        label="测试连接"
                        onClick={() => { void runTest(draft, true) }}
                        disabled={Boolean(channelBusy[draft.id]?.test) || saving}
                        iconState="activity"
                      >
                        <MorphActionGlyph icon={MorphActivity} size={15} className={channelBusy[draft.id]?.test ? 'vk-provider-icon--busy' : ''} />
                      </ActionIconButton>
                    )}
                    <EditActionButton testId={`vk-channel-edit-${draft.id}`} onClick={() => openEditor(draft)} disabled={saving} />
                    <DeleteActionButton testId={`vk-channel-remove-${draft.id}`} onClick={() => setPendingDelete(draft)} disabled={saving} />
                    <EnableActionButton testId={`vk-channel-toggle-${draft.id}`} enabled={draft.enabled} onClick={() => setChannelEnabled(draft.id, !draft.enabled)} disabled={saving} />
                  </div>
                </div>

              </div>
            )
          })}
        </div>
      </div>

      </section>

      {pendingDelete && (
        <dialog
          ref={deleteDialogRef}
          className="vk-provider-delete-dialog scroll-fade"
          aria-labelledby="vk-provider-delete-title"
          aria-describedby="vk-provider-delete-description"
          onClick={(event) => {
            if (!savingRef.current && event.target === event.currentTarget) deleteDialogRef.current?.close()
          }}
          onCancel={(event) => { if (savingRef.current) event.preventDefault() }}
          onClose={() => { setPendingDelete(null); setDeleteError(null) }}
        >
          <header className="vk-provider-delete-header">
            <h3 id="vk-provider-delete-title">删除模型配置？</h3>
            <button type="button" aria-label="关闭删除确认" disabled={saving} className="vk-provider-delete-close" onClick={() => deleteDialogRef.current?.close()}>
              <X size={18} aria-hidden="true" />
            </button>
          </header>
          <div id="vk-provider-delete-description" className="vk-provider-delete-description">
            <p>将删除配置「<strong>{pendingDelete.name.trim() || '未命名配置'}</strong>」。</p>
            <p>删除将解除对应的模型选择和备用设置，已有任务和解析结果保留。</p>
          </div>
          {deleteError && <p className="vk-provider-delete-error" role="alert">{deleteError}</p>}
          <footer className="vk-provider-delete-actions">
            <button ref={deleteCancelRef} type="button" disabled={saving} className={outlineButton} style={outlineStyle} onClick={() => deleteDialogRef.current?.close()}>取消</button>
            <button type="button" disabled={saving} className="vk-provider-delete-confirm rounded-lg px-4 py-1.5 text-sm font-medium disabled:opacity-50" onClick={() => { void removeChannel(pendingDelete.id) }}>
              {saving ? '删除中…' : '删除配置'}
            </button>
          </footer>
        </dialog>
      )}

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
            <div data-testid="vk-provider-modal-shell" className="relative max-h-[90vh] w-full max-w-2xl">
              <div data-testid="vk-provider-modal" role="dialog" aria-modal="true" aria-labelledby="vk-provider-modal-title" className="relative max-h-[90vh] w-full overflow-y-auto rounded-xl p-5 shadow-2xl" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-line)' }}>
              {alertSlot('modal')}
              <div className="mb-4 flex items-center justify-between gap-3">
                <h3 id="vk-provider-modal-title" className="text-lg font-semibold">{isNew ? '创建配置' : '编辑配置'}</h3>
                <button type="button" aria-label="关闭模型配置弹窗" title="关闭" onClick={() => closeModal(false)} className="rounded-lg p-1.5" style={outlineStyle}><X size={18} /></button>
              </div>
              <div className="mb-3 grid gap-2 sm:grid-cols-2">
                <div className={`vk-validation-field ${validationErrors[modalDraft.id]?.name ? 'is-error' : ''}`}>
                  <label htmlFor="vk-modal-name-input" className="mb-1 block text-xs" style={{ color: 'var(--color-fg-dim)' }}>名称</label>
                  <input id="vk-modal-name-input" data-testid="vk-modal-name" className={fieldClass} style={fieldStyle} placeholder="例如：日常总结" value={modalDraft.name} onChange={(event) => { patch(modalDraft.id, { name: event.target.value }); setValidationErrors((current) => ({ ...current, [modalDraft.id]: { ...current[modalDraft.id], name: undefined } })) }} />
                  {validationErrors[modalDraft.id]?.name && <div className="vk-validation-message" role="alert">{validationErrors[modalDraft.id].name}</div>}
                </div>
                <div className="vk-validation-field">
                  <label htmlFor="vk-modal-group-input" className="mb-1 block text-xs" style={{ color: 'var(--color-fg-dim)' }}>上游站点</label>
                  <input id="vk-modal-group-input" data-testid="vk-modal-group" className={fieldClass} style={fieldStyle} value={modalDraft.base_url ? (() => { try { return new URL(modalDraft.base_url).hostname } catch { return '' } })() : ''} readOnly placeholder="自动识别上游" />
                </div>
              </div>
              <ChannelEditor
                draft={modalDraft}
                settings={settings}
                saved={modalSaved}
                result={modalResult}
                models={models[modalDraft.id] ?? []}
                modelLabels={modelLabels[modalDraft.id] ?? {}}
                availableReasoningEfforts={modalEfforts}
                channelBusy={channelBusy[modalDraft.id]}
                onPatch={patch}
                onPatchModel={patchModel}
                onReveal={(item) => { void reveal(item) }}
                onTest={(item, probeGeneration) => { void runTest(item, probeGeneration) }}
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
            const route = [primary, ...fallbacks].filter(Boolean)
            const compositeEnabled = roleCompositeEnabled[role] ?? false
            const available = drafts.filter((draft) => draft.enabled)
            const routeWarnings = [...new Set([
              ...(compositeEnabled && route.length === 1
                ? ['至少选择 2 个配置才能形成故障切换']
                : []),
              ...(compositeEnabled && routeHasDuplicateHost(route, drafts)
                ? ['主通道与备用通道实际指向同一服务，故障时可能同时不可用']
                : []),
            ])]
            return (
            <div key={role} data-testid={`vk-role-routing-${role}`} className="rounded-lg p-2" style={{ border: '1px solid var(--color-line)' }}>
              <div className="vk-role-header">
                <span className="w-16 shrink-0 text-sm">{settings.role_labels[role]}</span>
                {compositeEnabled ? <GlassMultiSelect
                  data-testid={`vk-role-${role}`}
                  aria-label={`${settings.role_labels[role]}模型优先级`}
                  className="vk-role-selector text-sm"
                  style={fieldStyle}
                  value={route}
                  disabled={saving}
                  onChange={(value) => applyRoute(role, value)}
                  options={drafts.map((draft) => ({ value: draft.id, label: draft.name, disabled: !draft.enabled }))}
                /> : <GlassSelect
                  data-testid={`vk-role-${role}`}
                  aria-label={`${settings.role_labels[role]}主模型`}
                  className="vk-role-selector text-sm"
                  style={fieldStyle}
                  value={primary}
                  disabled={saving}
                  onChange={(value) => setRole(role, value)}
                  options={[{ value: '', label: '— 还没指定 —' }, ...available.map((draft) => ({ value: draft.id, label: draft.name }))]}
                />}
                <span className="text-xs" style={{ color: 'var(--color-fg-dim)' }}>{settings.role_hints[role]}</span>
                <label className="vk-role-composite-toggle text-xs">
                  <input data-testid={`vk-role-composite-${role}`} type="checkbox" aria-label={`${settings.role_labels[role]}启用复合key`} checked={compositeEnabled} disabled={saving} onChange={(event) => setCompositeEnabled(role, event.target.checked)} />
                  启用复合key
                </label>
              </div>
              <div className="mt-2 space-y-1.5">
                {routeWarnings.map((warning) => (
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
    </div>
  )
}
