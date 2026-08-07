import { useEffect, useMemo, useRef, useState, type Ref } from 'react'
import { ArrowLeft, GalleryHorizontalEnd, Orbit, Search } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import type { CommandManifest } from '../../data/types'
import {
  SUPPORTED_SITES,
  commandsForSite,
  visibleCommands,
  type SupportedSite,
} from '../../data/supportedSites'
import { SiteCarousel } from './SiteCarousel'
import { ActivityWheel } from './ActivityWheel'
import { FisheyeCommandList } from './FisheyeCommandList'
import { CommandConfig } from '../config/CommandConfig'
import { RunPanel } from '../runs/RunPanel'

type Stage = 'sites' | 'commands' | 'execute'
type DisplayMode = 'carousel' | 'wheel'

const DISPLAY_MODE_KEY = 'zhuazhua:inspiration-display-mode:v1'

function initialDisplayMode(): DisplayMode {
  try {
    return localStorage.getItem(DISPLAY_MODE_KEY) === 'wheel' ? 'wheel' : 'carousel'
  } catch {
    return 'carousel'
  }
}

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

export function InspirationPanel({
  onRun,
  onCancel,
  onRerun,
  registerSubmit,
  searchRef,
}: {
  onRun: () => void
  onCancel: () => void
  onRerun: () => void
  registerSubmit?: (submit: (() => void) | null) => void
  searchRef?: Ref<HTMLInputElement>
}) {
  const allCommands = useAppStore((state) => state.commands)
  const selected = useAppStore((state) => state.selected)
  const selectCommand = useAppStore((state) => state.selectCommand)
  const decisionFor = useAppStore((state) => state.decisionFor)
  const commands = useMemo(() => visibleCommands(allCommands), [allCommands])
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
  const [site, setSite] = useState<SupportedSite | undefined>(() => selectedSite)
  const [mode, setMode] = useState<DisplayMode>(initialDisplayMode)
  const [query, setQuery] = useState('')
  const lastSelectedCommand = useRef(selected?.command)

  useEffect(() => {
    if (!selected || selected.command === lastSelectedCommand.current) return
    lastSelectedCommand.current = selected.command
    const nextSite = sites.find((candidate) => candidate.keys.includes(selected.site))
    if (nextSite) setSite(nextSite)
    setStage('execute')
  }, [selected, sites])

  const chooseMode = (next: DisplayMode) => {
    setMode(next)
    try { localStorage.setItem(DISPLAY_MODE_KEY, next) } catch { /* in-memory preference still applies */ }
  }

  const openSite = (next: SupportedSite) => {
    setSite(next)
    setQuery('')
    setStage('commands')
  }

  const siteCommands = useMemo(() => {
    if (!site) return []
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const list = commandsForSite(commands, site)
    if (!normalizedQuery) return list
    return list.filter((command) => (
      command.name.toLocaleLowerCase().includes(normalizedQuery)
      || command.description.toLocaleLowerCase().includes(normalizedQuery)
    ))
  }, [commands, query, site])

  const globalMatches = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return []
    return commands.filter((command) => (
      command.name.toLocaleLowerCase().includes(normalizedQuery)
      || command.description.toLocaleLowerCase().includes(normalizedQuery)
      || command.site.toLocaleLowerCase().includes(normalizedQuery)
    )).slice(0, 24)
  }, [commands, query])

  const openCommand = (command: CommandManifest) => {
    selectCommand(command)
    setStage('execute')
  }

  if (stage === 'execute' && selected) {
    const executionSite = site ?? selectedSite
    return (
      <div data-testid="inspiration-execute" className="inspiration-execute">
        <div className="inspiration-breadcrumb">
          <button type="button" onClick={() => { if (executionSite) setSite(executionSite); setStage('commands') }} aria-label="返回命令集合">
            <ArrowLeft size={17} />
          </button>
          <div>
            <span>{executionSite?.label ?? selected.site}</span>
            <strong>{selected.name}</strong>
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
        </div>
        <div className="command-workspace">
          <main data-testid="col-config" className="command-config-pane">
            <CommandConfig onRun={onRun} registerSubmit={registerSubmit} />
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
        </div>
        <FisheyeCommandList
          commands={siteCommands}
          onSubmit={openCommand}
          canSubmit={(command) => {
            const decision = decisionFor(command.command)
            return decision?.state !== 'denied'
          }}
        />
        {siteCommands.length === 0 && <div className="inspiration-empty">没有匹配的命令</div>}
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
        <div className="display-mode-switch" role="group" aria-label="站点展示方式">
          <button type="button" data-testid="display-mode-carousel" aria-label="卡片轮播" aria-pressed={mode === 'carousel'} onClick={() => chooseMode('carousel')}>
            <GalleryHorizontalEnd size={17} />
          </button>
          <button type="button" data-testid="display-mode-wheel" aria-label="活动转盘" aria-pressed={mode === 'wheel'} onClick={() => chooseMode('wheel')}>
            <Orbit size={17} />
          </button>
        </div>
        <label className="command-search inspiration-global-search">
          <Search size={16} aria-hidden="true" />
          <input ref={searchRef} data-testid="nav-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索站点或命令" aria-label="搜索站点或命令" />
        </label>
      </div>
      {query.trim()
        ? <FisheyeCommandList
            commands={globalMatches}
            onSubmit={openCommand}
            canSubmit={(command) => {
              const decision = decisionFor(command.command)
              return decision?.state !== 'denied'
            }}
          />
        : (
          <div className="site-display">
            {mode === 'carousel'
              ? <SiteCarousel sites={sites} onSelect={openSite} />
              : <ActivityWheel sites={sites} onSelect={openSite} />}
          </div>
        )}
    </div>
  )
}
