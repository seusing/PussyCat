import type { RunOutcome } from '../host/types'

export type RunState =
  | 'idle' | 'validating' | 'starting' | 'running'
  | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'

export type RunEvent =
  | { type: 'RUN' }
  | { type: 'VALID' }
  | { type: 'INVALID' }
  | { type: 'OUTPUT' }
  | { type: 'CANCEL' }
  | { type: 'DONE'; outcome: RunOutcome }

const outcomeState: Record<RunOutcome, RunState> = {
  success: 'succeeded',
  error: 'failed',
  cancelled: 'cancelled',
}

export function transition(state: RunState, event: RunEvent): RunState {
  switch (state) {
    case 'idle':
      return event.type === 'RUN' ? 'validating' : state
    case 'validating':
      if (event.type === 'VALID') return 'starting'
      if (event.type === 'INVALID') return 'idle'
      return state
    case 'starting':
      if (event.type === 'OUTPUT') return 'running'
      if (event.type === 'DONE') return outcomeState[event.outcome]
      if (event.type === 'CANCEL') return 'cancelling'
      return state
    case 'running':
      if (event.type === 'CANCEL') return 'cancelling'
      if (event.type === 'DONE') return outcomeState[event.outcome]
      return state
    case 'cancelling':
      if (event.type === 'DONE') return outcomeState[event.outcome]
      return state
    default:
      return state
  }
}
