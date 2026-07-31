import { render, fireEvent, screen } from '@testing-library/react'
import ResizableSplit from './ResizableSplit'

// jsdom(本仓 vitest 环境,见 vite.config.ts)没有实现 window.PointerEvent 构造器(截至 jsdom 25.x)。
// @testing-library 的 fireEvent.pointerDown/Move/Up 便捷方法在探测到 window.PointerEvent 缺失时会
// 静默回退到裸 Event 构造器,导致 clientX 等字段被丢弃(裸 Event 的 EventInit 字典不识别 clientX)。
// 因此这里手动构造 MouseEvent 并把 .type 指定成 pointerXxx——MouseEvent 是 jsdom 原生支持的构造器,
// 会正确应用 clientX/button,而事件类型字符串是运行期分发依据,与用来构造它的 JS 类无关,
// 足以驱动 React 的 onPointerDown/组件内部的 window.addEventListener('pointermove', ...)。
function pointerEvent(type: 'pointerdown' | 'pointermove' | 'pointerup', init: { clientX: number; button?: number }) {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.clientX, button: init.button ?? 0 })
}

function renderHandle(overrides: Partial<Parameters<typeof ResizableSplit>[0]> = {}) {
  const onResize = vi.fn()
  const onCommit = vi.fn()
  const props = {
    value: 280, side: 'left' as const, min: 200, max: 480, defaultValue: 280,
    onResize, onCommit, ariaLabel: '调整导航栏宽度', testId: 'sep',
    ...overrides,
  }
  render(<ResizableSplit {...props} />)
  return { onResize, onCommit, handle: screen.getByTestId(props.testId) }
}

afterEach(() => {
  // 部分用例故意不走到 pointerup(测试"卸载时收尾"),须防止残留污染其它用例的 body 样式
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

test('渲染:role/aria-orientation/tabIndex/aria-value* 齐全', () => {
  const { handle } = renderHandle({ value: 300, min: 200, max: 480 })
  expect(handle).toHaveAttribute('role', 'separator')
  expect(handle).toHaveAttribute('aria-orientation', 'vertical')
  expect(handle).toHaveAttribute('tabindex', '0')
  expect(handle).toHaveAttribute('aria-valuenow', '300')
  expect(handle).toHaveAttribute('aria-valuemin', '200')
  expect(handle).toHaveAttribute('aria-valuemax', '480')
  expect(handle).toHaveAttribute('aria-label', '调整导航栏宽度')
})

test('拖拽(side=left):向右移动 → onResize 收到 value+增量', () => {
  const { onResize, handle } = renderHandle({ value: 280, side: 'left' })
  fireEvent(handle, pointerEvent('pointerdown', { clientX: 100 }))
  fireEvent(window, pointerEvent('pointermove', { clientX: 150 }))
  expect(onResize).toHaveBeenCalledWith(330)   // 280 + (150-100)
  fireEvent(window, pointerEvent('pointermove', { clientX: 80 }))
  expect(onResize).toHaveBeenCalledWith(260)   // 280 + (80-100)
})

test('拖拽(side=right):向右移动 → onResize 收到 value-增量(符号相反)', () => {
  const { onResize, handle } = renderHandle({ value: 360, side: 'right' })
  fireEvent(handle, pointerEvent('pointerdown', { clientX: 100 }))
  fireEvent(window, pointerEvent('pointermove', { clientX: 150 }))
  expect(onResize).toHaveBeenCalledWith(310)   // 360 - (150-100)
})

test('松手(pointerup) → onCommit 触发一次;此后 pointermove 不再触发 onResize(拖拽会话已结束)', () => {
  const { onResize, onCommit, handle } = renderHandle({ value: 280 })
  fireEvent(handle, pointerEvent('pointerdown', { clientX: 100 }))
  fireEvent(window, pointerEvent('pointermove', { clientX: 150 }))
  expect(onCommit).not.toHaveBeenCalled()
  fireEvent(window, pointerEvent('pointerup', { clientX: 150 }))
  expect(onCommit).toHaveBeenCalledTimes(1)
  onResize.mockClear()
  fireEvent(window, pointerEvent('pointermove', { clientX: 200 }))
  expect(onResize).not.toHaveBeenCalled()
})

test('拖拽期间 document.body 加 col-resize 光标 + 禁选中,松手后还原', () => {
  const { handle } = renderHandle()
  expect(document.body.style.cursor).toBe('')
  fireEvent(handle, pointerEvent('pointerdown', { clientX: 100 }))
  expect(document.body.style.cursor).toBe('col-resize')
  expect(document.body.style.userSelect).toBe('none')
  fireEvent(window, pointerEvent('pointerup', { clientX: 100 }))
  expect(document.body.style.cursor).toBe('')
  expect(document.body.style.userSelect).toBe('')
})

test('卸载时若仍在拖拽中 → 清理 effect 照样还原 body 样式(不留污染)', () => {
  const onResize = vi.fn(); const onCommit = vi.fn()
  const { unmount } = render(
    <ResizableSplit value={280} side="left" min={200} max={480} defaultValue={280}
      onResize={onResize} onCommit={onCommit} ariaLabel="x" testId="sep" />
  )
  fireEvent(screen.getByTestId('sep'), pointerEvent('pointerdown', { clientX: 100 }))
  expect(document.body.style.cursor).toBe('col-resize')
  unmount()
  expect(document.body.style.cursor).toBe('')
  expect(document.body.style.userSelect).toBe('')
})

test('非主键(右键 button=2)按下 → 不开启拖拽会话,后续 pointermove 不触发 onResize', () => {
  const { onResize, handle } = renderHandle()
  fireEvent(handle, pointerEvent('pointerdown', { clientX: 100, button: 2 }))
  expect(document.body.style.cursor).toBe('')   // 侧面印证:根本没进入 dragging 态
  fireEvent(window, pointerEvent('pointermove', { clientX: 200 }))
  expect(onResize).not.toHaveBeenCalled()
})

test('键盘:ArrowRight/ArrowLeft 各调 16px,side=left 与 side=right 符号相反,且各触发一次 onCommit', () => {
  const left = renderHandle({ value: 280, side: 'left' })
  fireEvent.keyDown(left.handle, { key: 'ArrowRight' })
  expect(left.onResize).toHaveBeenCalledWith(296)
  expect(left.onCommit).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(left.handle, { key: 'ArrowLeft' })
  expect(left.onResize).toHaveBeenCalledWith(264)
  expect(left.onCommit).toHaveBeenCalledTimes(2)

  const right = renderHandle({ value: 360, side: 'right', testId: 'sep-r' })
  fireEvent.keyDown(right.handle, { key: 'ArrowRight' })
  expect(right.onResize).toHaveBeenCalledWith(344)   // 符号相反:右键控制的面板在分隔条左边,视觉右移=面板变窄
  fireEvent.keyDown(right.handle, { key: 'ArrowLeft' })
  expect(right.onResize).toHaveBeenCalledWith(376)
})

test('键盘:Home/End 送 ∓Infinity(父组件夹到各自 min/max),并各触发 onCommit', () => {
  const { onResize, onCommit, handle } = renderHandle({ value: 280 })
  fireEvent.keyDown(handle, { key: 'Home' })
  expect(onResize).toHaveBeenCalledWith(-Infinity)
  fireEvent.keyDown(handle, { key: 'End' })
  expect(onResize).toHaveBeenCalledWith(Infinity)
  expect(onCommit).toHaveBeenCalledTimes(2)
})

test('双击 → onResize(defaultValue) + onCommit', () => {
  const { onResize, onCommit, handle } = renderHandle({ value: 400, defaultValue: 280 })
  fireEvent.doubleClick(handle)
  expect(onResize).toHaveBeenCalledWith(280)
  expect(onCommit).toHaveBeenCalledTimes(1)
})
