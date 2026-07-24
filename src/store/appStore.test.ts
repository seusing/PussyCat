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

  test('toggleSiteFavorite 收藏并落盘', () => {
    useAppStore.getState().toggleSiteFavorite('xiaohongshu')
    expect(useAppStore.getState().preferences.favoriteSites.map((f) => f.site)).toEqual(['xiaohongshu'])
    expect(localStorage.getItem('opencli-app:prefs:v1')).toContain('xiaohongshu')
  })

  test('toggleCommandFavorite 存 command+site', () => {
    useAppStore.getState().toggleCommandFavorite(cmd)   // cmd = x/login(文件顶部已定义)
    const fav = useAppStore.getState().preferences.favoriteCommands[0]
    expect(fav.command).toBe('x/login'); expect(fav.site).toBe('x')
  })

  test('取消收藏设置 lastUndo,undoLastFavorite 回滚', () => {
    useAppStore.getState().toggleSiteFavorite('x')       // 收藏
    useAppStore.getState().toggleSiteFavorite('x')       // 取消 → lastUndo
    expect(useAppStore.getState().lastUndo).toMatchObject({ kind: 'site', item: { site: 'x' } })
    useAppStore.getState().undoLastFavorite()
    expect(useAppStore.getState().preferences.favoriteSites.map((f) => f.site)).toEqual(['x'])
    expect(useAppStore.getState().lastUndo).toBeUndefined()
  })

  test('收藏(新增)不设 lastUndo;dismissUndo 清除', () => {
    useAppStore.getState().toggleSiteFavorite('x')
    expect(useAppStore.getState().lastUndo).toBeUndefined()
    useAppStore.setState({ lastUndo: { kind: 'site', item: { site: 'z', order: 0, createdAt: 1 } } })
    useAppStore.getState().dismissUndo()
    expect(useAppStore.getState().lastUndo).toBeUndefined()
  })

  test('command 撤销恢复原 createdAt(原位)', () => {
    // 注入时钟:同步执行两次 Date.now() 常落同一毫秒,旧实现(undo=重新 toggle)会巧合通过;
    // mock 只给两次值,旧实现 undo 的第三次取钟得 undefined → 确定性红
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000)
    try {
      useAppStore.getState().toggleCommandFavorite(cmd)      // createdAt=1000
      const orig = useAppStore.getState().preferences.favoriteCommands[0]
      expect(orig.createdAt).toBe(1000)
      useAppStore.getState().toggleCommandFavorite(cmd)      // 取消(now=2000 被移除分支忽略)
      useAppStore.getState().undoLastFavorite()              // restore 路径不取时钟
      expect(useAppStore.getState().preferences.favoriteCommands[0]).toEqual(orig)
    } finally {
      nowSpy.mockRestore()
    }
  })

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
    useAppStore.getState().toggleCommandFavorite(cmd)                 // x/login
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

  test('hydratePreferences 清空遗留 lastUndo(M3 防御)', () => {
    useAppStore.setState({ lastUndo: { kind: 'site', item: { site: 'z', order: 0, createdAt: 1 } } })
    useAppStore.getState().hydratePreferences()
    expect(useAppStore.getState().lastUndo).toBeUndefined()
  })
})
