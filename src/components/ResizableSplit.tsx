import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'

const KEY_STEP = 16
const HANDLE_WIDTH = 9   // 命中区宽度(px,≥6px 底线);内部视觉线是子元素的 1px,居中于此区域

// 可拖拽 + 可键盘调整的竖直分隔条。纯"手势 → 提议数值"转换器:不知道、也不做 min/max 夹取——
// 提议值原样上抛给 onResize,由父组件(持有布局约束与容器宽度信息)决定是否采纳/夹取/写状态。
// 这样它能在 nav|config、config|runs 两处原样复用,自身也完全不读取任何 DOM 尺寸,
// 不受 jsdom 测试环境里 getBoundingClientRect 恒返回 0 的影响。
export default function ResizableSplit({
  value, side, min, max, defaultValue, onResize, onCommit, ariaLabel, testId, disabled = false,
}: {
  value: number
  side: 'left' | 'right'    // 该分隔条控制的面板在分隔条的左侧还是右侧;决定拖拽位移/方向键步进到"增长量"的符号换算
  min: number
  max: number
  defaultValue: number
  onResize: (proposed: number) => void   // 连续调用(拖拽中的每次 pointermove、每次键盘步进);父组件负责夹取+落状态
  onCommit: () => void                    // 一次交互结束时调用一次(松手 / 每次键盘步进后 / 双击后);父组件负责落盘
  ariaLabel: string
  testId?: string
  disabled?: boolean
}) {
  const [dragging, setDragging] = useState(false)
  const startRef = useRef({ x: 0, value: 0 })

  useEffect(() => {
    if (!dragging || disabled) return
    const toGrowth = (rawDx: number) => (side === 'left' ? rawDx : -rawDx)
    const onMove = (e: PointerEvent) => {
      onResize(startRef.current.value + toGrowth(e.clientX - startRef.current.x))
    }
    const onUp = () => { setDragging(false); onCommit() }
    // 挂在 window 上而不是元素自身:命中区只有 9px,快速拖拽时指针很容易跑出这条窄带,
    // 挂在元素上的 onPointerMove 会"丢手"。jsdom 不支持 setPointerCapture(见组件测试注释),
    // window 级监听在生产环境和测试环境下行为一致,无需依赖指针捕获。
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
    }
  }, [dragging, disabled, side, onResize, onCommit])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return   // 禁用时保留布局槽,但不再启动拖拽
    // 只认主键(鼠标左键;触控/笔尖接触在 Pointer Events 里同样报 0);右键菜单等不触发拖拽
    e.preventDefault()           // 压掉可能的原生拖拽/文字选中起手
    e.currentTarget.focus()      // 上面这行会顺带压掉浏览器默认的"pointerdown 自动聚焦",这里手动补回
    startRef.current = { x: e.clientX, value }
    setDragging(true)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const growthFor = (rawDx: number) => (side === 'left' ? rawDx : -rawDx)
    if (e.key === 'ArrowLeft') { e.preventDefault(); onResize(value + growthFor(-KEY_STEP)); onCommit(); return }
    if (e.key === 'ArrowRight') { e.preventDefault(); onResize(value + growthFor(KEY_STEP)); onCommit(); return }
    // Home/End 用 ±Infinity 表达"跳到下限/上限":父组件的 clamp 会自然把它们夹到各自的 min/max,
    // 本组件不需要知道具体数值边界。
    if (e.key === 'Home') { e.preventDefault(); onResize(-Infinity); onCommit(); return }
    if (e.key === 'End') { e.preventDefault(); onResize(Infinity); onCommit(); return }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      data-dragging={dragging}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => { if (!disabled) { onResize(defaultValue); onCommit() } }}
      className="resize-handle relative z-10 shrink-0"
      style={{ width: disabled ? 0 : HANDLE_WIDTH, cursor: disabled ? 'default' : 'col-resize', touchAction: 'none' }}
      aria-hidden={disabled || undefined}
      data-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
    >
      <div className="resize-handle-line pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2" />
    </div>
  )
}
