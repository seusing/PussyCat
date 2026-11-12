import { useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { Plus, X } from 'lucide-react'
import { ConfirmPopover } from '../../components/ConfirmPopover'
import { isTerminal, type CommandTab } from '../../store/appStore'
import type { CommandManifest } from '../../data/types'
import { siteForCommand } from '../../data/supportedSites'
import { commandTitle } from '../../data/zhCopy'

const STATUS: Record<string, { tone: string; label: string }> = {
  starting: { tone: 'running', label: '运行中' },
  running: { tone: 'running', label: '运行中' },
  cancelling: { tone: 'running', label: '正在取消' },
  succeeded: { tone: 'success', label: '已完成' },
  failed: { tone: 'danger', label: '失败' },
  cancelled: { tone: 'dim', label: '已取消' },
}

/** 灵感库顶部的命令标签页栏。点标签切换命令,关闭运行中的标签前先确认(关闭会取消执行)。 */
export function CommandTabs({ tabs, activeKey, onSelect, onClose, onNew }: {
  tabs: CommandTab[]
  activeKey?: string
  onSelect: (command: CommandManifest) => void
  onClose: (commandKey: string) => void
  onNew: () => void
}) {
  const [confirm, setConfirm] = useState<{ key: string; anchor: HTMLElement } | null>(null)

  const requestClose = (tab: CommandTab, anchor: HTMLElement) => {
    if (tab.run && !isTerminal(tab.run.state)) setConfirm({ key: tab.command.command, anchor })
    else onClose(tab.command.command)
  }

  return (
    <div className="command-tabs">
      <div className="command-tabs-list" role="tablist" aria-label="命令标签页">
        {tabs.map((tab) => {
          const key = tab.command.command
          const title = commandTitle(key) ?? tab.command.name
          const logo = siteForCommand(tab.command.site)?.logo
          const status = tab.run ? STATUS[tab.run.state] : undefined
          const active = key === activeKey
          return (
            <div key={key} role="presentation" className="command-tab" data-active={active}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`command-tab-${key}`}
                className="command-tab-main"
                title={title}
                onClick={() => onSelect(tab.command)}
              >
                {logo && <img src={logo} alt="" className="command-tab-logo" />}
                <span className="command-tab-title">{title}</span>
                {status && (
                  <span
                    role="img"
                    aria-label={status.label}
                    data-testid={`command-tab-status-${key}`}
                    data-tone={status.tone}
                    className="command-tab-dot"
                  />
                )}
              </button>
              <button
                type="button"
                aria-label="关闭标签页"
                data-testid={`close-tab-${key}`}
                className="command-tab-close"
                onClick={(event) => requestClose(tab, event.currentTarget)}
              >
                <X size={13} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        aria-label="打开其他命令"
        title="打开其他命令"
        data-testid="new-command-tab"
        className="command-tab-new"
        onClick={onNew}
      >
        <Plus size={15} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <AnimatePresence>
        {confirm && (
          <ConfirmPopover
            key="confirm"
            anchor={confirm.anchor}
            title="关闭运行中的命令？"
            body={['这条命令还在运行，关闭会取消执行。']}
            confirmLabel="取消并关闭"
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              onClose(confirm.key)
              setConfirm(null)
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
