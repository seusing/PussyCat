import { useEffect, useRef, useState } from 'react'
import {
  cancelOpencliUpdate, fetchOpencliUpdate, rollbackOpencliRelease, startOpencliUpdate,
  type OpencliUpdateJob,
} from '../host/opencliRelease'
import { extensionPageFailureText, openExtensionPage } from '../host/bridgeClient'

const POLL_MS = 300
const SUCCESS_LINGER_MS = 3000

export type ExtensionWarning = { message: string }

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

// OpenCLI 应用内更新:发起 → 轮询任务 → 成功后收起卡片并让顶栏重查版本。
// 在 App 层调用,状态不随顶栏那一块(只在命令页挂载)出现或消失;enabled 只在连着 Host 时为 true。
export function useOpencliUpdate(baseUrl: string | undefined, onSettled: () => void, enabled: boolean) {
  const [job, setJob] = useState<OpencliUpdateJob | null>(null)
  const [cardOpen, setCardOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rollingBack, setRollingBack] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [extensionWarning, setExtensionWarning] = useState<ExtensionWarning | null>(null)
  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled

  // 窗口刷新后接上 Host 里仍在跑的任务;没有任务或已结束就什么都不做。
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    fetchOpencliUpdate(baseUrl, controller.signal).then((next) => {
      if (controller.signal.aborted || next?.state !== 'running') return
      setJob((current) => current ?? next)
      setCardOpen(true)
    }, () => {})
    return () => controller.abort()
  }, [enabled, baseUrl])

  const running = job?.state === 'running'
  useEffect(() => {
    if (!running) return
    const controller = new AbortController()
    let timer = 0
    const tick = async () => {
      try {
        const next = await fetchOpencliUpdate(baseUrl, controller.signal)
        if (controller.signal.aborted) return
        setJob(next)
        if (next?.state !== 'running') return
      } catch {
        if (controller.signal.aborted) return
      }
      timer = window.setTimeout(tick, POLL_MS)
    }
    timer = window.setTimeout(tick, POLL_MS)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [running, job?.id, baseUrl])

  const succeededId = job?.state === 'succeeded' ? job.id : undefined
  useEffect(() => {
    if (!succeededId) return
    const warning = job?.warnings.find((item) => item.code === 'extension-outdated')
    const timer = window.setTimeout(() => {
      setCardOpen(false)
      if (warning) setExtensionWarning({ message: warning.message })
      onSettledRef.current()
    }, SUCCESS_LINGER_MS)
    return () => window.clearTimeout(timer)
  }, [succeededId])

  const guarded = async (action: () => Promise<void>) => {
    setNotice(undefined)
    setBusy(true)
    try { await action() } catch (err) { setNotice(messageOf(err)) } finally { setBusy(false) }
  }

  const start = (version: string) => guarded(async () => {
    const next = await startOpencliUpdate(version, baseUrl)
    setExtensionWarning(null)
    setJob(next)
    setCardOpen(true)
  })
  // 退回内置版本要重启守护进程、刷新目录,要好几秒:rollingBack 让顶栏有进度反馈。
  // 成功时 onSettled 在同一拍里让顶栏接上"检查中",中间不会闪回旧文字。
  const rollback = () => guarded(async () => {
    setRollingBack(true)
    try {
      await rollbackOpencliRelease(baseUrl)
      setExtensionWarning(null)   // 提醒针对被换掉的那个版本,回到内置版本后就过时了
      onSettledRef.current()
    } finally {
      setRollingBack(false)
    }
  })
  // 由宿主在 Chrome 里打开写死的商店页;没成功的原因走顶栏的错误提示。
  const openExtensionStore = () => guarded(async () => {
    const result = await openExtensionPage(baseUrl)
    if (!result.ok) throw new Error(extensionPageFailureText(result.reasonCode))
  })
  const cancel = async () => {
    try { setJob(await cancelOpencliUpdate(baseUrl)) } catch (err) { setNotice(messageOf(err)) }
  }
  const dismissCard = () => setCardOpen(false)
  const dismissWarning = () => setExtensionWarning(null)
  const clearNotice = () => setNotice(undefined)

  // 已取消的任务不留卡片;失败的卡片留到用户关掉或重试。
  const card = cardOpen && job && job.state !== 'cancelled' ? job : null
  return {
    card,
    updating: card !== null && card.state !== 'failed',
    busy,
    rollingBack,
    notice,
    extensionWarning,
    start, rollback, openExtensionStore, cancel, dismissCard, dismissWarning, clearNotice,
  }
}

export type OpencliUpdate = ReturnType<typeof useOpencliUpdate>
