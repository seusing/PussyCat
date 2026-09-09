import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addInspirationFolder, addInspirationItem, loadInspirationLibrary } from './inspirationLibrary'
import { InspirationLibraryPanel } from './InspirationLibraryPanel'

vi.mock('../../lib/saveTextFile', () => ({ saveTextFileAs: vi.fn() }))

beforeEach(() => {
  localStorage.clear()
})

describe('灵感库', () => {
  it('空状态可以跳转到灵感来源', async () => {
    const onOpenSources = vi.fn()
    render(<InspirationLibraryPanel onOpenSources={onOpenSources} />)

    expect(screen.getByTestId('inspiration-library-empty')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /去找灵感/ }))
    expect(onOpenSources).toHaveBeenCalledTimes(1)
  })

  it('新建笔记、编辑内容并保存到本地库', async () => {
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByRole('button', { name: /新建笔记/ }))
    const title = await screen.findByTestId('inspiration-title-input')
    const content = screen.getByTestId('inspiration-content-input')
    await userEvent.clear(title)
    await userEvent.type(title, '我的灵感')
    await userEvent.clear(content)
    await userEvent.type(content, '## 一个想法')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '选择文件格式' }), 'txt')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    const saved = loadInspirationLibrary()
    expect(saved.items).toHaveLength(1)
    expect(saved.items[0]).toMatchObject({ title: '我的灵感', content: '## 一个想法', format: 'txt', kind: 'note' })
    expect(screen.getByTestId(`inspiration-item-${saved.items[0].id}`)).toHaveTextContent('我的灵感')
  })

  it('只创建文件夹时也会离开空状态并保留文件夹', async () => {
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByRole('button', { name: /新建文件夹/ }))
    await userEvent.type(screen.getByRole('textbox', { name: '文件夹名称' }), '视频选题')
    await userEvent.click(screen.getByRole('button', { name: /创建/ }))

    expect(screen.queryByTestId('inspiration-library-empty')).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: '灵感文件夹' })).toHaveTextContent('视频选题')
    expect(loadInspirationLibrary().folders.map((folder) => folder.name)).toEqual(['视频选题'])
  })

  it('显示视频解析和非网址来源，并支持按关键词搜索', async () => {
    const video = addInspirationItem({
      title: '视频结果',
      content: '# 重点内容',
      kind: 'video',
      format: 'md',
      folderId: null,
      source: '视频解析任务',
    })!
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    expect(screen.getByTestId(`inspiration-item-${video.id}`)).toHaveTextContent('视频解析')
    await userEvent.click(screen.getByTestId(`inspiration-item-${video.id}`))
    expect(screen.getByText('来源：视频解析任务')).toBeInTheDocument()
    await userEvent.type(screen.getByTestId('nav-search'), '不存在')
    expect(screen.getByText('没有匹配的灵感')).toBeInTheDocument()
  })

  it('根目录同时显示笔记和文件夹，并支持进入子文件夹', async () => {
    const parent = addInspirationFolder('选题')!
    const child = addInspirationFolder('短视频', parent.id)!
    const rootNote = addInspirationItem({ title: '根目录笔记', content: 'root', kind: 'note', format: 'md', folderId: null })!
    const childNote = addInspirationItem({ title: '子目录笔记', content: 'child', kind: 'note', format: 'md', folderId: child.id })!
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    expect(screen.getByTestId(`inspiration-folder-item-${parent.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`inspiration-item-${rootNote.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`inspiration-item-${childNote.id}`)).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId(`inspiration-folder-${parent.id}`))
    expect(screen.getByTestId(`inspiration-folder-item-${child.id}`)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId(`inspiration-folder-item-${child.id}`))
    expect(screen.getByTestId(`inspiration-item-${childNote.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`inspiration-breadcrumb-${parent.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`inspiration-breadcrumb-${child.id}`)).toHaveClass('is-current')
    await userEvent.click(screen.getByTestId(`inspiration-breadcrumb-${parent.id}`))
    expect(screen.getByTestId(`inspiration-folder-item-${child.id}`)).toBeInTheDocument()
    expect(screen.queryByText('未分类')).not.toBeInTheDocument()
  })

  it('搜索无结果时使用可复用空状态提示', async () => {
    addInspirationItem({ title: '已有灵感', content: '内容', kind: 'note', format: 'md', folderId: null })
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.type(screen.getByRole('combobox', { name: '搜索灵感' }), '不存在')
    expect(screen.getByRole('status', { name: '暂无匹配建议' })).toBeInTheDocument()
    expect(screen.getByRole('status', { name: '没有匹配的灵感' })).toBeInTheDocument()
  })

  it('删除文件夹前要求确认，并把内容移到上一级', async () => {
    const parent = addInspirationFolder('父文件夹')!
    const child = addInspirationFolder('待删除', parent.id)!
    const note = addInspirationItem({ title: '保留笔记', content: 'keep', kind: 'note', format: 'md', folderId: child.id })!
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByRole('button', { name: `删除文件夹 ${child.name}` }))
    expect(screen.getByRole('dialog', { name: '删除文件夹？' })).toBeInTheDocument()
    expect(loadInspirationLibrary().items[0].folderId).toBe(child.id)
    await userEvent.click(screen.getByRole('button', { name: '删除' }))

    const saved = loadInspirationLibrary()
    expect(saved.folders.some((folder) => folder.id === child.id)).toBe(false)
    expect(saved.items.find((item) => item.id === note.id)?.folderId).toBe(parent.id)
  })

  it('搜索建议支持键盘选中灵感', async () => {
    const item = addInspirationItem({ title: '键盘搜索目标', content: '内容', kind: 'note', format: 'md', folderId: null })!
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    const search = screen.getByRole('combobox', { name: '搜索灵感' })
    await userEvent.type(search, '键盘搜索')
    expect(screen.getByRole('listbox', { name: '搜索建议' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /键盘搜索目标/ })).toBeInTheDocument()
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(search).toHaveValue('')
    expect(screen.getByTestId('inspiration-title-input')).toHaveValue(item.title)
  })
})
