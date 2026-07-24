import type { HostBridge, RunRequest, OutputEvent, DoneEvent, RunOutcome } from './types'

type ActiveRun = { seq: number; timers: ReturnType<typeof setTimeout>[]; done: boolean; cancelled: boolean }

export function createMockHost(): HostBridge {
  const outputCbs = new Set<(e: OutputEvent) => void>()
  const doneCbs = new Set<(e: DoneEvent) => void>()
  const runs = new Map<string, ActiveRun>()

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
      finish(runId, run, 'cancelled') // cancelled 不带 error：error 字段仅属于 outcome:'error'（见 types.ts DoneEvent 注释）
    },

    onOutput(cb) { outputCbs.add(cb); return () => { outputCbs.delete(cb) } },
    onDone(cb) { doneCbs.add(cb); return () => { doneCbs.delete(cb) } },
  }
}
