import userEvent from '@testing-library/user-event'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { AnimatePresence } from 'motion/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmPopover } from './ConfirmPopover'

function Harness({ onConfirm = () => {}, onCancel = () => {} }: { onConfirm?: () => void; onCancel?: () => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <button type="button" onClick={(event) => setAnchor(event.currentTarget)}>触发</button>
      <button type="button">别处</button>
      <AnimatePresence>
        {anchor && (
          <ConfirmPopover
            key="popover"
            anchor={anchor}
            title="重新提交 2 个小任务？"
            body={['第一行说明', '第二行说明']}
            confirmLabel="确认重新提交"
            onConfirm={() => { setAnchor(null); onConfirm() }}
            onCancel={() => { setAnchor(null); onCancel() }}
          />
        )}
      </AnimatePresence>
    </>
  )
}

async function openPopover(props: Parameters<typeof Harness>[0] = {}) {
  const user = userEvent.setup()
  render(<Harness {...props} />)
  const trigger = screen.getByRole('button', { name: '触发' })
  await user.click(trigger)
  await screen.findByRole('alertdialog')
  return { user, trigger }
}

const closed = () => waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ConfirmPopover', () => {
  it('以 alertdialog 渲染到 body 下,标题和正文分别由 aria-labelledby / aria-describedby 指向', async () => {
    await openPopover()
    const dialog = screen.getByRole('alertdialog')

    expect(dialog.parentElement).toBe(document.body)
    expect(dialog).toHaveClass('glass-menu-effect')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)).toHaveTextContent('重新提交 2 个小任务？')
    const described = document.getElementById(dialog.getAttribute('aria-describedby')!)!
    expect(described).toHaveTextContent('第一行说明')
    expect(described).toHaveTextContent('第二行说明')
    expect(described.querySelectorAll('p')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认重新提交' })).toBeInTheDocument()
  })

  it('用 positionMenu 贴着触发按钮定位', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: '触发' })
    trigger.getBoundingClientRect = () => ({
      top: 70, bottom: 100, left: 40, right: 140, width: 100, height: 30, x: 40, y: 70, toJSON: () => ({}),
    })
    await user.click(trigger)

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.style.left).toBe('40px')
    expect(dialog.style.top).toBe('106px')
  })

  it('打开后焦点落在「取消」', async () => {
    await openPopover()
    await waitFor(() => expect(screen.getByRole('button', { name: '取消' })).toHaveFocus())
  })

  it('Esc 取消、焦点回到触发按钮,且不冒泡到全局 Esc', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const windowKeyDown = vi.fn()
    window.addEventListener('keydown', windowKeyDown)
    const { user, trigger } = await openPopover({ onCancel, onConfirm })
    await waitFor(() => expect(screen.getByRole('button', { name: '取消' })).toHaveFocus())

    await user.keyboard('{Escape}')

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(windowKeyDown).not.toHaveBeenCalled()
    await closed()
    expect(trigger).toHaveFocus()
    window.removeEventListener('keydown', windowKeyDown)
  })

  it('点「取消」只回调 onCancel,焦点回到触发按钮', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const { user, trigger } = await openPopover({ onCancel, onConfirm })

    await user.click(screen.getByRole('button', { name: '取消' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    await closed()
    expect(trigger).toHaveFocus()
  })

  it('点外部取消:点到页面空白处焦点回到触发按钮,点到别的按钮则让它保留焦点', async () => {
    const onCancel = vi.fn()
    const first = await openPopover({ onCancel })
    await first.user.click(document.body)
    expect(onCancel).toHaveBeenCalledTimes(1)
    await closed()
    await waitFor(() => expect(first.trigger).toHaveFocus())

    await first.user.click(first.trigger)
    await screen.findByRole('alertdialog')
    const other = screen.getByRole('button', { name: '别处' })
    await first.user.click(other)
    expect(onCancel).toHaveBeenCalledTimes(2)
    await closed()
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    expect(other).toHaveFocus()
  })

  it('点气泡内部或触发按钮本身不算点外部', async () => {
    const onCancel = vi.fn()
    const { user, trigger } = await openPopover({ onCancel })

    await user.click(screen.getByText('第一行说明'))
    await user.click(trigger)

    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('点确认只回调 onConfirm,焦点回到触发按钮', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const { user, trigger } = await openPopover({ onCancel, onConfirm })

    await user.click(screen.getByRole('button', { name: '确认重新提交' }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    await closed()
    expect(trigger).toHaveFocus()
  })
})
