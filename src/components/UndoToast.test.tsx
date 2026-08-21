import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UndoToast } from './UndoToast'
import { useAppStore } from '../store/appStore'

const initialState = useAppStore.getState()
beforeEach(() => { useAppStore.setState(initialState, true); localStorage.clear() })

test('lastUndo 为空时不渲染', () => {
  render(<UndoToast />)
  expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument()
})

test('取消站点收藏后显示 toast,点撤销回滚', async () => {
  useAppStore.getState().toggleSiteFavorite('x')   // 收藏
  useAppStore.getState().toggleSiteFavorite('x')   // 取消 → lastUndo
  render(<UndoToast />)
  expect(screen.getByTestId('undo-toast')).toBeInTheDocument()
  expect(within(screen.getByTestId('undo-toast')).getByRole('progressbar', { name: '通知剩余时间' })).toHaveClass('is-duration')
  await userEvent.click(screen.getByTestId('undo-button'))
  expect(useAppStore.getState().preferences.favoriteSites.map((f) => f.site)).toEqual(['x'])
  expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument()
})

test('通知固定显示三秒后自动关闭', () => {
  vi.useFakeTimers()
  useAppStore.getState().toggleSiteFavorite('x')
  useAppStore.getState().toggleSiteFavorite('x')
  render(<UndoToast />)

  act(() => { vi.advanceTimersByTime(2_999) })
  expect(screen.getByTestId('undo-toast')).toBeInTheDocument()
  act(() => { vi.advanceTimersByTime(1) })
  expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument()
  vi.useRealTimers()
})
