import { activeRunCount, commandTabs, MANUAL_RUN_CONCURRENCY, redactValues, useAppStore } from './appStore'
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

describe('命令标签页', () => {
  beforeEach(() => { useAppStore.setState(initialState, true); localStorage.clear() })
  const mk = (name: string, args: CommandManifest['args'] = [{ name: 'q', type: 'str' }]): CommandManifest => ({
    command: 'x/' + name, site: 'x', name, description: '', access: 'read', browser: false, args,
  })
  const [a, b, c] = [mk('a'), mk('b'), mk('c')]
  const keys = () => commandTabs(useAppStore.getState()).map((t) => t.command.command)
  const out = (runId: string, seq = 0, text = 't') => ({ runId, seq, at: 1, stream: 'stdout' as const, text })
  const openThree = () => {
    const s = useAppStore.getState()
    s.selectCommand(a); s.selectCommand(b); s.selectCommand(c)
  }
  const openThreeRunning = () => {
    useAppStore.getState().selectCommand(a); useAppStore.getState().beginRun('run-a')
    useAppStore.getState().selectCommand(b); useAppStore.getState().beginRun('run-b')
    useAppStore.getState().selectCommand(c); useAppStore.getState().beginRun('run-c')
  }

  test('切到别的命令后,原标签的 values 与 run 都还在,切回来原样恢复', () => {
    const s = useAppStore.getState()
    s.selectCommand(a)
    s.setValue('q', 'alice')
    s.beginRun('run-a')
    s.appendOutput(out('run-a'))
    s.selectCommand(b)
    expect(useAppStore.getState().values).toEqual({})
    expect(useAppStore.getState().currentRun).toBeUndefined()
    useAppStore.getState().setValue('q', 'bob')
    useAppStore.getState().selectCommand(a)
    const back = useAppStore.getState()
    expect(back.values).toEqual({ q: 'alice' })
    expect(back.currentRun?.id).toBe('run-a')
    expect(back.currentRun?.lines).toHaveLength(1)
    expect(back.backgroundTabs[0].values).toEqual({ q: 'bob' })
  })

  test('重复 selectCommand 当前命令是 no-op,不重置 values', () => {
    const withDefault = mk('a', [{ name: 'limit', type: 'int', default: 10 }])
    useAppStore.getState().selectCommand(withDefault)
    useAppStore.getState().setValue('limit', 99)
    const before = useAppStore.getState()
    useAppStore.getState().selectCommand(withDefault)
    expect(useAppStore.getState()).toBe(before)
    expect(useAppStore.getState().values).toEqual({ limit: 99 })
  })

  test('新命令追加到标签栏末尾;来回切换后标签顺序不变', () => {
    openThree()
    expect(keys()).toEqual(['x/a', 'x/b', 'x/c'])
    for (const target of [a, c, b, a, c, c, b]) {
      useAppStore.getState().selectCommand(target)
      expect(keys()).toEqual(['x/a', 'x/b', 'x/c'])
      expect(useAppStore.getState().selected?.command).toBe(target.command)
    }
  })

  test('当前标签在中间时选最左的后台标签,顺序不乱、activeTabSlot 指向被选标签的位置', () => {
    openThree()
    useAppStore.getState().selectCommand(b)
    useAppStore.getState().selectCommand(a)
    expect(keys()).toEqual(['x/a', 'x/b', 'x/c'])
    expect(useAppStore.getState().activeTabSlot).toBe(0)
  })

  test('切换标签不改 runPanelCollapsed', () => {
    useAppStore.getState().selectCommand(a)
    useAppStore.getState().setRunPanelCollapsed(true)
    useAppStore.getState().selectCommand(b)
    expect(useAppStore.getState().runPanelCollapsed).toBe(true)
  })

  test('直接 setState({ selected }) 时,标签列表就是当前这一个', () => {
    useAppStore.setState({ selected: a })
    expect(keys()).toEqual(['x/a'])
  })

  test('后台标签继续收到 appendOutput / finishRun,当前标签不受影响', () => {
    const s = useAppStore.getState()
    s.selectCommand(a); s.beginRun('run-a')
    useAppStore.getState().selectCommand(b); useAppStore.getState().beginRun('run-b')
    useAppStore.getState().appendOutput(out('run-a', 0, 'from-a'))
    let st = useAppStore.getState()
    expect(st.currentRun?.id).toBe('run-b')
    expect(st.currentRun?.lines).toHaveLength(0)
    expect(st.backgroundTabs[0].run?.state).toBe('running')
    expect(st.backgroundTabs[0].run?.lines.map((l) => l.text)).toEqual(['from-a'])

    useAppStore.getState().finishRun({ runId: 'run-a', at: 5, outcome: 'success', result: [{ ok: 1 }] })
    st = useAppStore.getState()
    expect(st.backgroundTabs[0].run?.state).toBe('succeeded')
    expect(st.backgroundTabs[0].run?.result).toEqual([{ ok: 1 }])
    expect(st.currentRun?.state).toBe('starting')

    useAppStore.getState().appendOutput(out('run-a', 1, 'late'))   // 终态后迟到的输出仍被抑制
    expect(useAppStore.getState().backgroundTabs[0].run?.lines).toHaveLength(1)
    useAppStore.getState().appendOutput(out('nobody'))             // 不属于任何标签的 runId 忽略
    expect(useAppStore.getState().currentRun?.lines).toHaveLength(0)
  })

  test('activeRunCount 计入当前与后台标签里未终态的运行', () => {
    expect(activeRunCount(useAppStore.getState())).toBe(0)
    const s = useAppStore.getState()
    s.selectCommand(a); s.beginRun('run-a')
    expect(activeRunCount(useAppStore.getState())).toBe(1)
    useAppStore.getState().selectCommand(b); useAppStore.getState().beginRun('run-b')
    useAppStore.getState().selectCommand(c)
    expect(activeRunCount(useAppStore.getState())).toBe(2)
    useAppStore.getState().finishRun({ runId: 'run-a', at: 2, outcome: 'success' })
    expect(activeRunCount(useAppStore.getState())).toBe(1)
    useAppStore.getState().finishRun({ runId: 'run-b', at: 2, outcome: 'error', error: { summary: 'x' } })
    expect(activeRunCount(useAppStore.getState())).toBe(0)
    expect(MANUAL_RUN_CONCURRENCY).toBe(3)
  })

  describe('closeTab', () => {
    test('关后台标签:移除并校正 activeTabSlot,当前标签不变', () => {
      openThree()
      useAppStore.getState().closeTab('x/a')
      expect(keys()).toEqual(['x/b', 'x/c'])
      expect(useAppStore.getState().selected?.command).toBe('x/c')
      expect(useAppStore.getState().activeTabSlot).toBe(1)
      useAppStore.getState().selectCommand(b)
      useAppStore.getState().closeTab('x/c')
      expect(keys()).toEqual(['x/b'])
      expect(useAppStore.getState().activeTabSlot).toBe(0)
    })

    test('关当前标签:右邻优先,带出它的 values 与 run', () => {
      openThree()
      useAppStore.getState().setValue('q', 'from-c')
      useAppStore.getState().beginRun('run-c')
      useAppStore.getState().selectCommand(b)
      useAppStore.getState().closeTab('x/b')
      const st = useAppStore.getState()
      expect(st.selected?.command).toBe('x/c')
      expect(st.values).toEqual({ q: 'from-c' })
      expect(st.currentRun?.id).toBe('run-c')
      expect(keys()).toEqual(['x/a', 'x/c'])
      expect(st.activeTabSlot).toBe(1)
    })

    test('关最右的当前标签:激活左邻', () => {
      openThree()
      useAppStore.getState().closeTab('x/c')
      expect(useAppStore.getState().selected?.command).toBe('x/b')
      expect(keys()).toEqual(['x/a', 'x/b'])
      expect(useAppStore.getState().activeTabSlot).toBe(1)
    })

    test('关最后一个标签:selected / currentRun 清空,values 归 {}', () => {
      useAppStore.getState().selectCommand(a)
      useAppStore.getState().setValue('q', 'v')
      useAppStore.getState().beginRun('run-a')
      useAppStore.getState().closeTab('x/a')
      const st = useAppStore.getState()
      expect(st.selected).toBeUndefined()
      expect(st.currentRun).toBeUndefined()
      expect(st.values).toEqual({})
      expect(keys()).toEqual([])
    })

    test('不存在的 key 是 no-op', () => {
      openThree()
      const before = useAppStore.getState()
      useAppStore.getState().closeTab('x/nope')
      expect(useAppStore.getState()).toBe(before)
    })
  })

  describe('setCommands 对后台标签', () => {
    test('后台标签按同规则校正:新 manifest、活值∩新参数、新默认', () => {
      useAppStore.getState().selectCommand(mk('a', [{ name: 'user', type: 'str' }, { name: 'limit', type: 'int', default: 10 }]))
      useAppStore.getState().setValue('user', 'alice')
      useAppStore.getState().selectCommand(b)
      useAppStore.getState().setCommands([
        { ...mk('a', [{ name: 'user', type: 'str' }, { name: 'page', type: 'int', default: 1 }]), description: 'v2' },
        b,
      ])
      const tab = useAppStore.getState().backgroundTabs[0]
      expect(tab.command.description).toBe('v2')
      expect(tab.values).toEqual({ user: 'alice', page: 1 })
    })

    test('目录里没了的后台标签被移除,activeTabSlot 随之校正,它的运行不再计数', () => {
      openThreeRunning()
      useAppStore.getState().setCommands([b, c])
      expect(keys()).toEqual(['x/b', 'x/c'])
      expect(useAppStore.getState().selected?.command).toBe('x/c')
      expect(useAppStore.getState().activeTabSlot).toBe(1)
      expect(activeRunCount(useAppStore.getState())).toBe(2)
    })

    test('当前标签被删而还有标签:右邻顶上来', () => {
      openThree()
      useAppStore.getState().selectCommand(b)
      useAppStore.getState().setCommands([a, c])
      expect(useAppStore.getState().selected?.command).toBe('x/c')
      expect(keys()).toEqual(['x/a', 'x/c'])
    })

    test('当前标签被删且没有别的标签:清 selected/values,currentRun 不动', () => {
      useAppStore.getState().selectCommand(a)
      useAppStore.getState().beginRun('run-a')
      const run = useAppStore.getState().currentRun
      useAppStore.getState().setCommands([])
      expect(useAppStore.getState().selected).toBeUndefined()
      expect(useAppStore.getState().currentRun).toBe(run)
    })
  })
})
