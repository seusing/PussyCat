import userEvent from '@testing-library/user-event'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { AnimatePresence } from 'motion/react'
import { useState, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpencliReleasePanel } from './OpencliReleasePanel'

type PanelProps = Partial<Omit<ComponentProps<typeof OpencliReleasePanel>, 'anchor'>>

function Harness({ onClose = () => {}, ...props }: PanelProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <button type="button" onClick={(event) => setAnchor(event.currentTarget)}>触发</button>
      <button type="button">别处</button>
      <AnimatePresence>
        {anchor && (
          <OpencliReleasePanel
            key="panel"
            anchor={anchor}
            checkText="刚刚检查"
            busy={false}
            onCheck={() => {}}
            onRollback={() => {}}
            {...props}
            onClose={() => { setAnchor(null); onClose() }}
          />
        )}
      </AnimatePresence>
    </>
  )
}

async function openPanel(props: PanelProps = {}) {
  const user = userEvent.setup()
  render(<Harness {...props} />)
  const trigger = screen.getByRole('button', { name: '触发' })
  await user.click(trigger)
  await screen.findByRole('dialog')
  return { user, trigger }
}

const closed = () => waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('OpencliReleasePanel', () => {
  it('以带名字的 dialog 渲染到 body 下,材质沿用玻璃菜单', async () => {
    await openPanel()
    const dialog = screen.getByRole('dialog', { name: 'OpenCLI 版本' })

    expect(dialog.parentElement).toBe(document.body)
    expect(dialog).toHaveClass('glass-menu-effect')
  })

  it('只有「检查更新」一行时:没有内置版本、命令目录、发布说明', async () => {
    await openPanel({ checkText: '10:05 已检查' })
    const dialog = screen.getByRole('dialog')

    expect(within(dialog).getByTestId('opencli-release-checked-at')).toHaveTextContent('10:05 已检查')
    expect(within(dialog).getByRole('button', { name: '检查更新' })).toBeEnabled()
    expect(within(dialog).queryByTestId('rollback-opencli')).not.toBeInTheDocument()
    expect(within(dialog).queryByTestId('opencli-panel-catalog')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('link')).not.toBeInTheDocument()
  })

  it('给了内置版本、命令数、发布说明:三行都出现', async () => {
    await openPanel({ rollbackTo: '1.8.8', commandCount: 117, notes: { version: '2.0.2', url: 'https://example.com/v2.0.2' } })
    const dialog = screen.getByRole('dialog')

    expect(dialog).toHaveTextContent('内置版本 1.8.8')
    expect(within(dialog).getByRole('button', { name: '恢复内置版本' })).toHaveTextContent('恢复内置')
    expect(within(dialog).getByTestId('opencli-panel-catalog')).toHaveTextContent('命令目录 117 条')
    const link = within(dialog).getByRole('link', { name: '查看 2.0.2 发布说明' })
    expect(link).toHaveAttribute('href', 'https://example.com/v2.0.2')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('命令数是 0 也照样显示这一行', async () => {
    await openPanel({ commandCount: 0 })

    expect(screen.getByTestId('opencli-panel-catalog')).toHaveTextContent('命令目录 0 条')
  })

  it('用 positionMenu 贴着触发按钮定位', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: '触发' })
    trigger.getBoundingClientRect = () => ({
      top: 20, bottom: 50, left: 40, right: 340, width: 300, height: 30, x: 40, y: 20, toJSON: () => ({}),
    })
    await user.click(trigger)

    const dialog = await screen.findByRole('dialog')
    expect(dialog.style.left).toBe('40px')
    expect(dialog.style.top).toBe('56px')
  })

  it('打开后焦点落在「检查更新」', async () => {
    await openPanel({ rollbackTo: '1.8.8' })

    await waitFor(() => expect(screen.getByRole('button', { name: '检查更新' })).toHaveFocus())
  })

  it('Esc 关闭、焦点回到触发按钮,且不冒泡到全局 Esc', async () => {
    const onClose = vi.fn()
    const windowKeyDown = vi.fn()
    window.addEventListener('keydown', windowKeyDown)
    const { user, trigger } = await openPanel({ onClose })
    await waitFor(() => expect(screen.getByRole('button', { name: '检查更新' })).toHaveFocus())

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(windowKeyDown).not.toHaveBeenCalled()
    await closed()
    expect(trigger).toHaveFocus()
    window.removeEventListener('keydown', windowKeyDown)
  })

  it('点外部关闭:点到页面空白处焦点回到触发按钮,点到别的按钮则让它保留焦点;点面板里的空白不关', async () => {
    const onClose = vi.fn()
    const first = await openPanel({ onClose })
    await first.user.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()

    await first.user.click(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
    await closed()
    await waitFor(() => expect(first.trigger).toHaveFocus())

    await first.user.click(first.trigger)
    await screen.findByRole('dialog')
    const other = screen.getByRole('button', { name: '别处' })
    await first.user.click(other)
    expect(onClose).toHaveBeenCalledTimes(2)
    await closed()
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    expect(other).toHaveFocus()
  })

  it('点「检查更新」:先关面板、焦点回到触发按钮,再走 onCheck', async () => {
    const onCheck = vi.fn()
    const onRollback = vi.fn()
    const onClose = vi.fn()
    const { user, trigger } = await openPanel({ onCheck, onRollback, onClose, rollbackTo: '1.8.8' })

    await user.click(screen.getByRole('button', { name: '检查更新' }))

    expect(onCheck).toHaveBeenCalledTimes(1)
    expect(onRollback).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
    await closed()
    expect(trigger).toHaveFocus()
  })

  it('点「恢复内置」:关面板并走 onRollback', async () => {
    const onCheck = vi.fn()
    const onRollback = vi.fn()
    const onClose = vi.fn()
    const { user, trigger } = await openPanel({ onCheck, onRollback, onClose, rollbackTo: '1.8.8' })

    await user.click(screen.getByRole('button', { name: '恢复内置版本' }))

    expect(onRollback).toHaveBeenCalledTimes(1)
    expect(onCheck).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
    await closed()
    expect(trigger).toHaveFocus()
  })

  it('请求在途(busy)时「恢复内置」不可点,「检查更新」仍可点', async () => {
    const onRollback = vi.fn()
    const { user } = await openPanel({ busy: true, rollbackTo: '1.8.8', onRollback })

    expect(screen.getByRole('button', { name: '恢复内置版本' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '恢复内置版本' }))
    expect(onRollback).not.toHaveBeenCalled()
  })
})
