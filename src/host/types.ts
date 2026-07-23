export type RunOutcome = 'success' | 'error' | 'cancelled'
export type OutputFormat = 'table' | 'plain' | 'json' | 'yaml' | 'md' | 'csv'

export type RunRequest = {
  runId: string
  site: string
  command: string
  args: Record<string, unknown>
  format?: OutputFormat
  mockScenario?: 'success' | 'error'   // 仅 mockHost 使用；缺省 success
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
