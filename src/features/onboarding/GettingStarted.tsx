import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { loadGettingStartedDismissed, saveGettingStartedDismissed } from '../../data/layout'
import {
  extensionPageFailureText,
  fetchBridgeHealth,
  openExtensionPage,
  repairBridge,
  type BridgeHealth,
} from '../../host/bridgeClient'
import {
  fetchVkProviderStatus,
  fetchVkRuntimeStatus,
  isVkRuntimeSettled,
  postVkRuntimeInstall,
  type VkRuntimeStatus,
} from '../../host/vkClient'
import { vkErrorText } from '../vk/vkErrors'
import './GettingStarted.css'

const RUNTIME_POLL_MS = 4000
const FOCUS_REFRESH_DEBOUNCE_MS = 3000
const REPAIR_TIMEOUT_MS = 30_000   // 与连接状态胶囊的修复等待一致:重启 daemon 最长 20s
const OFFLINE_RELEASES_URL = 'https://github.com/jackwener/opencli/releases'

// undefined = 还没问过;null = 问了但没问到(Host 不可达/引擎没准备好)
type Snapshot = {
  bridge: BridgeHealth | null
  runtime: VkRuntimeStatus | null
  configured: boolean | null | undefined
}

type StepStatus = { done: boolean; busy?: boolean; text: string; title?: string }

function bridgeStatus(bridge: BridgeHealth | null): StepStatus {
  if (!bridge) return { done: false, text: '暂时检测不到，点「检测并修复」重试' }
  switch (bridge.reasonCode) {
    case 'ok': return { done: true, text: '已连接' }
    case 'extension-disconnected': return { done: false, text: '还没连上扩展' }
    case 'profile-required': return { done: false, text: '连着多个浏览器 profile，请在左侧栏底部的连接状态里选一个' }
    case 'profile-disconnected': return { done: false, text: '之前选的浏览器 profile 现在没连上' }
    default: return { done: false, text: '浏览器服务没有运行' }
  }
}

function engineStatus(runtime: VkRuntimeStatus | null): StepStatus {
  if (!runtime) return { done: false, text: '暂时读不到解析引擎状态' }
  if (isVkRuntimeSettled(runtime)) return { done: true, text: '已就绪' }
  switch (runtime.state) {
    case 'installing': return { done: false, busy: true, text: '正在准备，首次需要几分钟，可以先去做别的' }
    case 'failed': return { done: false, text: '没准备成功，可以重试', title: [runtime.summary, runtime.reasonCode].filter(Boolean).join(' / ') }
    case 'not-available': return { done: false, text: '安装包里缺少解析引擎，请重新安装爪爪', title: runtime.summary }
    case 'installed': return { done: false, text: '有新版本，更新后才能继续' }
    default: return { done: false, text: '还没准备' }
  }
}

function providerStatus(snapshot: Snapshot): StepStatus & { blocked: boolean } {
  if (!isVkRuntimeSettled(snapshot.runtime)) return { done: false, blocked: true, text: '先完成上一步' }
  if (snapshot.configured === undefined) return { done: false, blocked: false, busy: true, text: '检查中…' }
  if (snapshot.configured === null) return { done: false, blocked: false, text: '暂时读不到模型配置' }
  return snapshot.configured
    ? { done: true, blocked: false, text: '已配置' }
    : { done: false, blocked: false, text: '还没配置模型' }
}

function Step({ index, title, description, status, actions, children, testId }: {
  index: number
  title: string
  description: string
  status: StepStatus | undefined
  actions?: ReactNode
  children?: ReactNode
  testId: string
}) {
  return (
    <li className="getting-started-step" data-testid={testId} data-done={status?.done ? 'true' : 'false'}>
      <span className="getting-started-index" aria-hidden="true">
        {status?.done ? <Check size={14} /> : index}
      </span>
      <div className="getting-started-main">
        <div className="getting-started-title">{title}</div>
        <div className="getting-started-desc">{description}</div>
        <div
          className="getting-started-status"
          data-tone={status?.done ? 'done' : 'todo'}
          title={status?.title}
          role="status"
        >
          {status?.busy && <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />}
          <span>{status?.text ?? '检查中…'}</span>
        </div>
        {children}
      </div>
      {status && actions && <div className="getting-started-actions">{actions}</div>}
    </li>
  )
}

/**
 * 首页「开始使用」清单:浏览器扩展 → 解析引擎 → 模型配置。
 * 三步状态都是现取的,不在前端另存。三步全部完成就自动收起并记住(不再检查);
 * 用户也可以随时点「不再显示」。刷新只发生在进入页面、切回该模块、窗口重获焦点和点完操作之后,
 * 只有引擎安装中才轮询。
 */
export function GettingStarted({ baseUrl }: { baseUrl?: string }) {
  const mode = useAppStore((state) => state.mode)
  const activeModule = useAppStore((state) => state.activeModule)
  const [dismissed, setDismissed] = useState(() => loadGettingStartedDismissed())
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [busy, setBusy] = useState<'repair' | 'extension' | 'engine' | null>(null)
  const [bridgeNote, setBridgeNote] = useState<string | undefined>()
  const [engineNote, setEngineNote] = useState<string | undefined>()
  const generation = useRef(0)
  const lastRefreshAt = useRef(0)
  const active = mode === 'connected' && !dismissed && activeModule === 'commands'

  const refresh = useCallback(async () => {
    const current = ++generation.current
    lastRefreshAt.current = Date.now()
    const [bridge, runtime] = await Promise.all([
      fetchBridgeHealth(baseUrl).catch(() => null),
      fetchVkRuntimeStatus(baseUrl).catch(() => null),
    ])
    if (current !== generation.current) return
    const settled = isVkRuntimeSettled(runtime)
    setSnapshot((previous) => ({ bridge, runtime, configured: settled ? previous?.configured : null }))
    if (!settled) return
    // 模型配置的接口由解析引擎提供,引擎没好时问了也是 503,所以放在引擎之后。
    const { configured } = await fetchVkProviderStatus(baseUrl)
    if (current !== generation.current) return
    setSnapshot((previous) => previous && { ...previous, configured })
  }, [baseUrl])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  useEffect(() => {
    if (!active) return undefined
    const onFocus = () => {
      if (document.visibilityState === 'hidden') return
      if (Date.now() - lastRefreshAt.current < FOCUS_REFRESH_DEBOUNCE_MS) return
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [active, refresh])

  const installing = snapshot?.runtime?.state === 'installing'
  useEffect(() => {
    if (!active || !installing) return undefined
    const timer = setInterval(() => {
      void fetchVkRuntimeStatus(baseUrl).then((runtime) => {
        if (runtime.state === 'installing') setSnapshot((previous) => previous && { ...previous, runtime })
        else void refresh()
      }).catch(() => {})
    }, RUNTIME_POLL_MS)
    return () => clearInterval(timer)
  }, [active, installing, baseUrl, refresh])

  const bridge = snapshot ? bridgeStatus(snapshot.bridge) : undefined
  const engine = snapshot ? engineStatus(snapshot.runtime) : undefined
  const providers = snapshot ? providerStatus(snapshot) : undefined
  const allDone = !!bridge?.done && !!engine?.done && !!providers?.done
  useEffect(() => {
    if (!allDone) return
    saveGettingStartedDismissed(true)
    setDismissed(true)
  }, [allDone])

  if (mode !== 'connected' || dismissed) return null

  const dismiss = () => {
    saveGettingStartedDismissed(true)
    setDismissed(true)
  }

  const installExtension = async () => {
    setBusy('extension')
    setBridgeNote(undefined)
    try {
      const result = await openExtensionPage(baseUrl)
      setBridgeNote(result.ok
        ? '已在 Chrome 打开应用店，装好后回到这里，会自动重新检测'
        : extensionPageFailureText(result.reasonCode))
    } catch {
      setBridgeNote('请求没送到，确认爪爪服务在运行后重试')
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  const repair = async () => {
    setBusy('repair')
    setBridgeNote(undefined)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REPAIR_TIMEOUT_MS)
    try {
      const result = await repairBridge(baseUrl, controller.signal)
      if (result.health?.reasonCode !== 'ok' && result.nextStep) setBridgeNote(result.nextStep)
    } catch {
      setBridgeNote('修复请求没送到，确认爪爪服务在运行后重试')
    } finally {
      clearTimeout(timer)
      setBusy(null)
      void refresh()
    }
  }

  const installEngine = async () => {
    setBusy('engine')
    setEngineNote(undefined)
    try {
      const runtime = await postVkRuntimeInstall(baseUrl, { rebuild: false })
      setSnapshot((previous) => previous && { ...previous, runtime })
    } catch (error) {
      setEngineNote(vkErrorText(error, '没能开始准备解析引擎'))
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  const bridgeNeedsExtension = snapshot?.bridge?.reasonCode !== 'profile-required' && snapshot?.bridge?.reasonCode !== 'profile-disconnected'
  const engineLabel = snapshot?.runtime?.state === 'failed'
    ? '重试'
    : snapshot?.runtime?.state === 'installed' ? '立即更新' : '一键准备'

  return (
    <section className="getting-started" data-testid="getting-started" aria-label="开始使用">
      <header className="getting-started-header">
        <div>
          <h2>开始使用</h2>
          <p>三步准备好，就能采集灵感并解析视频</p>
        </div>
        <button type="button" data-testid="gs-dismiss" className="getting-started-dismiss" onClick={dismiss}>不再显示</button>
      </header>
      <ol className="getting-started-steps">
        <Step
          index={1}
          testId="gs-step-extension"
          title="浏览器扩展"
          description="灵感来源的命令、登录检查、部分小红书视频都需要它"
          status={bridge}
          actions={bridge && !bridge.done && (
            <>
              {bridgeNeedsExtension && (
                <button type="button" data-testid="gs-install-extension" className="getting-started-primary" disabled={busy !== null} onClick={() => { void installExtension() }}>
                  {busy === 'extension' ? '正在打开…' : '安装扩展'}
                </button>
              )}
              <button type="button" data-testid="gs-repair" className="getting-started-secondary" disabled={busy !== null} onClick={() => { void repair() }}>
                {busy === 'repair' ? '检测中…' : '检测并修复'}
              </button>
            </>
          )}
        >
          {bridgeNote && <div className="getting-started-note" data-testid="gs-extension-note">{bridgeNote}</div>}
          {bridge && !bridge.done && bridgeNeedsExtension && (
            <details className="getting-started-offline" data-testid="gs-offline">
              <summary>打不开商店？</summary>
              <ol>
                <li>
                  到 OpenCLI 的 GitHub Releases 页面（<a href={OFFLINE_RELEASES_URL} target="_blank" rel="noreferrer">{OFFLINE_RELEASES_URL}</a>）下载最新的 <code>{'opencli-extension-v{版本号}.zip'}</code>
                </li>
                <li>解压后，在 Chrome 地址栏打开 <code>chrome://extensions</code>，打开右上角的「开发者模式」</li>
                <li>点击「加载已解压的扩展程序」，选择解压后的文件夹</li>
              </ol>
            </details>
          )}
        </Step>
        <Step
          index={2}
          testId="gs-step-engine"
          title="解析引擎"
          description="解析视频要用到，一键准备即可，不用自己装 Python"
          status={engine}
          actions={engine && !engine.done && snapshot?.runtime?.state !== 'not-available' && (
            <button type="button" data-testid="gs-install-engine" className="getting-started-primary" disabled={busy !== null || installing} onClick={() => { void installEngine() }}>
              {installing ? '准备中…' : engineLabel}
            </button>
          )}
        >
          {engineNote && <div className="getting-started-note" data-testid="gs-engine-note">{engineNote}</div>}
        </Step>
        <Step
          index={3}
          testId="gs-step-providers"
          title="模型配置"
          description="给基础处理和深度分析各选一个模型，视频解析才能出结果"
          status={providers}
          actions={providers && !providers.done && (
            <button
              type="button"
              data-testid="gs-configure"
              className="getting-started-primary"
              disabled={providers.blocked}
              onClick={() => useAppStore.getState().setActiveModule('providers')}
            >
              去配置
            </button>
          )}
        />
      </ol>
    </section>
  )
}
