import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { HealthPill } from './HealthPill'
import { BrowserBridgeStatus } from './BrowserBridgeStatus'
import ResizableSplit from './ResizableSplit'
import {
  loadLayout, saveLayout, clampColumnWidth,
  NAV_MIN, NAV_MAX, NAV_DEFAULT, RUNS_MIN, RUNS_MAX, RUNS_DEFAULT, CONFIG_MIN,
} from '../data/layout'
import type { LayoutSnapshot } from '../data/layout'

export default function AppShell({ nav, config, runs, catalogStatus, catalogError, onRetryCatalog, headerActions, baseUrl }: {
  nav: ReactNode
  config: ReactNode
  runs: ReactNode
  catalogStatus: 'loading' | 'ready' | 'error'
  catalogError?: string
  onRetryCatalog: () => void
  headerActions?: ReactNode
  baseUrl?: string
}) {
  // 左右栏宽度。gridRef 用来在拖拽时按需读取容器实际像素宽,防止把中栏挤到 CONFIG_MIN 以下——
  // jsdom 测试环境里 getBoundingClientRect 恒返回 0,clampColumnWidth 会据此自动退化为只受
  // nav/runs 自身 min/max 约束(见该函数注释与其单测)。
  const gridRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<LayoutSnapshot>(() => loadLayout())   // 懒初始化,只读一次 localStorage
  // layoutRef 是"当前已提交宽度"的唯一事实源,由 propose* 用普通同步赋值维护——不依赖 setState(updater)
  // 里的 updater 函数何时执行。曾经踩过的坑:以为"updater 函数由 React 同步调用"能当作时序保证,
  // 但那只是 React 内部一个条件触发的优化(队列为空时才提前算),ResizableSplit 的键盘/双击路径
  // 在同一个事件里 onResize 后紧跟着同步调用 onCommit,一旦两次交互靠得太近导致队列非空,
  // updater 就会推迟到之后的渲染阶段才真正执行,commitLayout 那时读到的 layoutRef 还是上一步的
  // 旧值——真机上用 ArrowRight 紧接着 End 复现过(落盘值停在 ArrowRight 那步,End 的 560 丢了)。
  // 现在的写法:propose* 里不经过 setState 的 updater 参数,直接读 layoutRef.current 算出 next、
  // 同步写回 layoutRef,再把算好的值传给 setLayout 触发重渲染——正确性不再依赖 React 何时真正跑
  // 这次 setState,只依赖"我自己刚刚做的这次同步赋值",可验证、不猜。
  const layoutRef = useRef(layout)

  const proposeNav = useCallback((proposed: number) => {
    const next = { ...layoutRef.current, navWidth: clampColumnWidth(proposed, NAV_MIN, NAV_MAX, layoutRef.current.runsWidth, gridRef.current?.getBoundingClientRect().width ?? 0) }
    layoutRef.current = next
    setLayout(next)
  }, [])
  const proposeRuns = useCallback((proposed: number) => {
    const next = { ...layoutRef.current, runsWidth: clampColumnWidth(proposed, RUNS_MIN, RUNS_MAX, layoutRef.current.navWidth, gridRef.current?.getBoundingClientRect().width ?? 0) }
    layoutRef.current = next
    setLayout(next)
  }, [])
  // 拖拽/键盘步进过程中只更新 state(廉价);真正落盘只在一次交互结束时(松手/键后/双击后)调用一次,
  // 避免每个 pointermove 都写 localStorage。
  const commitLayout = useCallback(() => { saveLayout(layoutRef.current) }, [])

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2" style={{ borderColor: 'var(--color-line)' }}>
        <div className="font-semibold">OpenCLI App</div>
        <div className="flex items-center gap-3">
          {headerActions}
          <BrowserBridgeStatus baseUrl={baseUrl} />
          <HealthPill baseUrl={baseUrl} />
        </div>
      </header>

      {catalogStatus === 'loading' && (
        <div data-testid="catalog-loading" className="flex flex-1 items-center justify-center text-sm" style={{ color: 'var(--color-fg-dim)' }}>
          正在加载命令目录…
        </div>
      )}

      {catalogStatus === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm">
          <div style={{ color: 'var(--color-danger)' }}>{catalogError ?? '加载命令目录失败'}</div>
          <button
            data-testid="catalog-retry"
            onClick={onRetryCatalog}
            className="rounded-lg px-4 py-2 text-sm font-medium"
            style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}
          >
            重试
          </button>
        </div>
      )}

      {catalogStatus === 'ready' && (
        <div
          ref={gridRef}
          className="grid min-h-0 flex-1"
          style={{ gridTemplateColumns: `${layout.navWidth}px auto minmax(${CONFIG_MIN}px, 1fr) auto ${layout.runsWidth}px` }}
        >
          <aside data-testid="col-nav" className="min-h-0 overflow-auto" style={{ background: 'var(--color-panel)' }}>{nav}</aside>
          <ResizableSplit
            value={layout.navWidth} side="left" min={NAV_MIN} max={NAV_MAX} defaultValue={NAV_DEFAULT}
            onResize={proposeNav} onCommit={commitLayout} ariaLabel="调整导航栏宽度" testId="separator-nav"
          />
          <main data-testid="col-config" className="min-h-0 overflow-auto p-4">{config}</main>
          <ResizableSplit
            value={layout.runsWidth} side="right" min={RUNS_MIN} max={RUNS_MAX} defaultValue={RUNS_DEFAULT}
            onResize={proposeRuns} onCommit={commitLayout} ariaLabel="调整运行面板宽度" testId="separator-runs"
          />
          <section data-testid="col-runs" className="min-h-0 overflow-auto" style={{ background: 'var(--color-panel)' }}>{runs}</section>
        </div>
      )}
    </div>
  )
}
