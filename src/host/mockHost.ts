import type { HostBridge, RunRequest, OutputEvent, DoneEvent, RunOutcome } from './types'

type ActiveRun = { seq: number; timers: ReturnType<typeof setTimeout>[]; done: boolean; cancelled: boolean }

// 演示模式下的点点:按适配器的事件协议(@@zz-dot 行)回放一段示例回答,好在没有本地服务时也能看到对话窗口怎么动
const DOT_DEMO_STEPS = ['正在理解你的问题', '正在搜索相关笔记']
const DOT_DEMO_ANSWER = '这是演示模式下的示例回答。连上爪爪的本地服务，并在 Chrome 里登录小红书后，这里会显示点点的真实回答。'
const dotLine = (event: Record<string, unknown>) => `@@zz-dot ${JSON.stringify(event)}`

export function createMockHost(): HostBridge {
  const outputCbs = new Set<(e: OutputEvent) => void>()
  const doneCbs = new Set<(e: DoneEvent) => void>()
  const runs = new Map<string, ActiveRun>()
  const dotRuns = new Set<string>()

  const emit = (runId: string, run: ActiveRun, stream: 'stdout' | 'stderr', text: string) => {
    if (run.done) return // 防御性守卫：同步 mock 下不可达（done-once 由 clearTimeout+runs.delete+!run 短路保证）；真实异步 host（P0-B/P1）需自备竞态测试
    const e: OutputEvent = { runId, seq: run.seq++, at: Date.now(), stream, text }
    outputCbs.forEach((cb) => cb(e))
  }

  const finish = (runId: string, run: ActiveRun, outcome: RunOutcome, extra: Partial<DoneEvent> = {}) => {
    if (run.done) return                 // ① done-once；防御性守卫，同步 mock 下不可达（同上），真实异步 host（P0-B/P1）需自备竞态测试
    run.done = true
    run.timers.forEach(clearTimeout)
    doneCbs.forEach((cb) => cb({ runId, at: Date.now(), outcome, ...extra }))
    runs.delete(runId)
  }

  return {
    async startCommand(req: RunRequest) {
      const run: ActiveRun = { seq: 0, timers: [], done: false, cancelled: false }
      runs.set(req.runId, run)
      if (req.commandKey === 'xiaohongshu-dot/stop') {
        for (const [runId, active] of runs) {
          if (!dotRuns.has(runId)) continue
          dotRuns.delete(runId)
          emit(runId, active, 'stderr', dotLine({ type: 'done', sourceTotal: '', interrupted: true }))
          finish(runId, active, 'success', { exitCode: 0, result: [] })
        }
        run.timers.push(setTimeout(() => finish(req.runId, run, 'success', { exitCode: 0, result: [{ stopped: true }] }), 10))
        return { runId: req.runId }
      }
      if (req.commandKey === 'xiaohongshu-dot/chat') {
        dotRuns.add(req.runId)
        let at = 10
        const later = (fn: () => void, delay: number) => { at += delay; run.timers.push(setTimeout(fn, at)) }
        later(() => emit(req.runId, run, 'stderr', dotLine({ type: 'start', conversationId: 'demo-conversation', messageId: req.runId })), 0)
        for (const step of DOT_DEMO_STEPS) later(() => emit(req.runId, run, 'stderr', dotLine({ type: 'status', text: step })), 260)
        for (let index = 0; index < DOT_DEMO_ANSWER.length; index += 6) {
          const chunk = DOT_DEMO_ANSWER.slice(index, index + 6)
          later(() => emit(req.runId, run, 'stderr', dotLine({ type: 'delta', text: chunk })), 70)
        }
        later(() => {
          dotRuns.delete(req.runId)
          emit(req.runId, run, 'stderr', dotLine({ type: 'done', sourceTotal: 'ai为你回答', interrupted: false }))
          finish(req.runId, run, 'success', { exitCode: 0, result: [{ answer: DOT_DEMO_ANSWER }] })
        }, 80)
        return { runId: req.runId }
      }
      run.timers.push(setTimeout(() => emit(req.runId, run, 'stdout', `启动 ${req.commandKey}`), 10))
      run.timers.push(setTimeout(() => emit(req.runId, run, 'stdout', '正在连接…'), 30))
      if (req.mockScenario === 'error') {
        run.timers.push(setTimeout(() => emit(req.runId, run, 'stderr', '发生错误'), 50))
        run.timers.push(setTimeout(() => finish(req.runId, run, 'error', { exitCode: 1, error: { summary: '命令执行失败', detail: 'mock error detail' } }), 70))
      } else {
        run.timers.push(setTimeout(() => emit(req.runId, run, 'stdout', '完成'), 50))
        run.timers.push(setTimeout(() => finish(req.runId, run, 'success', { exitCode: 0, result: [{ status: 'ok', site: req.commandKey.split('/')[0] }] }), 70))
      }
      return { runId: req.runId }
    },

    async cancelCommand(runId: string) {
      const run = runs.get(runId)
      // ②③ 幂等 + 已结束(natural)则 no-op 保留真实终态；run.cancelled 分支同步 mock 下不可达（done-once 由 clearTimeout+runs.delete+!run 短路保证），真实异步 host（P0-B/P1）需自备竞态测试
      if (!run || run.cancelled) return
      run.cancelled = true
      dotRuns.delete(runId)
      finish(runId, run, 'cancelled') // cancelled 不带 error：error 字段仅属于 outcome:'error'（见 types.ts DoneEvent 注释）
    },

    onOutput(cb) { outputCbs.add(cb); return () => { outputCbs.delete(cb) } },
    onDone(cb) { doneCbs.add(cb); return () => { doneCbs.delete(cb) } },
  }
}
