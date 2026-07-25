import { useMemo, useState, type ReactNode, type Ref } from 'react'
import { useAppStore } from '../../store/appStore'
import { searchCommands, groupBySite } from '../../data/catalog'
import type { CommandManifest } from '../../data/types'

function NavCommandButton({ label, cmd, stale, active, onClick }: {
  label: string; cmd?: CommandManifest; stale: boolean; active: boolean; onClick: () => void
}) {
  const disabled = !cmd || stale
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={stale ? '该命令在当前目录中已不存在' : undefined}
      className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm"
      style={{ background: active ? 'var(--color-hover)' : 'transparent', color: 'var(--color-fg)', opacity: stale ? 0.4 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      <span className="truncate">{label}</span>
      {cmd && <span className="text-xs" style={{ color: cmd.access === 'write' ? 'var(--color-warning)' : 'var(--color-fg-dim)' }}>{cmd.access}</span>}
    </button>
  )
}

function NavSection({ title, testid, children }: { title: string; testid: string; children: ReactNode }) {
  return (
    <div className="mb-3" data-testid={testid}>
      <div className="px-2 py-1 text-xs uppercase tracking-wide" style={{ color: 'var(--color-fg-dim)' }}>{title}</div>
      {children}
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

  const visible = useMemo(
    () => (siteFilter ? commands.filter((c) => c.site === siteFilter) : searchCommands(commands, q)),
    [commands, q, siteFilter],
  )
  const groups = useMemo(() => groupBySite(visible), [visible])
  const byKey = useMemo(() => new Map(commands.map((c) => [c.command, c])), [commands])
  const favSites = useMemo(() => [...preferences.favoriteSites].sort((a, b) => a.createdAt - b.createdAt), [preferences.favoriteSites])
  const favCommands = useMemo(() => [...preferences.favoriteCommands].sort((a, b) => a.createdAt - b.createdAt), [preferences.favoriteCommands])
  const recent = preferences.recent
  const showGroups = q.trim() === '' && !siteFilter && (recent.length + favSites.length + favCommands.length) > 0

  return (
    <div className="flex h-full flex-col">
      <div className="p-3">
        <input
          data-testid="nav-search"
          ref={searchRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setSiteFilter(null) }}
          placeholder="搜索服务或命令"
          className="w-full rounded-lg px-3 py-2 text-sm outline-none"
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
              <NavSection title="最近使用" testid="group-recent">
                {recent.map((r) => {
                  const cmd = byKey.get(r.command)
                  return (
                    <NavCommandButton key={r.command} label={cmd ? cmd.name : r.command} cmd={cmd} stale={!cmd}
                      active={selected?.command === r.command} onClick={() => cmd && selectCommand(cmd)} />
                  )
                })}
              </NavSection>
            )}
            {favSites.length > 0 && (
              <NavSection title="常用站点" testid="group-fav-sites">
                {favSites.map((f) => {
                  const dead = stale.sites.has(f.site)
                  return (
                    <button key={f.site} data-testid={`fav-site-nav-${f.site}`}
                      onClick={() => { setSiteFilter(f.site); setQ('') }} disabled={dead}
                      title={dead ? '该站点在当前目录中已不存在' : undefined}
                      className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm"
                      style={{ background: 'transparent', color: 'var(--color-fg)', opacity: dead ? 0.4 : 1, cursor: dead ? 'not-allowed' : 'pointer' }}>
                      {f.site}
                    </button>
                  )
                })}
              </NavSection>
            )}
            {favCommands.length > 0 && (
              <NavSection title="常用命令" testid="group-fav-commands">
                {favCommands.map((f) => {
                  const cmd = byKey.get(f.command)
                  const dead = !cmd || stale.commands.has(f.command)
                  return (
                    <NavCommandButton key={f.command} label={cmd ? `${cmd.site} · ${cmd.name}` : f.command} cmd={cmd} stale={dead}
                      active={selected?.command === f.command} onClick={() => cmd && selectCommand(cmd)} />
                  )
                })}
              </NavSection>
            )}
            <div className="px-2 py-1 text-xs uppercase tracking-wide" style={{ color: 'var(--color-fg-dim)' }}>全部站点</div>
          </>
        )}
        {groups.map((g) => (
          <div key={g.site} className="mb-3">
            <div className="px-2 py-1 text-xs uppercase tracking-wide" style={{ color: 'var(--color-fg-dim)' }}>{g.site}</div>
            {g.commands.map((cmd) => {
              const active = selected?.command === cmd.command
              return (
                <button
                  key={cmd.command}
                  onClick={() => selectCommand(cmd)}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm"
                  style={{ background: active ? 'var(--color-hover)' : 'transparent', color: 'var(--color-fg)' }}
                >
                  <span>{cmd.name}</span>
                  <span className="text-xs" style={{ color: cmd.access === 'write' ? 'var(--color-warning)' : 'var(--color-fg-dim)' }}>{cmd.access}</span>
                </button>
              )
            })}
          </div>
        ))}
        {groups.length === 0 && <div className="px-3 py-2 text-sm" style={{ color: 'var(--color-fg-dim)' }}>无匹配命令</div>}
      </nav>
    </div>
  )
}
