import { useEffect, useMemo, useRef, useState, type Ref } from 'react'
import { ArrowLeft, BookmarkPlus, FolderOpen, Search, SearchX } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import type { CommandManifest } from '../../data/types'
import {
  SUPPORTED_SITES,
  commandsForSite,
  siteForCommand,
  visibleCommands,
  type SupportedSite,
} from '../../data/supportedSites'
import { SiteGrid } from './SiteGrid'
import { FisheyeCommandList, type CommandSection } from './FisheyeCommandList'
import { CommandConfig } from '../config/CommandConfig'
import { RunPanel } from '../runs/RunPanel'
import { MicroButton } from '../../components/MicroButton'
import { isSiteFavorited, isCommandFavorited } from '../../data/preferences'
import { commandDescription, commandTitle } from '../../data/zhCopy'
import { groupCommands } from './commandGroups'
import { addInspirationItem } from './inspirationLibrary'
import { InspirationLibraryPanel } from './InspirationLibraryPanel'
import { GettingStarted } from '../onboarding/GettingStarted'
import { EmptyState } from '../../components/EmptyState'
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

export function InspirationPanel({
  baseUrl,
  onRun,
  onCancel,
  onRerun,
  registerSubmit,
  searchRef,
}: {
  baseUrl?: string
  onRun: () => void
  onCancel: () => void
  onRerun: () => void
  registerSubmit?: (submit: (() => void) | null) => void
  searchRef?: Ref<HTMLInputElement>
}) {
  const allCommands = useAppStore((state) => state.commands)
  const selected = useAppStore((state) => state.selected)
  const preferences = useAppStore((state) => state.preferences)
  const toggleSiteFavorite = useAppStore((state) => state.toggleSiteFavorite)
  const toggleCommandFavorite = useAppStore((state) => state.toggleCommandFavorite)
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

  useEffect(() => {
    if (!selected) {
      lastSelectedCommand.current = undefined
      return
    }
    if (selected.command === lastSelectedCommand.current) return
    lastSelectedCommand.current = selected.command
    const nextSite = sites.find((candidate) => candidate.keys.includes(selected.site))
    if (nextSite) setSite(nextSite)
    setWorkspace('sources')
    setStage('execute')
  }, [selected, sites])

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
        note: '会修改你的账号内容',
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

  const openCommand = (command: CommandManifest) => {
    setWorkspace('sources')
    selectCommand(command)
    setStage('execute')
  }

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
        <div className="inspiration-breadcrumb">
          <button type="button" onClick={() => { if (executionSite) setSite(executionSite); setStage('commands') }} aria-label="返回命令集合">
            <ArrowLeft size={17} />
          </button>
          <div className="inspiration-command-heading">
            <span>{executionSite?.label ?? selected.site}</span>
            <div data-testid="command-header" className="flex flex-wrap items-center gap-2">
              <div className="inspiration-command-title">
                <strong data-testid="command-title">{commandTitle(selected.command) ?? selected.name}</strong>
                {commandTitle(selected.command) && <small data-testid="command-subtitle">{selected.name}</small>}
              </div>
              <MicroButton
                variant="save"
                data-testid="fav-site"
                onClick={() => toggleSiteFavorite(selected.site)}
                active={isSiteFavorited(preferences, selected.site)}
                aria-pressed={isSiteFavorited(preferences, selected.site)}
                title={isSiteFavorited(preferences, selected.site) ? '取消收藏站点' : '收藏站点'}
              >
                {isSiteFavorited(preferences, selected.site) ? '已保存' : '稍后查看'}
              </MicroButton>
              <MicroButton
                variant="favorite"
                data-testid="fav-command"
                onClick={() => toggleCommandFavorite(selected)}
                active={isCommandFavorited(preferences, selected.command)}
                aria-pressed={isCommandFavorited(preferences, selected.command)}
                title={isCommandFavorited(preferences, selected.command) ? '取消收藏命令' : '收藏命令'}
              >
                {isCommandFavorited(preferences, selected.command) ? '已收藏' : '收藏'}
              </MicroButton>
              <button type="button" data-testid="save-command-to-inspiration-library" className="inspiration-source-save" onClick={saveSelectedSource} title="收进灵感库">
                <BookmarkPlus size={14} aria-hidden="true" />收进灵感库
              </button>
              <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--color-hover)', color: selected.access === 'write' ? 'var(--color-warning)' : 'var(--color-fg-dim)' }}>{selected.access}</span>
              {selected.browser && <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--color-hover)', color: 'var(--color-fg-dim)' }}>浏览器</span>}
              <span data-testid="command-description" className="min-w-0 text-sm" style={{ flex: '1 1 16rem', color: 'var(--color-fg-dim)', overflowWrap: 'anywhere' }}>
                {commandDescription(selected.command, selected.description)}
              </span>
            </div>
          </div>
          <label className="command-search execution-search">
            <Search size={16} aria-hidden="true" />
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
          <button type="button" data-testid="open-inspiration-library" className="inspiration-workspace-link" onClick={() => setWorkspace('library')} title="打开灵感库" aria-label="打开灵感库"><FolderOpen size={18} aria-hidden="true" /></button>
        </div>
        <div className="command-workspace">
          <main data-testid="col-config" className="command-config-pane">
            <CommandConfig onRun={onRun} registerSubmit={registerSubmit} compactHeader />
          </main>
          <section data-testid="col-runs" className="command-run-pane">
            <RunPanel onCancel={onCancel} onRerun={onRerun} />
          </section>
        </div>
      </div>
    )
  }

  if (stage === 'commands' && site) {
    return (
      <div data-testid="inspiration-commands" className="inspiration-page inspiration-commands">
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
      <div className="inspiration-page-heading inspiration-site-heading">
        <div>
          <span>INSPIRATION SOURCES</span>
          <h1>灵感来源</h1>
        </div>
        <button type="button" data-testid="open-inspiration-library" className="inspiration-workspace-link" onClick={() => setWorkspace('library')} title="打开灵感库" aria-label="打开灵感库"><FolderOpen size={18} aria-hidden="true" /></button>
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
              <SiteGrid sites={sites} onSelect={openSite} />
            </div>
          </>
        )}
    </div>
  )
}
