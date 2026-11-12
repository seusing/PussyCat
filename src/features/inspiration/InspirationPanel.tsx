import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type Ref } from 'react'
import { ArrowLeft, BookmarkPlus, FolderOpen, GalleryHorizontalEnd, Search, SearchX } from 'lucide-react'
import { commandTabs, useAppStore } from '../../store/appStore'
import type { CommandManifest } from '../../data/types'
import {
  SUPPORTED_SITES,
  commandsForSite,
  siteForCommand,
  visibleCommands,
  type SupportedSite,
} from '../../data/supportedSites'
import { SiteCarousel } from './SiteCarousel'
import { FisheyeCommandList, type CommandSection } from './FisheyeCommandList'
import { CommandConfig } from '../config/CommandConfig'
import { CommandTabs } from './CommandTabs'
import { RunPanel } from '../runs/RunPanel'
import { commandDescription, commandTitle } from '../../data/zhCopy'
import { groupCommands } from './commandGroups'
import { addInspirationItem } from './inspirationLibrary'
import { InspirationLibraryPanel } from './InspirationLibraryPanel'
import { GettingStarted } from '../onboarding/GettingStarted'
import { EmptyState } from '../../components/EmptyState'
import ResizableSplit from '../../components/ResizableSplit'
import {
  RUN_PANE_DEFAULT, RUN_PANE_MAX, RUN_PANE_MIN,
  clampColumnWidth, loadLayout, saveRunPaneLayout,
} from '../../data/layout'
import './InspirationPanel.css'

type Stage = 'sites' | 'commands' | 'execute'
type Workspace = 'library' | 'sources'

function fixtureSites(commands: CommandManifest[]): SupportedSite[] {
  return [...new Set(commands.map((command) => command.site))].map((site) => ({
    id: site,
    keys: [site],
    label: site,
    eyebrow: site,
    logo: '/site-logos/x.svg',
    tint: '#f4f4f5',
    description: `${site} 命令集合`,
  }))
}

function matchesCommand(command: CommandManifest, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return true
  const searchable = [
    commandTitle(command.command) ?? '',
    command.name,
    command.command,
    command.description,
    commandDescription(command.command, command.description),
    ...(command.aliases ?? []),
  ]
  return searchable.some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
}

// 标签栏自己订阅 store:运行输出和表单输入会不断改写标签内容,这样重渲染只落在标签栏上,不拖着整个面板。
function StoreCommandTabs(props: Omit<ComponentProps<typeof CommandTabs>, 'tabs'>) {
  const selected = useAppStore((state) => state.selected)
  const values = useAppStore((state) => state.values)
  const currentRun = useAppStore((state) => state.currentRun)
  const backgroundTabs = useAppStore((state) => state.backgroundTabs)
  const activeTabSlot = useAppStore((state) => state.activeTabSlot)
  const tabs = useMemo(
    () => commandTabs({ selected, values, currentRun, backgroundTabs, activeTabSlot }),
    [selected, values, currentRun, backgroundTabs, activeTabSlot],
  )
  return tabs.length > 0 ? <CommandTabs tabs={tabs} {...props} /> : null
}

export function InspirationPanel({
  baseUrl,
  onRun,
  onCancel,
  onCloseTab,
  registerSubmit,
  searchRef,
  runPaneHidden = false,
  onExecuteVisibleChange,
}: {
  baseUrl?: string
  onRun: () => void
  onCancel: () => void
  onCloseTab?: (commandKey: string) => void
  registerSubmit?: (submit: (() => void) | null) => void
  searchRef?: Ref<HTMLInputElement>
  runPaneHidden?: boolean
  onExecuteVisibleChange?: (visible: boolean) => void
}) {
  const allCommands = useAppStore((state) => state.commands)
  const selected = useAppStore((state) => state.selected)
  const selectCommand = useAppStore((state) => state.selectCommand)
  const decisionFor = useAppStore((state) => state.decisionFor)
  const commands = useMemo(
    () => visibleCommands(allCommands)
      .filter((command) => siteForCommand(command.site)?.id !== 'wechat'),
    [allCommands],
  )
  const productSites = useMemo(
    () => SUPPORTED_SITES.filter((site) => commandsForSite(commands, site).length > 0),
    [commands],
  )
  const sites = useMemo(
    () => productSites.length > 0 ? productSites : fixtureSites(commands),
    [commands, productSites],
  )
  const selectedSite = useMemo(
    () => selected ? sites.find((site) => site.keys.includes(selected.site)) : undefined,
    [selected, sites],
  )
  const [stage, setStage] = useState<Stage>(() => selected ? 'execute' : 'sites')
  const [workspace, setWorkspace] = useState<Workspace>('sources')
  const [site, setSite] = useState<SupportedSite | undefined>(() => selectedSite)
  const [query, setQuery] = useState('')
  const [writeGroupOpen, setWriteGroupOpen] = useState(false)
  const lastSelectedCommand = useRef(selected?.command)
  // 标记「接下来 selected 的变化来自关闭当前标签」:邻居标签顶上来时只跟随现有页面,不替用户换页。
  const closingCurrentTab = useRef(false)
  const [runPaneWidth, setRunPaneWidth] = useState(() => loadLayout().runPaneWidth)
  const runPaneWidthRef = useRef(runPaneWidth)
  const workspaceRef = useRef<HTMLDivElement>(null)

  const resizeRunPane = useCallback((proposed: number) => {
    const next = clampColumnWidth(
      proposed, RUN_PANE_MIN, RUN_PANE_MAX, 0, workspaceRef.current?.getBoundingClientRect().width ?? 0,
    )
    runPaneWidthRef.current = next
    setRunPaneWidth(next)
  }, [])
  const commitRunPane = useCallback(() => {
    saveRunPaneLayout({ runPaneWidth: runPaneWidthRef.current })
  }, [])

  // 顶栏的运行面板开关只在执行页有意义,由这里把「当前是否是执行页」回报给上层。
  const executeShown = workspace === 'sources' && stage === 'execute' && !!selected
  useEffect(() => {
    onExecuteVisibleChange?.(executeShown)
    return () => onExecuteVisibleChange?.(false)
  }, [executeShown, onExecuteVisibleChange])

  useEffect(() => {
    const previous = lastSelectedCommand.current
    if (!selected) {
      lastSelectedCommand.current = undefined
      closingCurrentTab.current = false
      // 最后一个标签被关掉:执行页已无内容,回到该站点的命令列表(搜索词清掉,免得列表被旧搜索筛空)
      if (previous !== undefined && stage === 'execute') {
        setQuery('')
        setStage(site ? 'commands' : 'sites')
      }
      return
    }
    if (selected.command === previous) return
    lastSelectedCommand.current = selected.command
    const nextSite = sites.find((candidate) => candidate.keys.includes(selected.site))
    if (closingCurrentTab.current) {
      closingCurrentTab.current = false
      if (stage === 'execute' && nextSite) setSite(nextSite)
      return
    }
    if (nextSite) setSite(nextSite)
    setWorkspace('sources')
    setStage('execute')
  }, [selected, sites, site, stage])

  const openSite = (next: SupportedSite) => {
    setWorkspace('sources')
    setSite(next)
    setQuery('')
    setWriteGroupOpen(false)
    setStage('commands')
  }

  const siteCommands = useMemo(() => {
    if (!site) return []
    const list = commandsForSite(commands, site)
    return list.filter((command) => matchesCommand(command, query))
  }, [commands, query, site])

  // 搜索时「写入」组自动展开,否则只命中写入命令的搜索会显示成"没有匹配"。
  const searching = query.trim() !== ''
  const sections = useMemo<CommandSection[]>(() => {
    const groups = groupCommands(siteCommands)
    const result: CommandSection[] = []
    if (groups.common.length > 0) result.push({ key: 'common', title: '常用', commands: groups.common })
    if (groups.read.length > 0) result.push({ key: 'read', title: '读取', commands: groups.read })
    if (groups.write.length > 0) {
      result.push({
        key: 'write',
        title: '写入',
        note: '会改动你的账号内容或登录状态',
        commands: groups.write,
        collapsible: true,
        collapsed: !writeGroupOpen && !searching,
        onToggle: () => setWriteGroupOpen((open) => !open),
      })
    }
    return result
  }, [siteCommands, writeGroupOpen, searching])

  const globalMatches = useMemo(() => {
    if (!query.trim()) return []
    return commands.filter((command) => matchesCommand(command, query) || command.site.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 24)
  }, [commands, query])

  // 打开命令:已有标签就切过去,没有就新开一个。标签栏、命令列表、搜索结果共用。
  const openCommand = (command: CommandManifest) => {
    const commandSite = sites.find((candidate) => candidate.keys.includes(command.site))
    if (commandSite) setSite(commandSite)
    setWorkspace('sources')
    selectCommand(command)
    setStage('execute')
  }

  const closeTab = (commandKey: string) => {
    const closingCurrent = selected?.command === commandKey
    closingCurrentTab.current = closingCurrent
    onCloseTab?.(commandKey)
    // 没有真正换掉当前标签(没接 onCloseTab 等):标记不能留到下一次选择
    if (closingCurrent && useAppStore.getState().selected?.command === commandKey) closingCurrentTab.current = false
  }

  const tabBar = (
    <StoreCommandTabs
      activeKey={stage === 'execute' ? selected?.command : undefined}
      onSelect={openCommand}
      onClose={closeTab}
      onNew={() => setStage('sites')}
    />
  )

  const openSources = () => {
    setWorkspace('sources')
    setStage(selected ? 'execute' : 'sites')
  }

  const saveSelectedSource = () => {
    if (!selected) return
    const description = commandDescription(selected.command, selected.description)
    const item = addInspirationItem({
      title: selected.name,
      content: `# ${selected.name}\n\n${description}\n\n来源：${selected.site}`,
      kind: 'source',
      format: 'md',
      folderId: null,
      source: selected.site,
    })
    if (item) setWorkspace('library')
  }

  if (workspace === 'library') {
    return <InspirationLibraryPanel baseUrl={baseUrl} onOpenSources={openSources} searchRef={searchRef} />
  }

  if (stage === 'execute' && selected) {
    const executionSite = site ?? selectedSite
    return (
      <div data-testid="inspiration-execute" className="inspiration-execute">
        {tabBar}
        <div className="inspiration-breadcrumb">
          <button type="button" onClick={() => { if (executionSite) setSite(executionSite); setStage('commands') }} aria-label="返回命令集合">
            <ArrowLeft size={17} strokeWidth={1.5} />
          </button>
          <div className="inspiration-command-heading">
            <span className="inspiration-command-eyebrow">{executionSite?.label ?? selected.site}</span>
            <div data-testid="command-header" className="inspiration-command-row">
              <div className="inspiration-command-title">
                <strong data-testid="command-title">{commandTitle(selected.command) ?? selected.name}</strong>
                {commandTitle(selected.command) && <small data-testid="command-subtitle">{selected.name}</small>}
              </div>
              <span className={selected.access === 'write' ? 'inspiration-command-tag is-write' : 'inspiration-command-tag'}>{selected.access === 'write' ? '写入' : '只读'}</span>
              {selected.browser && <span className="inspiration-command-tag">浏览器</span>}
              <button type="button" data-testid="save-command-to-inspiration-library" className="inspiration-source-save" onClick={saveSelectedSource} title="收进灵感库">
                <BookmarkPlus size={15} strokeWidth={1.5} aria-hidden="true" />收进灵感库
              </button>
            </div>
            <p data-testid="command-description" className="inspiration-command-description">
              {commandDescription(selected.command, selected.description)}
            </p>
          </div>
          <label className="command-search execution-search">
            <Search size={16} strokeWidth={1.5} aria-hidden="true" />
            <input
              ref={searchRef}
              data-testid="nav-search"
              value=""
              onChange={(event) => {
                if (executionSite) setSite(executionSite)
                setQuery(event.target.value)
                setStage('commands')
              }}
              placeholder="搜索命令"
              aria-label="搜索命令"
            />
          </label>
          <button type="button" data-testid="open-inspiration-library" className="inspiration-workspace-link" onClick={() => setWorkspace('library')} title="打开灵感库" aria-label="打开灵感库"><FolderOpen size={18} strokeWidth={1.5} aria-hidden="true" /></button>
        </div>
        <div
          ref={workspaceRef}
          className="command-workspace"
          data-run-pane={runPaneHidden ? 'hidden' : 'shown'}
          style={{ '--run-pane-width': `${runPaneWidth}px` } as CSSProperties}
        >
          <main data-testid="col-config" className="command-config-pane">
            <CommandConfig onRun={onRun} registerSubmit={registerSubmit} compactHeader />
          </main>
          {!runPaneHidden && (
            <ResizableSplit
              value={runPaneWidth}
              side="right"
              min={RUN_PANE_MIN}
              max={RUN_PANE_MAX}
              defaultValue={RUN_PANE_DEFAULT}
              onResize={resizeRunPane}
              onCommit={commitRunPane}
              ariaLabel="调整运行面板宽度"
              testId="separator-run-pane"
            />
          )}
          {!runPaneHidden && (
            <section data-testid="col-runs" className="command-run-pane">
              <RunPanel onCancel={onCancel} />
            </section>
          )}
        </div>
      </div>
    )
  }

  if (stage === 'commands' && site) {
    return (
      <div data-testid="inspiration-commands" className="inspiration-page inspiration-commands">
        {tabBar}
        <div className="inspiration-page-heading">
          <button type="button" onClick={() => setStage('sites')} aria-label="返回站点">
            <ArrowLeft size={17} />
          </button>
          <span className="inspiration-heading-logo"><img src={site.logo} alt="" /></span>
          <div>
            <span>{site.eyebrow}</span>
            <h1>{site.label} 命令</h1>
          </div>
          <label className="command-search">
            <Search size={16} aria-hidden="true" />
            <input ref={searchRef} data-testid="nav-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索命令" aria-label="搜索命令" />
          </label>
          <button type="button" data-testid="open-inspiration-library" className="inspiration-workspace-link" onClick={() => setWorkspace('library')} title="打开灵感库" aria-label="打开灵感库"><FolderOpen size={18} aria-hidden="true" /></button>
        </div>
        <FisheyeCommandList
          sections={sections}
          onSubmit={openCommand}
          canSubmit={(command) => {
            const decision = decisionFor(command.command)
            return decision?.state !== 'denied'
          }}
        />
        {siteCommands.length === 0 && <EmptyState className="inspiration-empty" icon={<SearchX size={22} />} title="没有匹配的命令" description="请尝试其他关键词" />}
      </div>
    )
  }

  return (
    <div data-testid="inspiration-sites" className="inspiration-page inspiration-sites">
      {tabBar}
      <div className="inspiration-page-heading inspiration-site-heading">
        <div>
          <span>INSPIRATION SOURCES</span>
          <h1>灵感来源</h1>
        </div>
        <div className="display-mode-switch" role="group" aria-label="站点展示方式">
          <button type="button" data-testid="open-inspiration-library" aria-label="灵感库" onClick={() => setWorkspace('library')} title="打开灵感库">
            <FolderOpen size={17} />
          </button>
          <button type="button" data-testid="display-mode-carousel" aria-label="卡片轮播" aria-pressed="true" title="卡片轮播">
            <GalleryHorizontalEnd size={17} />
          </button>
        </div>
        <label className="command-search inspiration-global-search">
          <Search size={16} aria-hidden="true" />
          <input ref={searchRef} data-testid="nav-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索站点或命令" aria-label="搜索站点或命令" />
        </label>
      </div>
      {query.trim()
        ? globalMatches.length > 0
          ? <FisheyeCommandList
              commands={globalMatches}
              onSubmit={openCommand}
              canSubmit={(command) => {
                const decision = decisionFor(command.command)
                return decision?.state !== 'denied'
              }}
            />
          : <EmptyState className="inspiration-empty" icon={<SearchX size={22} />} title="没有匹配的命令" description="请尝试其他关键词" />
        : (
          <>
            <GettingStarted baseUrl={baseUrl} />
            <div className="site-display">
              <SiteCarousel sites={sites} onSelect={openSite} />
            </div>
          </>
        )}
    </div>
  )
}
