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
  // 预览按 token 着色拆成多个 span,整体文本必须与 commandPreview(复制内容)逐字一致,且不含 `$ ` 提示符
  const text = screen.getByTestId('command-preview').textContent
  expect(text).toBe('opencli x go --url abc -f json')
  expect(text).toBe(commandPreview(cmd, { url: 'abc' }))
})

test('预览对含空格的值加引号,与复制出的文本一致', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  render(<CommandConfig onRun={() => {}} />)
  await userEvent.type(screen.getByTestId('field-url'), 'a b')
  expect(screen.getByTestId('command-preview').textContent).toBe('opencli x go --url "a b" -f json')
  await userEvent.click(screen.getByTestId('copy-command'))
  expect(writeText).toHaveBeenCalledWith('opencli x go --url "a b" -f json')
})

test('复制状态的定时器在卸载时清掉', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  const setSpy = vi.spyOn(globalThis, 'setTimeout')
  const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
  try {
    const { unmount } = render(<CommandConfig onRun={() => {}} />)
    await userEvent.click(screen.getByTestId('copy-command'))
    const at = setSpy.mock.calls.findIndex((c) => c[1] === 1500)
    expect(at).toBeGreaterThanOrEqual(0)
    const timerId = setSpy.mock.results[at].value
    unmount()
    expect(clearSpy).toHaveBeenCalledWith(timerId)
  } finally {
    setSpy.mockRestore()
    clearSpy.mockRestore()
  }
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

describe('select 空选项', () => {
  const selCmd = (def?: string): CommandManifest => ({
    command: 'x/sel', site: 'x', name: 'sel', description: '', access: 'read', browser: false,
    args: [{ name: 'mode', type: 'str', required: false, choices: ['a', 'b'], ...(def !== undefined ? { default: def } : {}) }],
  })

  beforeEach(() => {
    useAppStore.setState({ decisions: new Map([['x/sel', { commandKey: 'x/sel', state: 'ready' as const, decisionSource: 'legacy-baseline' as const }]]) })
  })

  test('有 default 时选项列表不含空选项', async () => {
    useAppStore.getState().selectCommand(selCmd('a'))
    render(<CommandConfig onRun={() => {}} />)
    await userEvent.click(screen.getByTestId('field-mode'))
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-value'))).toEqual(['a', 'b'])
  })

  test('无 default 时首项为"不指定"', async () => {
    useAppStore.getState().selectCommand(selCmd(undefined))
    render(<CommandConfig onRun={() => {}} />)
    await userEvent.click(screen.getByTestId('field-mode'))
    const opts = screen.getAllByRole('option')
    expect(opts[0]).toHaveTextContent('不指定')
    expect(opts[0]).toHaveAttribute('data-value', '')
    expect(opts.map((o) => o.getAttribute('data-value'))).toEqual(['', 'a', 'b'])
  })
})

describe('表单网格与布尔开关', () => {
  const mixed: CommandManifest = {
    command: 'x/mixed', site: 'x', name: 'mixed', description: '', access: 'read', browser: false,
    args: [
      { name: 'query', type: 'str', required: true, positional: true, help: '搜索关键词' },
      { name: 'limit', type: 'int', required: false, help: '返回条数' },
      { name: 'sort', type: 'str', required: false, choices: ['a', 'b'], help: '排序依据' },
      { name: 'verbose', type: 'bool', required: false, help: '输出详细日志' },
    ],
  }

  beforeEach(() => {
    useAppStore.setState({
      decisions: new Map([['x/mixed', { commandKey: 'x/mixed', state: 'ready' as const, decisionSource: 'legacy-baseline' as const }]]),
    })
    useAppStore.getState().selectCommand(mixed)
  })

  test('text 与布尔磁贴占满整行,number/select 各占一格', () => {
    render(<CommandConfig onRun={() => {}} />)
    const full = (name: string) => screen.getByTestId(`field-${name}`).closest('label')!.classList.contains('cmd-field--full')
    expect(full('query')).toBe(true)
    expect(full('verbose')).toBe(true)
    expect(full('limit')).toBe(false)
    expect(full('sort')).toBe(false)
  })

  test('布尔参数是拨动开关:点轨道与键盘空格都能切换,并进入预览', async () => {
    render(<CommandConfig onRun={() => {}} />)
    const input = screen.getByTestId('field-verbose') as HTMLInputElement
    const wrap = input.parentElement!
    expect(wrap).toHaveClass('cmd-field-switch-wrap')
    expect(input.checked).toBe(false)
    await userEvent.click(wrap.querySelector('.cmd-field-switch-track')!)
    expect(useAppStore.getState().values.verbose).toBe(true)
    expect(screen.getByTestId('command-preview').textContent).toContain('--verbose true')
    input.focus()
    await userEvent.keyboard(' ')
    expect(useAppStore.getState().values.verbose).toBe(false)
  })

  test('布尔磁贴:说明与参数名同在标签里,点磁贴任意位置(含文字)都切换', async () => {
    render(<CommandConfig onRun={() => {}} />)
    const input = screen.getByTestId('field-verbose') as HTMLInputElement
    const tile = input.closest('.cmd-field-tile') as HTMLElement
    expect(tile).not.toBeNull()
    const label = within(tile).getByTestId('field-label-verbose')
    expect(within(label).getByTestId('field-help-verbose')).toHaveTextContent('输出详细日志')
    expect(within(label).getByText('verbose')).toBeInTheDocument()
    await userEvent.click(within(label).getByTestId('field-help-verbose'))
    expect(useAppStore.getState().values.verbose).toBe(true)
    await userEvent.click(tile)
    expect(useAppStore.getState().values.verbose).toBe(false)
  })

  test('格子里的 select/number 标题带 title 悬停看全文;整行的 text 与开关磁贴不带', () => {
    render(<CommandConfig onRun={() => {}} />)
    const titleOf = (name: string) => screen.getByTestId(`field-help-${name}`).closest('.cmd-field-title')!
    expect(titleOf('limit')).toHaveAttribute('title', '返回条数')
    expect(titleOf('sort')).toHaveAttribute('title', '排序依据')
    expect(titleOf('query')).not.toHaveAttribute('title')
    expect(titleOf('verbose')).not.toHaveAttribute('title')
  })

  test('参数说明为主标签、参数名为小标签,必填带红星', () => {
    render(<CommandConfig onRun={() => {}} />)
    expect(within(screen.getByTestId('field-label-query')).getByText('*')).toBeInTheDocument()
    expect(within(screen.getByTestId('field-label-limit')).queryByText('*')).not.toBeInTheDocument()
  })
})

describe('命令说明:四个站点的命令用中文,其余回落 manifest 原文', () => {
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

  test('非四站命令**如实回落英文原文** —— 不做机翻、不留半截译文', () => {
    const other: CommandManifest = {
      command: 'github/trending', site: 'github', name: 'trending',
      description: 'List trending repositories', access: 'read', browser: true, args: [],
    }
    useAppStore.setState({ selected: other, values: {}, currentRun: undefined, decisions: new Map() })
    render(<CommandConfig onRun={() => {}} />)
    expect(screen.getByText('List trending repositories')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'trending' })).toBeInTheDocument()
    expect(screen.getByTestId('command-header')).not.toHaveTextContent('trending trending')   // 没有中文名就不重复一遍英文
  })

  test('标题用中文短名,英文命令名作为副标题', () => {
    const timeline: CommandManifest = {
      command: 'twitter/timeline', site: 'twitter', name: 'timeline',
      description: "Fetch the logged-in user's home timeline", access: 'read', browser: true, args: [],
    }
    useAppStore.setState({ selected: timeline, values: {}, currentRun: undefined, decisions: new Map() })
    render(<CommandConfig onRun={() => {}} />)
    const heading = screen.getByRole('heading', { name: '首页时间线' })
    expect(heading).toBeInTheDocument()
    expect(heading.parentElement).toHaveTextContent('timeline')
  })
})
