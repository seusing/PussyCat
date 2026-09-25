import userEvent from '@testing-library/user-event'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VkResultActions } from './VkResultActions'
import type { VkTaskResultGroup } from './taskResults'

afterEach(cleanup)

function group(ordinal: number, ids: string[]): VkTaskResultGroup {
  return {
    id: `group-${ordinal}`, ordinal, source: `https://example.com/${ordinal}`, jobIds: ids,
    versions: ids.map((jobId, index) => ({ jobId, attempt: ids.length - index, submittedAt: '2026-09-03T00:00:00Z', status: 'done' })),
  }
}

describe('VkResultActions', () => {
  it('hides actions when no member has a result and opens the current context for one result', async () => {
    const onOpen = vi.fn()
    const { rerender } = render(<VkResultActions groups={[group(1, [])]} onOpen={onOpen} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    rerender(<VkResultActions groups={[group(1, ['latest'])]} onOpen={onOpen} />)
    await userEvent.click(screen.getByRole('button', { name: '查看解析结果' }))
    expect(onOpen).toHaveBeenCalledWith()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('opens the selected historical job and resets selection for repeated access', async () => {
    const onOpen = vi.fn()
    render(<VkResultActions groups={[group(1, ['latest', 'old'])]} onOpen={onOpen} />)
    const select = screen.getByRole('combobox', { name: '查看历史结果' })
    await userEvent.click(select)
    expect(screen.getByRole('option', { name: /第 2 次.*最新结果/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('option', { name: /第 1 次/ }))
    expect(onOpen).toHaveBeenLastCalledWith('old')
    expect(select).toHaveAttribute('data-value', '')
    await userEvent.click(select)
    await userEvent.click(screen.getByRole('option', { name: /第 1 次/ }))
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it('groups options by stable member ordinal including a later member with a single result', async () => {
    render(<VkResultActions groups={[group(1, []), group(2, ['new-two', 'old-two']), group(3, ['only-three'])]} onOpen={() => {}} />)
    const select = screen.getByRole('combobox')
    await userEvent.click(select)
    expect(screen.queryByText('小任务1')).not.toBeInTheDocument()
    expect(screen.getByText('小任务2')).toBeInTheDocument()
    expect(screen.getByText('小任务3')).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(4)
  })
})
