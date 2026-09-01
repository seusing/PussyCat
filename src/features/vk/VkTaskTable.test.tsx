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

function manyJobs(count: number): VkJobRow[] {
  return Array.from({ length: count }, (_, index) => ({
    job_id: `job-${index}`,
    kind: 'process',
    status: index % 2 === 0 ? 'done' : 'failed',
    submitted_at: new Date(Date.now() - index * 60_000).toISOString(),
    finished_at: new Date(Date.now() - index * 60_000 + 5_000).toISOString(),
    parent_job_id: null,
    cache_bypass: false,
  }))
}

function makeProps(overrides: Partial<VkTaskTableProps> = {}): VkTaskTableProps {
  return {
    jobs: JOBS,
    notifications: { 'job-running': true },
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    onToggleNotification: vi.fn(),
    onSave: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  }
}

describe('VkTaskTable', () => {
  it('renders a semantic table with the required columns and normalized status badges', () => {
    render(<VkTaskTable {...makeProps()} />)

    const table = screen.getByRole('table')
    // 「耗时」列去掉了:批量任务一行代表多个视频,那一列显示的是整批墙钟,很容易被
    // 读成"每条要跑这么久"。逐条耗时移到详情页,挂在各自的小任务下面。
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      '任务编号',
      '任务开始时间',
      '任务状态',
      '操作',
    ])
    expect(screen.getAllByTestId('vk-job-row')).toHaveLength(3)
    // 状态徽章的文字与筛选下拉的选项同名,断言要限定在表格里,否则会同时命中两处。
    expect(within(table).getByText('正在执行')).toHaveAttribute('data-status', 'running')
    expect(within(table).getByText('已完成')).toHaveAttribute('data-status', 'completed')
    expect(within(table).getByText('失败')).toHaveAttribute('data-status', 'failed')
  })

  it('distinguishes rerun and interrupted states from ordinary execution', () => {
    render(<VkTaskTable {...makeProps({
      jobs: [
        { ...JOBS[0], job_id: 'retry-child', parent_job_id: 'job-failed' },
        { ...JOBS[1], job_id: 'cancelled', status: 'cancelled' },
      ],
    })} />)

    const table = screen.getByRole('table')
    expect(within(table).getByText('重跑中')).toHaveAttribute('data-status', 'rerunning')
    expect(within(table).getByText('已中断')).toHaveAttribute('data-status', 'interrupted')
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
    const onSave = vi.fn()
    render(<VkTaskTable {...makeProps({ onOpen, onSelect, onSave })} />)

    await user.click(screen.getByTestId('vk-job-open-job-running'))
    expect(onOpen).toHaveBeenCalledWith(JOBS[0])
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '任务 2 更多操作' }))
    const menu = screen.getByRole('menu')
    expect(onOpen).toHaveBeenCalledTimes(1)
    await user.click(within(menu).getByRole('menuitem', { name: '存到本地' }))
    expect(onSave).toHaveBeenCalledWith(JOBS[1])
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('disables saving when a task has no successful output', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<VkTaskTable {...makeProps({ onSave })} />)

    await user.click(screen.getByRole('button', { name: '任务 3 更多操作' }))
    const menu = screen.getByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: '存到本地' })).toBeDisabled()
    expect(onSave).not.toHaveBeenCalled()
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

  it('批量任务折成一行,条数退到悬停提示里不占列宽', () => {
    // 徽标原先直接印在编号列,把列撑宽、日期挤到图标上,详情栏一开还把「任务状态」
    // 整列推出可视区。**状态是每行都要看的,条数不是** —— 列表这点宽度该留给前者,
    // 条数在详情页的「提交内容」里本来就写着。
    const members: VkJobRow[] = [
      { ...JOBS[0], job_id: 'b-1', batch_id: 'batch-x' },
      { ...JOBS[1], job_id: 'b-2', batch_id: 'batch-x' },
    ]
    render(<VkTaskTable {...makeProps({
      jobs: [{ ...members[0], batchMembers: members }],
    })} />)

    expect(screen.getAllByTestId('vk-job-row')).toHaveLength(1)
    expect(screen.queryByText('2 个视频')).not.toBeInTheDocument()
    expect(screen.getByTitle('本次提交包含 2 个视频')).toBeInTheDocument()
  })

  it('单条任务不显示视频数徽章', () => {
    render(<VkTaskTable {...makeProps({ jobs: [JOBS[0]] })} />)

    expect(screen.queryByText(/个视频$/)).not.toBeInTheDocument()
  })

  it('默认每页 10 条并能翻页', async () => {
    render(<VkTaskTable {...makeProps({ jobs: manyJobs(25) })} />)

    expect(screen.getAllByTestId('vk-job-row')).toHaveLength(10)
    expect(screen.getByTestId('vk-task-table-page')).toHaveTextContent('第 1 / 3 页')

    await userEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getByTestId('vk-task-table-page')).toHaveTextContent('第 2 / 3 页')
    await userEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getAllByTestId('vk-job-row')).toHaveLength(5)   // 末页只剩 5 条
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
  })

  it('每页条数可切到全部,翻页条随之消失', async () => {
    render(<VkTaskTable {...makeProps({ jobs: manyJobs(25) })} />)

    await userEvent.selectOptions(screen.getByLabelText('每页展示条数'), 'all')

    expect(screen.getAllByTestId('vk-job-row')).toHaveLength(25)
    expect(screen.queryByTestId('vk-task-table-page')).not.toBeInTheDocument()
  })

  it('按状态筛选后回到第一页,并显示筛出条数', async () => {
    render(<VkTaskTable {...makeProps({ jobs: manyJobs(25) })} />)

    await userEvent.click(screen.getByRole('button', { name: '下一页' }))
    await userEvent.selectOptions(screen.getByLabelText('按任务状态筛选'), 'failed')

    // 25 条里单数下标是 failed,共 12 条;筛完必须回第 1 页,否则会停在一个已不存在的页上。
    expect(screen.getByTestId('vk-task-table-count')).toHaveTextContent('筛出 12 条 / 共 25 条')
    expect(screen.getByTestId('vk-task-table-page')).toHaveTextContent('第 1 / 2 页')
  })

  it('筛不出任何任务时给出与"暂无任务"不同的提示', async () => {
    render(<VkTaskTable {...makeProps({ jobs: JOBS })} />)

    await userEvent.selectOptions(screen.getByLabelText('按任务状态筛选'), 'interrupted')

    expect(screen.getByText('没有符合筛选条件的任务')).toBeInTheDocument()
    expect(screen.queryByText('暂无任务')).not.toBeInTheDocument()
  })
})
