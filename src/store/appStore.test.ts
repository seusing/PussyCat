import { redactValues, useAppStore } from './appStore'
import type { CommandManifest } from '../data/types'

const cmd: CommandManifest = {
  command: 'x/login', site: 'x', name: 'login', description: '', access: 'write', browser: true,
  args: [{ name: 'password', type: 'str' }, { name: 'timeout', type: 'int' }],
}

const initialState = useAppStore.getState()
beforeEach(() => { useAppStore.setState(initialState, true) })  // true = replace，每个用例前恢复初始态

test('markCancelling→finishRun(cancelled) 取消流程且不带 error', () => {
  useAppStore.getState().selectCommand(cmd)
  useAppStore.getState().beginRun('run-2')
  useAppStore.getState().appendOutput({ runId: 'run-2', seq: 0, at: 1, stream: 'stdout', text: 'x' })
  useAppStore.getState().markCancelling()
  expect(useAppStore.getState().currentRun?.state).toBe('cancelling')
  useAppStore.getState().finishRun({ runId: 'run-2', at: 2, outcome: 'cancelled' })
  expect(useAppStore.getState().currentRun?.state).toBe('cancelled')
  expect(useAppStore.getState().currentRun?.error).toBeUndefined()
})

test('redactValues 脱敏敏感字段', () => {
  const out = redactValues(cmd, { password: 'secret', timeout: 5 })
  expect(out.password).toBe('••••')
  expect(out.timeout).toBe(5)
})

test('selectCommand 重置 values 为默认值', () => {
  const withDefault: CommandManifest = { ...cmd, args: [{ name: 'timeout', type: 'int', default: 300 }] }
  useAppStore.getState().selectCommand(withDefault)
  expect(useAppStore.getState().values).toEqual({ timeout: 300 })
})

test('beginRun→appendOutput→finishRun 驱动状态与日志', () => {
  useAppStore.getState().selectCommand(cmd)
  useAppStore.getState().beginRun('run-1')
  expect(useAppStore.getState().currentRun?.state).toBe('starting')
  useAppStore.getState().appendOutput({ runId: 'run-1', seq: 0, at: 1, stream: 'stdout', text: 'hi' })
  expect(useAppStore.getState().currentRun?.state).toBe('running')
  expect(useAppStore.getState().currentRun?.lines).toHaveLength(1)
  useAppStore.getState().finishRun({ runId: 'run-1', at: 2, outcome: 'success', result: [{ ok: 1 }] })
  expect(useAppStore.getState().currentRun?.state).toBe('succeeded')
  expect(useAppStore.getState().currentRun?.result).toEqual([{ ok: 1 }])
})

test('mode 默认 demo', () => {
  expect(useAppStore.getState().mode).toBe('demo')
  useAppStore.getState().setMode('connected')
  expect(useAppStore.getState().mode).toBe('connected')
})

test('appendOutput：按 seq 去重且乱序插入有序', () => {
  useAppStore.getState().selectCommand(cmd); useAppStore.getState().beginRun('r1')
  const ev = (seq: number, text: string) => ({ runId: 'r1', seq, at: 1, stream: 'stdout' as const, text })
  useAppStore.getState().appendOutput(ev(1, 'b'))
  useAppStore.getState().appendOutput(ev(0, 'a'))
  useAppStore.getState().appendOutput(ev(1, 'b-dup'))   // 重复 seq → 丢弃
  const lines = useAppStore.getState().currentRun!.lines
  expect(lines.map((l) => l.seq)).toEqual([0, 1])
  expect(lines.map((l) => l.text)).toEqual(['a', 'b'])
})
test('appendOutput：终态后到达的 output 被抑制', () => {
  useAppStore.getState().selectCommand(cmd); useAppStore.getState().beginRun('r1')
  useAppStore.getState().finishRun({ runId: 'r1', at: 2, outcome: 'success' })
  useAppStore.getState().appendOutput({ runId: 'r1', seq: 0, at: 3, stream: 'stdout', text: 'late' })
  expect(useAppStore.getState().currentRun!.lines).toHaveLength(0)
})
test('finishRun：终态后重复 done 幂等（不覆盖）', () => {
  useAppStore.getState().selectCommand(cmd); useAppStore.getState().beginRun('r1')
  useAppStore.getState().finishRun({ runId: 'r1', at: 2, outcome: 'success' })
  useAppStore.getState().finishRun({ runId: 'r1', at: 3, outcome: 'error', error: { summary: 'x' } })
  expect(useAppStore.getState().currentRun!.state).toBe('succeeded')
  expect(useAppStore.getState().currentRun!.error).toBeUndefined()
})
test('redactValues：脱真敏感、保留 keyword/key', () => {
  const c: CommandManifest = { ...cmd, args: [{ name: 'password', type: 'str' }, { name: 'keyword', type: 'str' }, { name: 'key', type: 'str' }] }
  const out = redactValues(c, { password: 'p', keyword: '茅台', key: 'PROJ-1' })
  expect(out.password).toBe('••••'); expect(out.keyword).toBe('茅台'); expect(out.key).toBe('PROJ-1')
})
test('catalogStatus 默认 loading，setCatalogStatus 可切', () => {
  expect(useAppStore.getState().catalogStatus).toBe('loading')
  useAppStore.getState().setCatalogStatus('error', '404')
  expect(useAppStore.getState().catalogStatus).toBe('error')
  expect(useAppStore.getState().catalogError).toBe('404')
})

test('setCommands 加载成功须清掉残留 catalogError（Task3 reviewer 发现的修复）', () => {
  useAppStore.getState().setCatalogStatus('error', '404')
  useAppStore.getState().setCommands([])
  expect(useAppStore.getState().catalogStatus).toBe('ready')
  expect(useAppStore.getState().catalogError).toBeUndefined()
})

describe('preferences 切片', () => {
  beforeEach(() => { useAppStore.setState(initialState, true); localStorage.clear() })

  test('beginRun 追加 recent(运行开始即记)', () => {
    useAppStore.getState().selectCommand(cmd)
    useAppStore.getState().beginRun('r-a')
    expect(useAppStore.getState().preferences.recent[0].command).toBe('x/login')
  })

  test('hydratePreferences 从 localStorage 载入', () => {
    localStorage.setItem('opencli-app:prefs:v1', JSON.stringify({ schemaVersion: 1, favoriteSites: [{ site: 'q', order: 0, createdAt: 1 }], favoriteCommands: [], recent: [] }))
    useAppStore.getState().hydratePreferences()
    expect(useAppStore.getState().preferences.favoriteSites[0].site).toBe('q')
  })

  test('setCommands 后 stale 正确派生(收藏了不存在的命令)', () => {
    useAppStore.setState((s) => ({
      preferences: { ...s.preferences, favoriteCommands: [{ command: 'x/login', site: 'x', order: 0, createdAt: 1 }] },
    }))
    useAppStore.getState().setCommands([])                            // 空 manifest → 不误灰
    expect(useAppStore.getState().stale.commands.size).toBe(0)
    useAppStore.getState().setCommands([{ command: 'other/x', site: 'other', name: 'x', description: '', access: 'read', browser: false, args: [] }])
    expect(useAppStore.getState().stale.commands.has('x/login')).toBe(true)   // x/login 不在新目录 → stale
  })

  test('hydratePreferences 也重算 stale(命令先到、偏好后到)', () => {
    useAppStore.getState().setCommands([{ command: 'other/x', site: 'other', name: 'x', description: '', access: 'read', browser: false, args: [] }])
    localStorage.setItem('opencli-app:prefs:v1', JSON.stringify({ schemaVersion: 1, favoriteSites: [], favoriteCommands: [{ command: 'x/login', site: 'x', order: 0, createdAt: 1 }], recent: [] }))
    useAppStore.getState().hydratePreferences()
    expect(useAppStore.getState().stale.commands.has('x/login')).toBe(true)
  })

  test('含重复键快照 hydrate 归一化为单条(二轮复审 P2)', () => {
    localStorage.setItem('opencli-app:prefs:v1', JSON.stringify({
      schemaVersion: 1,
      favoriteSites: [{ site: 'x', order: 0, createdAt: 1 }, { site: 'x', order: 2, createdAt: 5 }],
      favoriteCommands: [], recent: [],
    }))
    useAppStore.getState().hydratePreferences()
    expect(useAppStore.getState().preferences.favoriteSites).toHaveLength(1)
  })
})

describe('acknowledgement 切片(Task 8)', () => {
  const ackCmd: CommandManifest = {
    command: 'antigravity/recent-paths', site: 'antigravity', name: 'recent-paths', description: '', access: 'read', browser: false, args: [],
  }
  const ackDecision = {
    commandKey: ackCmd.command, state: 'acknowledgement-required' as const, decisionSource: 'tier-evaluation' as const,
    fingerprint: 'fp-1',
    metadata: { executionPath: 'direct-node' as const, authorities: ['ambient-local-files'], exposure: 'personal' as const, effects: [], credentialFlow: 'none' as const, residues: [] },
  }
  beforeEach(() => { useAppStore.setState(initialState, true); localStorage.clear() })

  test('requestAcknowledgement/dismissAcknowledgement 切换 pendingAcknowledgement', () => {
    expect(useAppStore.getState().pendingAcknowledgement).toBeUndefined()
    useAppStore.getState().requestAcknowledgement(ackCmd, ackDecision)
    expect(useAppStore.getState().pendingAcknowledgement).toEqual({ command: ackCmd, decision: ackDecision })
    useAppStore.getState().dismissAcknowledgement()
    expect(useAppStore.getState().pendingAcknowledgement).toBeUndefined()
  })

  test('acknowledgeCommand 写入 preferences 并落盘,返回 true', () => {
    const persisted = useAppStore.getState().acknowledgeCommand(ackCmd.command, 'fp-1', 100)
    expect(persisted).toBe(true)
    expect(useAppStore.getState().preferences.acknowledgements).toEqual([
      { commandKey: ackCmd.command, fingerprint: 'fp-1', acknowledgedAt: 100 },
    ])
    expect(localStorage.getItem('opencli-app:prefs:v2')).toContain('fp-1')
  })

  test('acknowledgeCommand 落盘失败时仍更新内存态,返回 false(IO 边界降级为本次会话有效)', () => {
    // src/vitest.setup.ts 每个用例前用内存对象桩替换全局 localStorage(见其注释:
    // 本机 Node 原生 localStorage 是坏桩),所以这里 spy 桩实例自身的 setItem,而非 Storage.prototype
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
    try {
      const persisted = useAppStore.getState().acknowledgeCommand(ackCmd.command, 'fp-1', 100)
      expect(persisted).toBe(false)
      expect(useAppStore.getState().preferences.acknowledgements).toHaveLength(1)   // 内存态仍写入
    } finally {
      setItemSpy.mockRestore()
    }
  })

  test('revokeAcknowledgementCommand 撤销后 preferences 不再含该条', () => {
    useAppStore.getState().acknowledgeCommand(ackCmd.command, 'fp-1', 100)
    useAppStore.getState().revokeAcknowledgementCommand(ackCmd.command)
    expect(useAppStore.getState().preferences.acknowledgements).toEqual([])
  })
})

describe('setCommands selection reconcile(块 B 阻塞3)', () => {
  beforeEach(() => { useAppStore.setState(initialState, true); localStorage.clear() })
  const mk = (over: Partial<CommandManifest> = {}): CommandManifest => ({
    command: 'x/login', site: 'x', name: 'login', description: '', access: 'read', browser: false,
    args: [
      { name: 'user', type: 'str', required: true },
      { name: 'limit', type: 'int', default: 10 },
    ],
    ...over,
  })

  test('A: 同 key 仍在 → selected 换新 manifest,活值保留+新参补默认+消失参数丢弃', () => {
    useAppStore.getState().selectCommand(mk())
    useAppStore.getState().setValue('user', 'alice')          // 活值
    const next = mk({ description: 'v2', args: [
      { name: 'user', type: 'str', required: true },          // 保留
      { name: 'page', type: 'int', default: 1 },              // 新参数
      // limit 已删除
    ] })
    useAppStore.getState().setCommands([next])
    const s = useAppStore.getState()
    expect(s.selected?.description).toBe('v2')                // 新 manifest
    expect(s.values).toEqual({ user: 'alice', page: 1 })      // 活值+新默认;limit 丢弃
  })

  test('B: 同 key 已删 → 清空 selected/values', () => {
    useAppStore.getState().selectCommand(mk())
    useAppStore.getState().setCommands([mk({ command: 'y/other', site: 'y', name: 'other' })])
    expect(useAppStore.getState().selected).toBeUndefined()
    expect(useAppStore.getState().values).toEqual({})
  })

  test('C: currentRun 不随刷新改写(历史快照)', () => {
    useAppStore.getState().selectCommand(mk())
    useAppStore.getState().beginRun('r-keep')
    const before = useAppStore.getState().currentRun
    useAppStore.getState().setCommands([])                    // 命令全删
    expect(useAppStore.getState().currentRun).toBe(before)    // 引用不变
    expect(useAppStore.getState().selected).toBeUndefined()
  })
})

describe('runPanelCollapsed 提升(块 C)', () => {
  beforeEach(() => { useAppStore.setState(initialState, true); localStorage.clear() })
  test('beginRun 自动展开(新 run 重置收起态)', () => {
    useAppStore.getState().setRunPanelCollapsed(true)
    useAppStore.getState().selectCommand(cmd)
    useAppStore.getState().beginRun('r-x')
    expect(useAppStore.getState().runPanelCollapsed).toBe(false)
  })
  test('setRunPanelCollapsed 独立于 run 状态机', () => {
    useAppStore.getState().selectCommand(cmd)
    useAppStore.getState().beginRun('r-y')
    useAppStore.getState().setRunPanelCollapsed(true)
    expect(useAppStore.getState().currentRun?.state).toBe('starting')   // 纯视图 flag,不碰状态机
  })
})

test('appendOutput 单调快路径:100 事件顺序与内容等价', () => {
  useAppStore.getState().selectCommand(cmd); useAppStore.getState().beginRun('r-fast')
  for (let i = 0; i < 100; i++) {
    useAppStore.getState().appendOutput({ runId: 'r-fast', seq: i, at: i, stream: 'stdout', text: `l${i}` })
  }
  const lines = useAppStore.getState().currentRun!.lines
  expect(lines).toHaveLength(100)
  expect(lines.map((l) => l.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i))
})
