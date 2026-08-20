import { useCallback, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { InlineLoader } from 'generative-loaders'
import 'generative-loaders/styles.css'
import {
  Clapperboard,
  KeyRound,
  Lightbulb,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RadioTower,
  Rss,
  SlidersHorizontal,
} from 'lucide-react'
import { SystemHealthPill } from './SystemHealthPill'
import ResizableSplit from './ResizableSplit'
import { useAppStore } from '../store/appStore'
import {
  loadLayout, saveLayout, clampColumnWidth,
  NAV_MIN, NAV_MAX, NAV_DEFAULT, RUNS_MIN, RUNS_MAX, RUNS_DEFAULT, CONFIG_MIN,
  MODULE_SIDEBAR_MIN, MODULE_SIDEBAR_MAX, MODULE_SIDEBAR_DEFAULT,
  DETAILS_MIN, DETAILS_MAX, DETAILS_DEFAULT,
} from '../data/layout'
import type { LayoutSnapshot } from '../data/layout'

const MODULES = [
  { key: 'commands' as const, label: '灵感来源', icon: Lightbulb },
  { key: 'login' as const, label: '登录信息', icon: KeyRound },
  { key: 'vk' as const, label: '视频解析', icon: Clapperboard },
  { key: 'providers' as const, label: '模型配置', icon: SlidersHorizontal },
  { key: 'wrss' as const, label: '公众号', icon: Rss },
  { key: 'radar' as const, label: 'Codex Radar', icon: RadioTower },
]

function ModuleNavigation() {
  const activeModule = useAppStore((state) => state.activeModule)
  const setActiveModule = useAppStore((state) => state.setActiveModule)
  return (
    <nav className="app-module-tabs" data-testid="module-tabs" aria-label="功能模块">
      {MODULES.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          type="button"
          data-testid={`module-tab-${key}`}
          aria-pressed={activeModule === key}
          onClick={() => setActiveModule(key)}
          title={label}
        >
          <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
          <span className="sidebar-label">{label}</span>
        </button>
      ))}
    </nav>
  )
}

export default function AppShell({
  nav, config, runs, fullPage, rightPanel, rightPanelOpen = false, onRightPanelOpenChange,
  catalogStatus, catalogError, onRetryCatalog, headerActions, baseUrl,
}: {
  nav: ReactNode
  config: ReactNode
  runs: ReactNode
  fullPage?: ReactNode
  rightPanel?: ReactNode
  rightPanelOpen?: boolean
  onRightPanelOpenChange?: (open: boolean) => void
  catalogStatus: 'loading' | 'ready' | 'error'
  catalogError?: string
  onRetryCatalog: () => void
  headerActions?: ReactNode
  baseUrl?: string
}) {
  const activeModule = useAppStore((state) => state.activeModule)
  const activeLabel = MODULES.find((module) => module.key === activeModule)?.label ?? '爪爪'
  const shellRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<LayoutSnapshot>(() => loadLayout())
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
  const commitLayout = useCallback(() => saveLayout(layoutRef.current), [])
  const toggleNav = useCallback(() => {
    const next = { ...layoutRef.current, navHidden: !layoutRef.current.navHidden }
    layoutRef.current = next
    setLayout(next)
    saveLayout(next)
  }, [])
  const toggleRuns = useCallback(() => {
    const next = { ...layoutRef.current, runsHidden: !layoutRef.current.runsHidden }
    layoutRef.current = next
    setLayout(next)
    saveLayout(next)
  }, [])
  const proposeModuleSidebar = useCallback((proposed: number) => {
    const otherWidth = rightPanel && rightPanelOpen ? layoutRef.current.detailsWidth : 0
    const next = {
      ...layoutRef.current,
      moduleSidebarWidth: clampColumnWidth(
        proposed,
        MODULE_SIDEBAR_MIN,
        MODULE_SIDEBAR_MAX,
        otherWidth,
        shellRef.current?.getBoundingClientRect().width ?? 0,
      ),
    }
    layoutRef.current = next
    setLayout(next)
  }, [rightPanel, rightPanelOpen])
  const proposeDetails = useCallback((proposed: number) => {
    const otherWidth = layoutRef.current.moduleSidebarHidden ? 0 : layoutRef.current.moduleSidebarWidth
    const next = {
      ...layoutRef.current,
      detailsWidth: clampColumnWidth(
        proposed,
        DETAILS_MIN,
        DETAILS_MAX,
        otherWidth,
        shellRef.current?.getBoundingClientRect().width ?? 0,
      ),
    }
    layoutRef.current = next
    setLayout(next)
  }, [])
  const toggleModuleSidebar = useCallback(() => {
    const next = { ...layoutRef.current, moduleSidebarHidden: !layoutRef.current.moduleSidebarHidden }
    layoutRef.current = next
    setLayout(next)
    saveLayout(next)
  }, [])

  const gridTemplateColumns = [
    !layout.navHidden && `${layout.navWidth}px`,
    !layout.navHidden && 'auto',
    `minmax(${CONFIG_MIN}px, 1fr)`,
    !layout.runsHidden && 'auto',
    !layout.runsHidden && `${layout.runsWidth}px`,
  ].filter((value): value is string => !!value).join(' ')

  const shellTemplateColumns = [
    !layout.moduleSidebarHidden && `${layout.moduleSidebarWidth}px`,
    !layout.moduleSidebarHidden && 'auto',
    'minmax(0, 1fr)',
    rightPanel && rightPanelOpen && 'auto',
    rightPanel && rightPanelOpen && `${layout.detailsWidth}px`,
  ].filter((value): value is string => !!value).join(' ')

  return (
    <div
      ref={shellRef}
      className="app-shell"
      data-left-open={!layout.moduleSidebarHidden}
      data-right-open={!!rightPanel && rightPanelOpen}
      style={{ gridTemplateColumns: shellTemplateColumns, '--app-details-width': `${layout.detailsWidth}px` } as CSSProperties}
    >
      {!layout.moduleSidebarHidden && <aside data-testid="app-sidebar" className="app-sidebar">
        <div className="app-brand">
          <span className="app-brand-mark">
            <img data-testid="app-brand-icon" src="/app-icon.png" alt="" aria-hidden="true" className="h-full w-full rounded-[7px] object-cover" />
          </span>
          <span className="sidebar-label"><strong>爪爪</strong><small>1.0</small></span>
        </div>
        <ModuleNavigation />
        <div className="app-sidebar-health"><SystemHealthPill baseUrl={baseUrl} /></div>
      </aside>}

      {!layout.moduleSidebarHidden && (
        <ResizableSplit
          value={layout.moduleSidebarWidth}
          side="left"
          min={MODULE_SIDEBAR_MIN}
          max={MODULE_SIDEBAR_MAX}
          defaultValue={MODULE_SIDEBAR_DEFAULT}
          onResize={proposeModuleSidebar}
          onCommit={commitLayout}
          ariaLabel="调整应用导航栏宽度"
          testId="separator-app-sidebar"
        />
      )}

      <div className="app-main">
        <header data-testid="app-header" className="app-header flex-wrap">
          <div className="app-header-primary">
            <button
              type="button"
              data-testid="toggle-app-sidebar"
              aria-label="显示/隐藏应用导航栏"
              aria-pressed={!layout.moduleSidebarHidden}
              onClick={toggleModuleSidebar}
              className="app-icon-button"
              title={layout.moduleSidebarHidden ? '显示导航栏' : '隐藏导航栏'}
            >
              {layout.moduleSidebarHidden ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </button>
            {!fullPage && (
              <button
                type="button"
                data-testid="toggle-nav"
                aria-label="显示/隐藏导航栏"
                aria-pressed={!layout.navHidden}
                onClick={toggleNav}
                className="app-icon-button"
              >
                {layout.navHidden ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
              </button>
            )}
            <div><strong>{activeLabel}</strong></div>
          </div>
          <div data-testid="app-header-actions" className="app-header-actions">
            {headerActions}
            {!fullPage && (
              <button
                type="button"
                data-testid="toggle-runs"
                aria-label="显示/隐藏运行面板"
                aria-pressed={!layout.runsHidden}
                onClick={toggleRuns}
                className="app-icon-button"
              >
                {layout.runsHidden ? <PanelRightOpen size={17} /> : <PanelRightClose size={17} />}
              </button>
            )}
            {rightPanel && (
              <button
                type="button"
                data-testid="toggle-details-sidebar"
                aria-label="显示/隐藏任务详情栏"
                aria-pressed={rightPanelOpen}
                onClick={() => onRightPanelOpenChange?.(!rightPanelOpen)}
                className="app-icon-button"
                title={rightPanelOpen ? '隐藏任务详情' : '显示任务详情'}
              >
                {rightPanelOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
              </button>
            )}
          </div>
        </header>

        {catalogStatus === 'loading' && (
          <div data-testid="catalog-loading" className="app-status-screen app-catalog-loading" role="status">
            <InlineLoader variant="spark" size={32} label="灵感汲取中" />
            <span className="app-catalog-loading-copy">灵感汲取中</span>
          </div>
        )}

        {catalogStatus === 'error' && (
          <div className="app-status-screen app-status-error">
            <div>{catalogError ?? '加载命令目录失败'}</div>
            <button data-testid="catalog-retry" onClick={onRetryCatalog}>重试</button>
          </div>
        )}

        {catalogStatus === 'ready' && fullPage && (
          <div data-testid="full-page" className="app-content">{fullPage}</div>
        )}

        {catalogStatus === 'ready' && !fullPage && (
          <div ref={gridRef} data-testid="app-grid" className="app-grid" style={{ gridTemplateColumns }}>
            {!layout.navHidden && <aside data-testid="col-nav" className="legacy-nav">{nav}</aside>}
            {!layout.navHidden && (
              <ResizableSplit
                value={layout.navWidth} side="left" min={NAV_MIN} max={NAV_MAX} defaultValue={NAV_DEFAULT}
                onResize={proposeNav} onCommit={commitLayout} ariaLabel="调整导航栏宽度" testId="separator-nav"
              />
            )}
            <main data-testid="col-config" className="legacy-config">{config}</main>
            {!layout.runsHidden && (
              <ResizableSplit
                value={layout.runsWidth} side="right" min={RUNS_MIN} max={RUNS_MAX} defaultValue={RUNS_DEFAULT}
                onResize={proposeRuns} onCommit={commitLayout} ariaLabel="调整运行面板宽度" testId="separator-runs"
              />
            )}
            {!layout.runsHidden && <section data-testid="col-runs" className="legacy-runs">{runs}</section>}
          </div>
        )}
      </div>

      {rightPanel && rightPanelOpen && (
        <>
          <ResizableSplit
            value={layout.detailsWidth}
            side="right"
            min={DETAILS_MIN}
            max={DETAILS_MAX}
            defaultValue={DETAILS_DEFAULT}
            onResize={proposeDetails}
            onCommit={commitLayout}
            ariaLabel="调整任务详情栏宽度"
            testId="separator-details-sidebar"
          />
          <aside data-testid="details-sidebar" className="app-details-sidebar">{rightPanel}</aside>
        </>
      )}
    </div>
  )
}
