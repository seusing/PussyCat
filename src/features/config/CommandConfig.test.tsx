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
