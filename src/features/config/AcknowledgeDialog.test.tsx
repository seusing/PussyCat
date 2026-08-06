import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AcknowledgeDialog, type PendingAcknowledgement } from './AcknowledgeDialog'
import { useAppStore } from '../../store/appStore'
import type { CommandManifest } from '../../data/types'

const initialState = useAppStore.getState()
beforeEach(() => { useAppStore.setState(initialState, true) })

const cmd: CommandManifest = {
  command: 'antigravity/recent-paths', site: 'antigravity', name: 'recent-paths',
  description: '读取 Antigravity 最近打开的路径', access: 'read', browser: false, args: [],
}

const pending = (over: Partial<PendingAcknowledgement['decision']> = {}): PendingAcknowledgement => ({
  command: cmd,
  decision: {
    commandKey: cmd.command, state: 'acknowledgement-required', decisionSource: 'tier-evaluation',
    fingerprint: 'fp-1',
    metadata: { executionPath: 'direct-node', authorities: ['ambient-local-files'], exposure: 'personal', effects: [], credentialFlow: 'none', residues: [] },
    ...over,
  },
})

test('pending 为空时不渲染', () => {
  render(<AcknowledgeDialog pending={undefined} onConfirmed={() => {}} onCancel={() => {}} />)
  expect(screen.queryByTestId('acknowledge-dialog')).not.toBeInTheDocument()
})

test('展示命令名、exposure 与 authorities 的中文说明', () => {
  render(<AcknowledgeDialog pending={pending()} onConfirmed={() => {}} onCancel={() => {}} />)
  expect(screen.getByText('确认执行「recent-paths」')).toBeInTheDocument()
  expect(screen.getByTestId('ack-exposure')).toHaveTextContent('涉及个人信息')
  expect(screen.getByTestId('ack-authorities')).toHaveTextContent('读本机应用文件')
})

test('authorities 为空集时显示"不需要额外权限"', () => {
  render(<AcknowledgeDialog pending={pending({ metadata: { executionPath: 'direct-node', authorities: [], exposure: 'public', effects: [], credentialFlow: 'none', residues: [] } })} onConfirmed={() => {}} onCancel={() => {}} />)
  expect(screen.getByTestId('ack-authorities')).toHaveTextContent('不需要额外权限')
})

test('文案说清"这次将允许什么"而非"点确定继续"', () => {
  render(<AcknowledgeDialog pending={pending()} onConfirmed={() => {}} onCancel={() => {}} />)
  expect(screen.getByText(/本命令将被允许按以上范围执行一次/)).toBeInTheDocument()
  expect(screen.getByText(/这不是一次安全授权/)).toBeInTheDocument()
})

test('点取消:调用 onCancel,不写入 preferences', async () => {
  const onCancel = vi.fn()
  render(<AcknowledgeDialog pending={pending()} onConfirmed={() => {}} onCancel={onCancel} />)
  await userEvent.click(screen.getByTestId('ack-cancel'))
  expect(onCancel).toHaveBeenCalledOnce()
  expect(useAppStore.getState().preferences.acknowledgements).toEqual([])
})

test('点确认执行(持久化成功):写入 preferences 并调用 onConfirmed,不显示会话提示', async () => {
  const onConfirmed = vi.fn()
  render(<AcknowledgeDialog pending={pending()} onConfirmed={onConfirmed} onCancel={() => {}} />)
  await userEvent.click(screen.getByTestId('ack-confirm'))
  expect(useAppStore.getState().preferences.acknowledgements).toEqual([
    { commandKey: cmd.command, fingerprint: 'fp-1', acknowledgedAt: expect.any(Number) },
  ])
  expect(onConfirmed).toHaveBeenCalledOnce()
  expect(screen.queryByTestId('ack-session-only')).not.toBeInTheDocument()
})

test('storage 写入失败:先提示"本次会话有效"且不立即调用 onConfirmed,再次点击才继续', async () => {
  const onConfirmed = vi.fn()
  const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
  try {
    render(<AcknowledgeDialog pending={pending()} onConfirmed={onConfirmed} onCancel={() => {}} />)
    await userEvent.click(screen.getByTestId('ack-confirm'))
    expect(screen.getByTestId('ack-session-only')).toBeInTheDocument()
    expect(onConfirmed).not.toHaveBeenCalled()
    // 内存态已写入(IO 边界降级,不等于未确认)
    expect(useAppStore.getState().preferences.acknowledgements).toHaveLength(1)

    await userEvent.click(screen.getByTestId('ack-confirm'))   // 按钮此时文案已变"知道了，继续运行"
    expect(onConfirmed).toHaveBeenCalledOnce()
  } finally {
    setItemSpy.mockRestore()
  }
})
