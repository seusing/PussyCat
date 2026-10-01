import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AcknowledgeDialog, type PendingAcknowledgement } from './AcknowledgeDialog'
import type { CommandManifest } from '../../data/types'

const cmd: CommandManifest = {
  command: 'antigravity/recent-paths', site: 'antigravity', name: 'recent-paths',
  description: '读取 Antigravity 最近打开的路径', access: 'read', browser: false, args: [],
}

const pending = (): PendingAcknowledgement => ({
  command: cmd,
  decision: {
    commandKey: cmd.command, state: 'ready' as const, decisionSource: 'legacy-baseline' as const,
  },
})

test('pending 为空时不渲染', () => {
  render(<AcknowledgeDialog pending={undefined} onConfirmed={() => {}} onCancel={() => {}} />)
  expect(screen.queryByTestId('acknowledge-dialog')).not.toBeInTheDocument()
})

test('展示标题和站点·命令名副标题', () => {
  render(<AcknowledgeDialog pending={pending()} onConfirmed={() => {}} onCancel={() => {}} />)
  expect(screen.getByText('是否确认提交？')).toBeInTheDocument()
  expect(screen.getByText(/antigravity.*recent-paths/)).toBeInTheDocument()
})

test('点取消:调用 onCancel', async () => {
  const onCancel = vi.fn()
  render(<AcknowledgeDialog pending={pending()} onConfirmed={() => {}} onCancel={onCancel} />)
  await userEvent.click(screen.getByTestId('ack-cancel'))
  expect(onCancel).toHaveBeenCalledOnce()
})

test('点确认:调用 onConfirmed', async () => {
  const onConfirmed = vi.fn()
  render(<AcknowledgeDialog pending={pending()} onConfirmed={onConfirmed} onCancel={() => {}} />)
  await userEvent.click(screen.getByTestId('ack-confirm'))
  expect(onConfirmed).toHaveBeenCalledOnce()
})

test('按 Escape 键:调用 onCancel', async () => {
  const onCancel = vi.fn()
  render(<AcknowledgeDialog pending={pending()} onConfirmed={() => {}} onCancel={onCancel} />)
  await userEvent.keyboard('{Escape}')
  expect(onCancel).toHaveBeenCalledOnce()
})

test('点遮罩层:调用 onCancel', async () => {
  const onCancel = vi.fn()
  render(<AcknowledgeDialog pending={pending()} onConfirmed={() => {}} onCancel={onCancel} />)
  // 点遮罩层（dialog 外区域）关闭
  const dialog = screen.getByTestId('acknowledge-dialog')
  const backdrop = dialog.parentElement!
  await userEvent.click(backdrop)
  expect(onCancel).toHaveBeenCalledOnce()
})

test('点对话框内部不关闭', async () => {
  const onCancel = vi.fn()
  render(<AcknowledgeDialog pending={pending()} onConfirmed={() => {}} onCancel={onCancel} />)
  await userEvent.click(screen.getByTestId('acknowledge-dialog'))
  expect(onCancel).not.toHaveBeenCalled()
})

test('打开时焦点在「确认提交」,回车即确认', async () => {
  const onConfirmed = vi.fn()
  render(<AcknowledgeDialog pending={pending()} onConfirmed={onConfirmed} onCancel={() => {}} />)
  expect(screen.getByTestId('ack-confirm')).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  expect(onConfirmed).toHaveBeenCalledOnce()
})

test('Esc 只取消确认框,不冒泡到 window 上的全局热键', async () => {
  const onCancel = vi.fn()
  const onWindowKey = vi.fn()
  window.addEventListener('keydown', onWindowKey)
  try {
    render(<AcknowledgeDialog pending={pending()} onConfirmed={() => {}} onCancel={onCancel} />)
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onWindowKey).not.toHaveBeenCalled()
  } finally {
    window.removeEventListener('keydown', onWindowKey)
  }
})

test('点到卡片空白处后按 Esc 仍能取消', async () => {
  const onCancel = vi.fn()
  render(<AcknowledgeDialog pending={pending()} onConfirmed={() => {}} onCancel={onCancel} />)
  await userEvent.click(screen.getByText('是否确认提交？'))
  await userEvent.keyboard('{Escape}')
  expect(onCancel).toHaveBeenCalledOnce()
})

test('关闭后焦点回到打开前的元素', () => {
  const { rerender } = render(
    <>
      <button data-testid="opener">提交</button>
      <AcknowledgeDialog pending={undefined} onConfirmed={() => {}} onCancel={() => {}} />
    </>,
  )
  screen.getByTestId('opener').focus()
  rerender(
    <>
      <button data-testid="opener">提交</button>
      <AcknowledgeDialog pending={pending()} onConfirmed={() => {}} onCancel={() => {}} />
    </>,
  )
  expect(screen.getByTestId('ack-confirm')).toHaveFocus()
  rerender(
    <>
      <button data-testid="opener">提交</button>
      <AcknowledgeDialog pending={undefined} onConfirmed={() => {}} onCancel={() => {}} />
    </>,
  )
  expect(screen.getByTestId('opener')).toHaveFocus()
})
