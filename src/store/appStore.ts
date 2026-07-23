import { create } from 'zustand'
import type { CommandManifest } from '../data/types'
import type { OutputEvent, DoneEvent } from '../host/types'
import { transition, type RunState } from './runMachine'

const SENSITIVE = /pass|token|secret|cookie|key/i

// cmd 暂未参与判定（脱敏仅按字段名正则），但按 brief 接口签名保留形参供未来按 arg 类型细化
export function redactValues(_cmd: CommandManifest, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(values)) out[k] = SENSITIVE.test(k) && !!v ? '••••' : v
  return out
}

export type CommandRun = {
  id: string
  command: CommandManifest
  values: Record<string, unknown>          // 已脱敏
  state: RunState
  startedAt: number
  endedAt?: number
  lines: OutputEvent[]
  result?: Record<string, unknown>[]
  error?: { summary: string; detail?: string }
}

function defaultsOf(cmd: CommandManifest): Record<string, unknown> {
  const v: Record<string, unknown> = {}
  for (const a of cmd.args) if (a.default !== undefined) v[a.name] = a.default
  return v
}

type AppState = {
  commands: CommandManifest[]
  setCommands: (cmds: CommandManifest[]) => void
  selected?: CommandManifest
  values: Record<string, unknown>
  selectCommand: (cmd: CommandManifest) => void
  setValue: (name: string, value: unknown) => void
  currentRun?: CommandRun
  beginRun: (runId: string) => void
  appendOutput: (e: OutputEvent) => void
  finishRun: (e: DoneEvent) => void
  markCancelling: () => void
  mode: 'demo' | 'connected'
}

export const useAppStore = create<AppState>((set, get) => ({
  commands: [],
  setCommands: (commands) => set({ commands }),
  selected: undefined,
  values: {},
  selectCommand: (cmd) => set({ selected: cmd, values: defaultsOf(cmd) }),
  setValue: (name, value) => set((s) => ({ values: { ...s.values, [name]: value } })),
  currentRun: undefined,
  beginRun: (runId) => {
    const cmd = get().selected
    if (!cmd) return
    set({
      currentRun: {
        id: runId, command: cmd, values: redactValues(cmd, get().values),
        state: transition(transition('idle', { type: 'RUN' }), { type: 'VALID' }), // →starting
        startedAt: Date.now(), lines: [],
      },
    })
  },
  appendOutput: (e) => set((s) => {
    if (!s.currentRun || s.currentRun.id !== e.runId) return s
    return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'OUTPUT' }), lines: [...s.currentRun.lines, e] } }
  }),
  finishRun: (e) => set((s) => {
    if (!s.currentRun || s.currentRun.id !== e.runId) return s
    return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'DONE', outcome: e.outcome }), endedAt: e.at, result: e.result, error: e.error } }
  }),
  markCancelling: () => set((s) => {
    if (!s.currentRun) return s
    return { currentRun: { ...s.currentRun, state: transition(s.currentRun.state, { type: 'CANCEL' }) } }
  }),
  mode: 'demo',
}))
