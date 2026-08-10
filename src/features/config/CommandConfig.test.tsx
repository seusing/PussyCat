import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommandConfig } from './CommandConfig'
import { useAppStore } from '../../store/appStore'
import { commandPreview } from '../../data/command'
import type { CommandManifest } from '../../data/types'

const cmd: CommandManifest = {
  command: 'x/go', site: 'x', name: 'go', description: '示例', access: 'read', browser: false,
  args: [{ name: 'url', type: 'str', required: true, help: '请输入目标地址' }],
}
// 刻意与 cmd 共用字段名 url（但非必填）：若 CommandConfig 切命令时不清 errors，
// 旧的 errors.url 残留会让 DynamicField 对 cmdB 的 url 字段也错误地显示 error-url——
// 用同名字段而非空 args，测试才能真正区分"错误已清"和"字段本就不存在"。
const cmdB: CommandManifest = {
  command: 'y/list', site: 'y', name: 'list', description: '示例B', access: 'read', browser: false,
  args: [{ name: 'url', type: 'str', required: false }],
}

// P1 Task7:运行按钮现由 Host 判决闸控(I-P1)。这两条命令补一条最简 ready 判决,
// 否则按钮会因 decisions 为空而 disabled——语义变更,改写而非删除既有断言(R7)。
const readyDecisions = new Map([
  [cmd.command, { commandKey: cmd.command, state: 'ready' as const, decisionSource: 'legacy-baseline' as const }],
  [cmdB.command, { commandKey: cmdB.command, state: 'ready' as const, decisionSource: 'legacy-baseline' as const }],
])

beforeEach(() => useAppStore.setState({ selected: cmd, values: {}, currentRun: undefined, decisions: readyDecisions }))

test('无选中命令时提示', () => {
  useAppStore.setState({ selected: undefined })
  render(<CommandConfig onRun={() => {}} />)
  expect(screen.getByText('从左侧选择一个服务和命令')).toBeInTheDocument()
})

test('必填缺失时点运行不触发 onRun 并显示错误', async () => {
  const onRun = vi.fn()
  render(<CommandConfig onRun={onRun} />)
  expect(screen.queryByTestId('error-url')).not.toBeInTheDocument()  // mount 后、点击前不显 error
  await userEvent.click(screen.getByTestId('run-button'))
  expect(onRun).not.toHaveBeenCalled()
  expect(screen.getByTestId('error-url')).toHaveTextContent('此字段必填')
})

test('填写后点运行触发 onRun', async () => {
  const onRun = vi.fn()
  render(<CommandConfig onRun={onRun} />)
  await userEvent.type(screen.getByTestId('field-url'), 'https://x')
  await userEvent.click(screen.getByTestId('run-button'))
  expect(onRun).toHaveBeenCalledOnce()
})

test('命令预览随输入更新', async () => {
  render(<CommandConfig onRun={() => {}} />)
  await userEvent.type(screen.getByTestId('field-url'), 'abc')
  expect(screen.getByText('opencli x go --url abc -f json')).toBeInTheDocument()
})

test('切换命令后旧字段错误不残留', async () => {
  render(<CommandConfig onRun={() => {}} />)
  await userEvent.click(screen.getByTestId('run-button'))          // 触发 cmd 的 required 错误
  expect(screen.getByTestId('error-url')).toBeInTheDocument()
  act(() => { useAppStore.getState().selectCommand(cmdB) })          // 切到 cmdB（非 DOM 事件触发的 store 直改，手动 act 包裹）
  await waitFor(() => expect(screen.queryByTestId('error-url')).not.toBeInTheDocument())
})

test('命令标题区域包含收藏、标签和说明且不再渲染旧面包屑', () => {
  render(<CommandConfig onRun={() => {}} />)
  const header = screen.getByTestId('command-header')
  expect(screen.queryByTestId('command-breadcrumb')).not.toBeInTheDocument()
  expect(screen.queryByText('/ go')).not.toBeInTheDocument()
  expect(within(header).getByTestId('fav-site')).toBeInTheDocument()
  expect(within(header).getByTestId('fav-command')).toBeInTheDocument()
  expect(within(header).getByText('read')).toBeInTheDocument()
  expect(within(header).getByTestId('command-description')).toHaveTextContent('示例')
})

test('参数帮助与参数名同在标签头且输入下不再单独显示帮助', () => {
  render(<CommandConfig onRun={() => {}} />)
  const field = screen.getByTestId('field-url')
  const label = field.closest('label')
  expect(label).not.toBeNull()
  const fieldLabel = within(label as HTMLElement).getByTestId('field-label-url')
  expect(within(fieldLabel).getByText('url')).toBeInTheDocument()
  expect(within(fieldLabel).getByTestId('field-help-url')).toHaveTextContent('请输入目标地址')
  expect(field.nextElementSibling?.getAttribute('data-testid')).not.toBe('field-help-url')
})

import { emptyPreferences } from '../../data/preferences'

describe('收藏动作', () => {
  beforeEach(() => { useAppStore.setState({ selected: cmd, values: {}, currentRun: undefined, preferences: emptyPreferences(), stale: { sites: new Set(), commands: new Set() } }); localStorage.clear() })

  test('点 Save Later 站点按钮后保存', async () => {
    render(<CommandConfig onRun={() => {}} />)
    const btn = screen.getByTestId('fav-site')
    expect(btn).toHaveTextContent('稍后查看')
    await userEvent.click(btn)
    expect(useAppStore.getState().preferences.favoriteSites.map((f) => f.site)).toEqual(['x'])
    expect(screen.getByTestId('fav-site')).toHaveTextContent('已保存')
  })

  test('点 Favorite 命令按钮后收藏 command+site', async () => {
    render(<CommandConfig onRun={() => {}} />)
    await userEvent.click(screen.getByTestId('fav-command'))
    const fav = useAppStore.getState().preferences.favoriteCommands[0]
    expect(fav.command).toBe('x/go'); expect(fav.site).toBe('x')
    expect(screen.getByTestId('fav-command')).toHaveTextContent('已收藏')
  })
})

test('preview 旁复制命令按钮,text=commandPreview', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  useAppStore.setState({ selected: cmd, values: {}, currentRun: undefined })
  render(<CommandConfig onRun={() => {}} />)
  await userEvent.click(screen.getByTestId('copy-command'))
  expect(writeText).toHaveBeenCalledWith(commandPreview(cmd, {}))
})

// 锁住 handleRun 的 running 守卫存在(评审 ⚠️ 指出它在键盘/按钮两条路径上都被别的机制兜住,
// 从无直接覆盖)。用**无必填字段**的 cmdB:删掉守卫后校验不会拦截,onRun 必被调用 → 该测试才有鉴别力。
// 诚实边界:本测试锁「守卫存在」,**锁不住「守卫读实时 store 而非渲染期闭包」**——
// out-of-act 的 store 写入仍被 React 及时 flush,造不出未提交窗口(已实测两种实现均绿)。
// 「读实时 store/单快照」与「ref 不在渲染期赋值」同属结构性不变式,由代码注释+评审把关,不谎称有护栏。
test('运行中经 ref 提交:running 守卫拦住 onRun(F3 直接覆盖)', () => {
  const onRun = vi.fn()
  let submit: (() => void) | null = null
  useAppStore.setState({ selected: cmdB, values: {}, currentRun: undefined })   // cmdB 无必填 → 校验不会误拦
  render(<CommandConfig onRun={onRun} registerSubmit={(fn) => { submit = fn }} />)
  act(() => {
    useAppStore.setState({ currentRun: { id: 'r', command: cmdB, values: {}, state: 'running', startedAt: 0, lines: [] } })
  })
  act(() => { submit!() })
  expect(onRun).not.toHaveBeenCalled()
})

test('空闲时经 ref 提交:守卫放行,onRun 被调用(反向护栏,防守卫写死 return)', () => {
  const onRun = vi.fn()
  let submit: (() => void) | null = null
  useAppStore.setState({ selected: cmdB, values: {}, currentRun: undefined })
  render(<CommandConfig onRun={onRun} registerSubmit={(fn) => { submit = fn }} />)
  act(() => { submit!() })
  expect(onRun).toHaveBeenCalledTimes(1)
})

// Task 8 Step 4:acknowledgement-required 且已确认的命令旁给一个撤销入口。
describe('撤销确认入口(Task 8)', () => {
  beforeEach(() => { useAppStore.setState({ preferences: emptyPreferences() }) })   // 与其它 describe 块的 acknowledgements 状态隔离

  const ackCmd: CommandManifest = {
    command: 'antigravity/recent-paths', site: 'antigravity', name: 'recent-paths', description: '', access: 'read', browser: false, args: [],
  }
  const ackDecision = {
    commandKey: ackCmd.command, state: 'acknowledgement-required' as const, decisionSource: 'tier-evaluation' as const,
    fingerprint: 'fp-1',
    metadata: { executionPath: 'direct-node' as const, authorities: [] as string[], exposure: 'personal' as const, effects: [] as string[], credentialFlow: 'none' as const, residues: [] as string[] },
  }

  test('未确认时不显示撤销入口', () => {
    useAppStore.setState({ selected: ackCmd, values: {}, currentRun: undefined, decisions: new Map([[ackCmd.command, ackDecision]]) })
    render(<CommandConfig onRun={() => {}} />)
    expect(screen.queryByTestId('revoke-acknowledge')).not.toBeInTheDocument()
  })

  test('已确认(fingerprint 匹配)时显示撤销入口;点击后清空该条确认', async () => {
    useAppStore.getState().acknowledgeCommand(ackCmd.command, 'fp-1', 100)
    useAppStore.setState({ selected: ackCmd, values: {}, currentRun: undefined, decisions: new Map([[ackCmd.command, ackDecision]]) })
    render(<CommandConfig onRun={() => {}} />)
    expect(screen.getByTestId('revoke-acknowledge')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('revoke-acknowledge'))
    expect(useAppStore.getState().preferences.acknowledgements).toEqual([])
  })

  test('fingerprint 不匹配(策略已漂移)时不显示撤销入口', () => {
    useAppStore.getState().acknowledgeCommand(ackCmd.command, 'stale-fp', 100)
    useAppStore.setState({ selected: ackCmd, values: {}, currentRun: undefined, decisions: new Map([[ackCmd.command, ackDecision]]) })
    render(<CommandConfig onRun={() => {}} />)
    expect(screen.queryByTestId('revoke-acknowledge')).not.toBeInTheDocument()
  })
})

// 已确认状态条:原先只有一个孤零零的「撤销确认」链接,看不出撤销的是什么。
// 现在把**授予内容**摊开写在撤销按钮旁边,语义自洽。
describe('已确认状态条说清授予了什么', () => {
  beforeEach(() => { useAppStore.setState({ preferences: emptyPreferences() }) })

  const pilotCmd: CommandManifest = {
    command: 'bilibili/hot', site: 'bilibili', name: 'hot', description: 'B站热门视频', access: 'read', browser: true, args: [],
  }
  const decisionWith = (authorities: string[]) => new Map([[pilotCmd.command, {
    commandKey: pilotCmd.command, state: 'acknowledgement-required' as const, decisionSource: 'tier-evaluation' as const,
    fingerprint: 'fp-hot',
    metadata: { executionPath: 'browser-bridge' as const, authorities, exposure: 'public' as const, effects: [] as string[], credentialFlow: 'consume' as const, residues: [] as string[] },
  }]])

  test('列出判决 metadata 里的授予项,而不是前端另编一套说法', () => {
    useAppStore.getState().acknowledgeCommand(pilotCmd.command, 'fp-hot', 100)
    useAppStore.setState({ selected: pilotCmd, values: {}, currentRun: undefined, decisions: decisionWith(['browser-profile', 'public-network']) })
    render(<CommandConfig onRun={() => {}} />)
    const banner = screen.getByTestId('acknowledged-banner')
    expect(banner).toHaveTextContent('使用浏览器里的登录状态')
    expect(banner).toHaveTextContent('访问对应网站')
    // 撤销按钮在状态条**内部**,与它说明的那件事绑在一起
    expect(within(banner).getByTestId('revoke-acknowledge')).toBeInTheDocument()
  })

  test('authorities 为空时不写出空的冒号列表', () => {
    useAppStore.getState().acknowledgeCommand(pilotCmd.command, 'fp-hot', 100)
    useAppStore.setState({ selected: pilotCmd, values: {}, currentRun: undefined, decisions: decisionWith([]) })
    render(<CommandConfig onRun={() => {}} />)
    const banner = screen.getByTestId('acknowledged-banner')
    expect(banner).toHaveTextContent('已允许本命令按已确认的范围执行')
    expect(banner.textContent).not.toContain('：')
  })

  test('未确认时整条状态条都不出现', () => {
    useAppStore.setState({ selected: pilotCmd, values: {}, currentRun: undefined, decisions: decisionWith(['browser-profile']) })
    render(<CommandConfig onRun={() => {}} />)
    expect(screen.queryByTestId('acknowledged-banner')).not.toBeInTheDocument()
  })
})

describe('命令说明:试点八条用中文,其余回落 manifest 原文', () => {
  test('试点命令显示中文精简说明,不显示英文原文', () => {
    const timeline: CommandManifest = {
      command: 'twitter/timeline', site: 'twitter', name: 'timeline',
      description: "Fetch the logged-in user's home timeline (for-you algorithmic feed by default)",
      access: 'read', browser: true, args: [],
    }
    useAppStore.setState({ selected: timeline, values: {}, currentRun: undefined, decisions: new Map() })
    render(<CommandConfig onRun={() => {}} />)
    expect(screen.getByText('读取你的 X 首页时间线')).toBeInTheDocument()
    expect(screen.queryByText(/Fetch the logged-in user/)).not.toBeInTheDocument()
  })

  test('非试点命令**如实回落英文原文** —— 不做机翻、不留半截译文', () => {
    const other: CommandManifest = {
      command: 'bilibili/history', site: 'bilibili', name: 'history',
      description: 'List recently watched videos', access: 'read', browser: true, args: [],
    }
    useAppStore.setState({ selected: other, values: {}, currentRun: undefined, decisions: new Map() })
    render(<CommandConfig onRun={() => {}} />)
    expect(screen.getByText('List recently watched videos')).toBeInTheDocument()
  })
})
