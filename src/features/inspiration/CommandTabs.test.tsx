import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommandTabs } from './CommandTabs'
import type { CommandRun, CommandTab } from '../../store/appStore'
import type { RunState } from '../../store/runMachine'
import type { CommandManifest } from '../../data/types'

const manifest = (command: string, site: string, name: string): CommandManifest => ({
  command, site, name, description: '', access: 'read', browser: false, args: [],
})
// 有中文标题、站点有 logo 的命令 / 没有中文标题、站点不在产品站点表里的命令
const ask = manifest('xiaohongshu/ask', 'xiaohongshu', 'ask')
const plain = manifest('fixture/plain', 'fixture', 'plain')

const runIn = (command: CommandManifest, state: RunState): CommandRun => ({
  id: `run-${command.name}`, command, values: {}, state, startedAt: 1, lines: [],
})
const tab = (command: CommandManifest, state?: RunState): CommandTab => ({
  command, values: {}, run: state ? runIn(command, state) : undefined,
})

function setup(tabs: CommandTab[], activeKey?: string) {
  const handlers = { onSelect: vi.fn(), onClose: vi.fn(), onNew: vi.fn() }
  render(<CommandTabs tabs={tabs} activeKey={activeKey} {...handlers} />)
  return handlers
}

describe('CommandTabs', () => {
  it('渲染 tablist,每个标签显示中文标题(没有则回落命令名)与站点 logo', () => {
    setup([tab(ask), tab(plain)], ask.command)

    const list = screen.getByRole('tablist')
    expect(within(list).getAllByRole('tab')).toHaveLength(2)
    const askTab = screen.getByTestId('command-tab-xiaohongshu/ask')
    expect(askTab).toHaveTextContent('问小红书点点')
    expect(askTab.querySelector('img')).toHaveAttribute('src', '/site-logos/xiaohongshu.svg')
    const plainTab = screen.getByTestId('command-tab-fixture/plain')
    expect(plainTab).toHaveTextContent('plain')
    expect(plainTab.querySelector('img')).toBeNull()
  })

  it('选中态:只有 activeKey 对应的标签 aria-selected', () => {
    setup([tab(ask), tab(plain)], plain.command)
    expect(screen.getByTestId('command-tab-fixture/plain')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('command-tab-xiaohongshu/ask')).toHaveAttribute('aria-selected', 'false')
  })

  it('没有 activeKey 时没有标签处于选中态', () => {
    setup([tab(ask), tab(plain)])
    for (const t of screen.getAllByRole('tab')) expect(t).toHaveAttribute('aria-selected', 'false')
  })

  it('状态点随运行状态变化,没有运行时不显示', () => {
    const cases: [RunState, string][] = [
      ['starting', 'running'], ['running', 'running'], ['cancelling', 'running'],
      ['succeeded', 'success'], ['failed', 'danger'], ['cancelled', 'dim'],
    ]
    const commands = cases.map((_, i) => manifest(`s/c${i}`, 's', `c${i}`))
    setup([...cases.map(([state], i) => tab(commands[i], state)), tab(plain)])

    cases.forEach(([, tone], i) => {
      expect(screen.getByTestId(`command-tab-status-s/c${i}`)).toHaveAttribute('data-tone', tone)
    })
    expect(screen.queryByTestId('command-tab-status-fixture/plain')).not.toBeInTheDocument()
  })

  it('点标签调用 onSelect(command)', () => {
    const { onSelect } = setup([tab(ask), tab(plain)], ask.command)
    fireEvent.click(screen.getByTestId('command-tab-fixture/plain'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(plain)
  })

  it('关闭未运行的标签:直接 onClose,不弹确认(无 run 与终态 run 都一样)', () => {
    const { onClose } = setup([tab(ask), tab(plain, 'succeeded')], ask.command)
    fireEvent.click(screen.getByTestId('close-tab-xiaohongshu/ask'))
    expect(onClose).toHaveBeenLastCalledWith('xiaohongshu/ask')
    fireEvent.click(screen.getByTestId('close-tab-fixture/plain'))
    expect(onClose).toHaveBeenLastCalledWith('fixture/plain')
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('关闭按钮有无障碍名称,点它不会同时选中该标签', () => {
    const { onSelect } = setup([tab(ask)], ask.command)
    const close = screen.getByTestId('close-tab-xiaohongshu/ask')
    expect(close).toHaveAccessibleName('关闭标签页')
    fireEvent.click(close)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it.each(['starting', 'running', 'cancelling'] as const)('关闭 %s 的标签:先弹确认,确认后才 onClose', async (state) => {
    const { onClose } = setup([tab(ask, state)], ask.command)
    fireEvent.click(screen.getByTestId('close-tab-xiaohongshu/ask'))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('关闭运行中的命令？')
    expect(dialog).toHaveTextContent('这条命令还在运行，关闭会取消执行。')
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: '取消并关闭' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith('xiaohongshu/ask')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })

  it('确认框里点取消:标签保留,不 onClose', async () => {
    const { onClose } = setup([tab(ask, 'running')], ask.command)
    fireEvent.click(screen.getByTestId('close-tab-xiaohongshu/ask'))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(onClose).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.getByTestId('command-tab-xiaohongshu/ask')).toBeInTheDocument()
  })

  it('「+」按钮调用 onNew', () => {
    const { onNew } = setup([tab(ask)], ask.command)
    const button = screen.getByTestId('new-command-tab')
    expect(button).toHaveAccessibleName('打开其他命令')
    fireEvent.click(button)
    expect(onNew).toHaveBeenCalledTimes(1)
  })
})
