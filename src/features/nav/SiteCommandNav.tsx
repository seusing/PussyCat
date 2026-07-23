import { useMemo, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { searchCommands, groupBySite } from '../../data/catalog'

export function SiteCommandNav() {
  const commands = useAppStore((s) => s.commands)
  const selected = useAppStore((s) => s.selected)
  const selectCommand = useAppStore((s) => s.selectCommand)
  const [q, setQ] = useState('')

  const groups = useMemo(() => groupBySite(searchCommands(commands, q)), [commands, q])

  return (
    <div className="flex h-full flex-col">
      <div className="p-3">
        <input
          data-testid="nav-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索服务或命令"
          className="w-full rounded-lg px-3 py-2 text-sm outline-none"
          style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
        />
      </div>
      <nav className="min-h-0 flex-1 overflow-auto px-2 pb-3">
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
