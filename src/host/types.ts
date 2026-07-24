export type RunOutcome = 'success' | 'error' | 'cancelled'
export type OutputFormat = 'table' | 'plain' | 'json' | 'yaml' | 'md' | 'csv'

export type RunRequest = {
  runId: string
  commandKey: string          // "site/name"，list 主键
  argv: string[]              // buildArgv 产物（[site, name, ...]），唯一执行事实源
  format?: OutputFormat
  mockScenario?: 'success' | 'error'
}

export type OutputEvent = {
  runId: string
  seq: number
  at: number
  stream: 'stdout' | 'stderr'
  text: string
}

export type DoneEvent = {
  runId: string
  at: number
  outcome: RunOutcome
  exitCode?: number
  result?: Record<string, unknown>[]
  // error 仅在 outcome:'error' 时出现；cancelled/success 不带 error
  error?: { summary: string; detail?: string }
}

export interface HostBridge {
  startCommand(req: RunRequest): Promise<{ runId: string }>
  cancelCommand(runId: string): Promise<void>
  onOutput(cb: (e: OutputEvent) => void): () => void
  onDone(cb: (e: DoneEvent) => void): () => void
}
