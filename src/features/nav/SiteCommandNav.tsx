import { useMemo, useState, type ReactNode, type Ref } from 'react'
import { useAppStore } from '../../store/appStore'
import { searchCommands, groupBySite } from '../../data/catalog'
import { siteLabel } from '../../data/zhCopy'
import type { CommandManifest } from '../../data/types'
import { SearchX } from 'lucide-react'
import { EmptyState } from '../../components/EmptyState'

function NavCommandButton({ label, cmd, stale, active, onClick }: {
  label: string; cmd?: CommandManifest; stale: boolean; active: boolean; onClick: () => void
}) {
  const disabled = !cmd || stale
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={stale ? '该命令在当前目录中已不存在' : undefined}
      className="flex w-full items-center rounded-md px-2 py-1.5 text-left"
      style={{ background: active ? 'var(--color-hover)' : 'transparent', color: 'var(--color-fg)', opacity: stale ? 0.4 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      {/* access(read/write)**不在导航里显示** —— 它是命令的属性,不是找命令的线索,
          放在这里只是给 1278 行每行加一列噪声。详情页有徽标,那里才是它该在的位置。 */}
      <span className="truncate">{label}</span>
    </button>
  )
}

/** 可折叠分组。标题行本身就是开关 —— 与下面「全部站点」的站点行同一套交互,不另造一种。 */
function NavSection({ title, testid, open, onToggle, children }: {
  title: string; testid: string; open: boolean; onToggle: () => void; children: ReactNode
}) {
  return (
    <div className="mb-3" data-testid={testid}>
      <button
        data-testid={`${testid}-toggle`}
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-xs uppercase tracking-wide"
        style={{ color: 'var(--color-fg-dim)' }}
      >
        <span aria-hidden className="inline-block w-3 shrink-0">{open ? '▾' : '▸'}</span>
        <span>{title}</span>
      </button>
      {open && children}
    </div>
  )
}

export function SiteCommandNav({ searchRef }: { searchRef?: Ref<HTMLInputElement> } = {}) {
  const commands = useAppStore((s) => s.commands)
  const selected = useAppStore((s) => s.selected)
  const selectCommand = useAppStore((s) => s.selectCommand)
  const preferences = useAppStore((s) => s.preferences)
  const stale = useAppStore((s) => s.stale)
  const [q, setQ] = useState('')
  const [siteFilter, setSiteFilter] = useState<string | null>(null)
  // 手动展开的站点 / 三个固定分组的开合 —— 都**存在 store 里,不在本组件的 useState**。
  // 原因是顶栏切模块时本组件整个被卸载(AppShell 的 fullPage 分支顶掉三栏),局部 state
  // 会随之归零,用户收起的分组切回来又全开着。语义未变:站点默认全收起(175 站点平铺是
  // 一条翻不到底的长带),三个固定分组默认展开(短列表,折叠只会多一次点击);仍然只活在
  // 内存里,重开应用回到干净状态。
  const expanded = useAppStore((s) => s.navExpandedSites)
  const toggleSite = useAppStore((s) => s.toggleNavSite)
  const sectionOpen = useAppStore((s) => s.navSectionOpen)
  const toggleSection = useAppStore((s) => s.toggleNavSection)

  const searching = q.trim() !== ''
  const visible = useMemo(
    () => (siteFilter ? commands.filter((c) => c.site === siteFilter) : searchCommands(commands, q)),
    [commands, q, siteFilter],
  )
  const groups = useMemo(() => groupBySite(visible), [visible])
  const byKey = useMemo(() => new Map(commands.map((c) => [c.command, c])), [commands])
  const favSites = useMemo(() => [...preferences.favoriteSites].sort((a, b) => a.createdAt - b.createdAt), [preferences.favoriteSites])
  const favCommands = useMemo(() => [...preferences.favoriteCommands].sort((a, b) => a.createdAt - b.createdAt), [preferences.favoriteCommands])
  const recent = preferences.recent
  const showGroups = !searching && !siteFilter && (recent.length + favSites.length + favCommands.length) > 0

  // 三种情况下不需要用户再点一次展开:
  //   · 搜索中 —— 结果本就是筛过的少量,收起等于把搜出来的东西又藏起来;
  //   · 站点过滤中 —— 用户已明确表达"只看这个站";
  //   · 该站点含当前选中的命令 —— 否则选中项会藏在收起的行里,看不见高亮。
  const isExpanded = (site: string) => (
    searching || siteFilter === site || selected?.site === site || expanded.has(site)
  )

  return (
    <div className="flex h-full flex-col">
      <div className="p-3">
        <input
          data-testid="nav-search"
          ref={searchRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setSiteFilter(null) }}
          placeholder="搜索服务或命令"
          className="w-full rounded-lg px-3 py-2 outline-none"
          style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
        />
      </div>
      <nav className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {siteFilter && (
          <div data-testid="site-filter-chip" className="mb-2 flex items-center justify-between rounded-md px-2 py-1.5 text-xs" style={{ background: 'var(--color-hover)', color: 'var(--color-fg)' }}>
            <span>站点：{siteFilter}</span>
            <button data-testid="site-filter-clear" onClick={() => setSiteFilter(null)} style={{ color: 'var(--color-fg-dim)' }}>✕</button>
          </div>
        )}
        {showGroups && (
          <>
            {recent.length > 0 && (
              <NavSection title="最近使用" testid="group-recent"
                open={sectionOpen.recent} onToggle={() => toggleSection('recent')}>
                {recent.map((r) => {
                  const cmd = byKey.get(r.command)
                  // **必须带站点名**:whoami / feed / login 这类命令名在多个站点重复,
                  // 光看命令名分不清是哪个站的——实测「最近使用」里能同时出现三个 whoami。
                  return (
                    <NavCommandButton key={r.command} label={cmd ? `${siteLabel(cmd.site)} · ${cmd.name}` : r.command}
                      cmd={cmd} stale={!cmd}
                      active={selected?.command === r.command} onClick={() => cmd && selectCommand(cmd)} />
                  )
                })}
              </NavSection>
            )}
            {favSites.length > 0 && (
              <NavSection title="常用站点" testid="group-fav-sites"
                open={sectionOpen.favSites} onToggle={() => toggleSection('favSites')}>
                {favSites.map((f) => {
                  const dead = stale.sites.has(f.site)
                  return (
                    <button key={f.site} data-testid={`fav-site-nav-${f.site}`}
                      onClick={() => { setSiteFilter(f.site); setQ('') }} disabled={dead}
                      title={dead ? '该站点在当前目录中已不存在' : undefined}
                      className="flex w-full items-center rounded-md px-2 py-1.5 text-left"
                      style={{ background: 'transparent', color: 'var(--color-fg)', opacity: dead ? 0.4 : 1, cursor: dead ? 'not-allowed' : 'pointer' }}>
                      {siteLabel(f.site)}
                    </button>
                  )
                })}
              </NavSection>
            )}
            {favCommands.length > 0 && (
              <NavSection title="常用命令" testid="group-fav-commands"
                open={sectionOpen.favCommands} onToggle={() => toggleSection('favCommands')}>
                {favCommands.map((f) => {
                  const cmd = byKey.get(f.command)
                  const dead = !cmd || stale.commands.has(f.command)
                  return (
                    <NavCommandButton key={f.command} label={cmd ? `${siteLabel(cmd.site)} · ${cmd.name}` : f.command} cmd={cmd} stale={dead}
                      active={selected?.command === f.command} onClick={() => cmd && selectCommand(cmd)} />
                  )
                })}
              </NavSection>
            )}
          </>
        )}
        {/* 「全部站点」本身也可整体收起 —— 有收藏与最近使用时,用户常常根本不需要看这 175 行。
            没有那些分组时(showGroups 为假)不显示标题行:此时站点列表就是导航的全部内容,
            给它一个能把整个界面清空的开关只会制造困惑。 */}
        {showGroups && (
          <button
            data-testid="group-all-sites-toggle"
            onClick={() => toggleSection('allSites')}
            aria-expanded={sectionOpen.allSites}
            className="flex w-full items-center gap-1.5 px-2 py-1 text-xs uppercase tracking-wide"
            style={{ color: 'var(--color-fg-dim)' }}
          >
            <span aria-hidden className="inline-block w-3 shrink-0">{sectionOpen.allSites ? '▾' : '▸'}</span>
            <span>全部站点</span>
            <span className="ml-auto shrink-0">{groups.length}</span>
          </button>
        )}
        {(!showGroups || sectionOpen.allSites) && groups.map((g) => {
          const open = isExpanded(g.site)
          return (
            <div key={g.site} className="mb-0.5">
              <button
                data-testid={`site-row-${g.site}`}
                onClick={() => toggleSite(g.site)}
                aria-expanded={open}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left"
                style={{ color: 'var(--color-fg)' }}
              >
                <span aria-hidden className="inline-block w-3 shrink-0 text-xs" style={{ color: 'var(--color-fg-dim)' }}>
                  {open ? '▾' : '▸'}
                </span>
                <span className="truncate">{siteLabel(g.site)}</span>
                {/* 条数是**决定要不要点开**的依据,不是装饰:12 条与 240 条的展开代价完全不同 */}
                <span className="ml-auto shrink-0 text-xs" style={{ color: 'var(--color-fg-dim)' }}>{g.commands.length}</span>
              </button>
              {open && g.commands.map((cmd) => {
                const active = selected?.command === cmd.command
                return (
                  <button
                    key={cmd.command}
                    onClick={() => selectCommand(cmd)}
                    className="flex w-full items-center rounded-md py-1.5 pl-7 pr-2 text-left"
                    style={{ background: active ? 'var(--color-hover)' : 'transparent', color: 'var(--color-fg)' }}
                  >
                    <span className="truncate">{cmd.name}</span>
                  </button>
                )
              })}
            </div>
          )
        })}
        {groups.length === 0 && <EmptyState className="nav-empty-state" icon={<SearchX size={20} />} title="无匹配命令" description="请尝试其他关键词" />}
      </nav>
    </div>
  )
}
