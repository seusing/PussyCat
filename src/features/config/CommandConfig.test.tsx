import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommandConfig } from './CommandConfig'
import { useAppStore } from '../../store/appStore'
import { commandPreview } from '../../data/command'
import type { CommandManifest } from '../../data/types'

const cmd: CommandManifest = {
  command: 'x/go', site: 'x', name: 'go', description: '示例', access: 'read', browser: false,
  args: [{ name: 'url', type: 'str', required: true }],
}
// 刻意与 cmd 共用字段名 url（但非必填）：若 CommandConfig 切命令时不清 errors，
// 旧的 errors.url 残留会让 DynamicField 对 cmdB 的 url 字段也错误地显示 error-url——
// 用同名字段而非空 args，测试才能真正区分"错误已清"和"字段本就不存在"。
const cmdB: CommandManifest = {
  command: 'y/list', site: 'y', name: 'list', description: '示例B', access: 'read', browser: false,
  args: [{ name: 'url', type: 'str', required: false }],
}

beforeEach(() => useAppStore.setState({ selected: cmd, values: {}, currentRun: undefined }))

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

import { emptyPreferences } from '../../data/preferences'

describe('收藏动作', () => {
  beforeEach(() => { useAppStore.setState({ selected: cmd, values: {}, currentRun: undefined, preferences: emptyPreferences(), stale: { sites: new Set(), commands: new Set() } }); localStorage.clear() })

  test('点 ☆站点 收藏并变实心', async () => {
    render(<CommandConfig onRun={() => {}} />)
    const btn = screen.getByTestId('fav-site')
    expect(btn).toHaveTextContent('☆')
    await userEvent.click(btn)
    expect(useAppStore.getState().preferences.favoriteSites.map((f) => f.site)).toEqual(['x'])
    expect(screen.getByTestId('fav-site')).toHaveTextContent('★')
  })

  test('点 ☆命令 收藏 command+site', async () => {
    render(<CommandConfig onRun={() => {}} />)
    await userEvent.click(screen.getByTestId('fav-command'))
    const fav = useAppStore.getState().preferences.favoriteCommands[0]
    expect(fav.command).toBe('x/go'); expect(fav.site).toBe('x')
    expect(screen.getByTestId('fav-command')).toHaveTextContent('★')
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
