// 结构化子集:与 store 的 CommandRun 结构兼容,但不 import store(保持 data 层叶子纯净)
export type CopyableRun = {
  state: string
  lines: { seq: number; text: string }[]
  result?: Record<string, unknown>[]
  error?: { summary: string; detail?: string }
}

export type CopyPayload = { label: string; text: string }

export function copyPayloadFor(run: CopyableRun): CopyPayload | null {
  if (run.state === 'succeeded') {
    return { label: '复制结构化结果', text: JSON.stringify(run.result ?? [], null, 2) }
  }
  if (run.state === 'failed' || run.state === 'cancelled') {
    const log = [...run.lines].sort((a, b) => a.seq - b.seq).map((l) => l.text).join('\n')
    const fallback = run.error ? [run.error.summary, run.error.detail].filter(Boolean).join('\n') : ''
    return { label: '复制日志', text: log || fallback }   // 启动失败 lines=[] 回退 error
  }
  return null
}
