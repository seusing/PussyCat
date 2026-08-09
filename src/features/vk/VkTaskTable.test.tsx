import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { VkJobRow } from '../../host/vkClient'
import { VkTaskTable, type VkTaskTableProps } from './VkTaskTable'

const JOBS: VkJobRow[] = [
  {
    job_id: 'job-running',
    kind: 'process',
    status: 'running',
    submitted_at: '2026-08-07T08:00:00.000Z',
    finished_at: null,
    parent_job_id: null,
    cache_bypass: false,
  },
  {
    job_id: 'job-done',
    kind: 'process',
    status: 'done',
    submitted_at: '2026-08-07T08:01:00.000Z',
    finished_at: '2026-08-07T08:03:05.000Z',
    parent_job_id: null,
    cache_bypass: false,
  },
  {
    job_id: 'job-failed',
    kind: 'process',
    status: 'failed',
    submitted_at: '2026-08-07T08:04:00.000Z',
    finished_at: '2026-08-07T08:04:09.000Z',
    parent_job_id: null,
    cache_bypass: false,
  },
]

function makeProps(overrides: Partial<VkTaskTableProps> = {}): VkTaskTableProps {
  return {
    jobs: JOBS,
    notifications: { 'job-running': true },
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    onToggleNotification: vi.fn(),
    onCopyPath: vi.fn(),
    onCopyFileName: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  }
}

describe('VkTaskTable', () => {
  it('renders a semantic table with the required columns and normalized status badges', () => {
    render(<VkTaskTable {...makeProps()} />)

    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      '任务编号',
      '任务开始时间',
      '耗时',
      '任务状态',
      '操作',
    ])
    expect(screen.getAllByTestId('vk-job-row')).toHaveLength(3)
    expect(screen.getByText('正在执行')).toHaveAttribute('data-status', 'running')
    expect(screen.getByText('已完成')).toHaveAttribute('data-status', 'completed')
    expect(screen.getByText('失败')).toHaveAttribute('data-status', 'failed')
    expect(screen.getByText('2m5s')).toBeInTheDocument()
  })

  it('distinguishes rerun and interrupted states from ordinary execution', () => {
    render(<VkTaskTable {...makeProps({
      jobs: [
        { ...JOBS[0], job_id: 'retry-child', parent_job_id: 'job-failed' },
        { ...JOBS[1], job_id: 'cancelled', status: 'cancelled' },
      ],
    })} />)

    expect(screen.getByText('重跑中')).toHaveAttribute('data-status', 'rerunning')
    expect(screen.getByText('已中断')).toHaveAttribute('data-status', 'interrupted')
  })

  it('selects a row by click and keyboard', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<VkTaskTable {...makeProps({ onSelect, selectedJobId: 'job-done' })} />)

    const rows = screen.getAllByTestId('vk-job-row')
    expect(rows[1]).toHaveAttribute('aria-selected', 'true')
    await user.click(rows[0])
    expect(onSelect).toHaveBeenLastCalledWith(JOBS[0])
    rows[1].focus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenLastCalledWith(JOBS[1])
  })

  it('keeps the split-button primary action separate from the dropdown', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const onSelect = vi.fn()
    const onCopyPath = vi.fn()
    const onCopyFileName = vi.fn()
    render(<VkTaskTable {...makeProps({ onOpen, onSelect, onCopyPath, onCopyFileName })} />)

    await user.click(screen.getByTestId('vk-job-open-job-running'))
    expect(onOpen).toHaveBeenCalledWith(JOBS[0])
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '任务 1 更多操作' }))
    const menu = screen.getByRole('menu')
    expect(onOpen).toHaveBeenCalledTimes(1)
    await user.click(within(menu).getByRole('menuitem', { name: '复制路径' }))
    expect(onCopyPath).toHaveBeenCalledWith(JOBS[0])
    expect(onSelect).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '任务 1 更多操作' }))
    await user.click(screen.getByRole('menuitem', { name: '复制文件名' }))
    expect(onCopyFileName).toHaveBeenCalledWith(JOBS[0])
  })

  it('toggles an individual notification without selecting its row', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const onToggleNotification = vi.fn()
    render(<VkTaskTable {...makeProps({ onSelect, onToggleNotification })} />)

    const enabled = screen.getByRole('switch', { name: '关闭任务 1 完成通知' })
    expect(enabled).toBeChecked()
    await user.click(enabled)
    expect(onToggleNotification).toHaveBeenCalledWith('job-running', false)
    expect(onSelect).not.toHaveBeenCalled()

    await user.click(screen.getByRole('switch', { name: '开启任务 2 完成通知' }))
    expect(onToggleNotification).toHaveBeenLastCalledWith('job-done', true)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('requires confirmation before deleting and supports cancel and keyboard confirmation', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    render(<VkTaskTable {...makeProps({ onDelete })} />)

    await user.click(screen.getByRole('button', { name: '任务 3 更多操作' }))
    await user.click(screen.getByRole('menuitem', { name: '删除执行记录' }))
    const firstDialog = screen.getByRole('alertdialog')
    expect(onDelete).not.toHaveBeenCalled()
    expect(within(firstDialog).getByRole('button', { name: '取消' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(onDelete).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '任务 3 更多操作' }))
    await user.click(screen.getByRole('menuitem', { name: '删除执行记录' }))
    const confirm = within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认删除' })
    confirm.focus()
    await user.keyboard('{Enter}')
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith(JOBS[2])
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})
