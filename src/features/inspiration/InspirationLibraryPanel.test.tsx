import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { saveTextFileAs } from '../../lib/saveTextFile'
import { addInspirationFolder, addInspirationItem, loadInspirationLibrary } from './inspirationLibrary'
import { InspirationLibraryPanel } from './InspirationLibraryPanel'

vi.mock('../../lib/saveTextFile', () => ({ saveTextFileAs: vi.fn() }))

beforeEach(() => {
  vi.restoreAllMocks()
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
    await userEvent.click(screen.getByRole('combobox', { name: '选择文件格式' }))
    await userEvent.click(screen.getByRole('option', { name: '纯文本' }))
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    const saved = loadInspirationLibrary()
    expect(saved.items).toHaveLength(1)
    expect(saved.items[0]).toMatchObject({ title: '我的灵感', content: '## 一个想法', format: 'txt', kind: 'note' })
    await userEvent.click(screen.getByRole('button', { name: '返回目录' }))
    expect(screen.getByTestId(`inspiration-item-${saved.items[0].id}`)).toHaveTextContent('我的灵感')
  })

  it('新建笔记以空正文开始并可保存为空正文', async () => {
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByRole('button', { name: /新建笔记/ }))
    const content = await screen.findByTestId('inspiration-content-input')
    expect(content).toHaveValue('')
    expect(content).toHaveAttribute('placeholder', '写点什么...')

    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    const saved = loadInspirationLibrary()
    expect(saved.items).toHaveLength(1)
    expect(saved.items[0]).toMatchObject({ title: '未命名灵感', content: '' })
    expect(saved.items[0].content).not.toContain('# 未命名灵感')
  })

  it('只创建文件夹时也会离开空状态并保留文件夹', async () => {
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByRole('button', { name: /新建文件夹/ }))
    await userEvent.type(screen.getByRole('textbox', { name: '文件夹名称' }), '视频选题')
    await userEvent.click(screen.getByRole('button', { name: /创建/ }))

    expect(screen.queryByTestId('inspiration-library-empty')).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '文件夹路径' })).toHaveTextContent('视频选题')
    expect(loadInspirationLibrary().folders.map((folder) => folder.name)).toEqual(['视频选题'])
  })

  it('文件夹按直属文件数显示零到三张信件', () => {
    const folders = Array.from({ length: 5 }, (_, count) => {
      const folder = addInspirationFolder(`${count} 项文件夹`)!
      for (let index = 0; index < count; index += 1) {
        addInspirationItem({
          title: `${count}-${index}`,
          content: 'content',
          kind: 'note',
          format: 'md',
          folderId: folder.id,
        })
      }
      return folder
    })
    const childOnlyFolder = addInspirationFolder('仅含子文件夹')!
    addInspirationFolder('子文件夹', childOnlyFolder.id)
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    for (const [count, expected] of [0, 1, 2, 3, 3].entries()) {
      const card = screen.getByTestId(`inspiration-folder-item-${folders[count].id}`)
      expect(card.querySelectorAll('.inspiration-folder-paper')).toHaveLength(expected)
    }
    const childOnlyCard = screen.getByTestId(`inspiration-folder-item-${childOnlyFolder.id}`)
    expect(childOnlyCard).toHaveTextContent('文件夹 · 1 项')
    expect(childOnlyCard.querySelectorAll('.inspiration-folder-paper')).toHaveLength(0)
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
    await userEvent.click(screen.getByRole('button', { name: '返回目录' }))
    await userEvent.type(screen.getByTestId('nav-search'), '不存在')
    expect(screen.getByText('没有匹配的灵感')).toBeInTheDocument()
  })

  it('根目录只显示不可点击的当前面包屑', () => {
    addInspirationItem({ title: '根目录笔记', content: 'root', kind: 'note', format: 'md', folderId: null })
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    const breadcrumb = screen.getByRole('navigation', { name: '文件夹路径' })
    const current = screen.getByTestId('inspiration-breadcrumb-root')
    expect(breadcrumb).toHaveTextContent('灵感库')
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(current).toHaveAttribute('title', '灵感库')
    expect(current.tagName).toBe('SPAN')
    expect(breadcrumb.querySelector('button')).toBeNull()
  })

  it('根目录同时显示笔记和文件夹，并支持进入子文件夹', async () => {
    const parent = addInspirationFolder('选题')!
    const child = addInspirationFolder('短视频', parent.id)!
    const rootNote = addInspirationItem({ title: '根目录笔记', content: 'root', kind: 'note', format: 'md', folderId: null })!
    const childNote = addInspirationItem({ title: '子目录笔记', content: 'child', kind: 'note', format: 'md', folderId: child.id })!
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    expect(screen.getByRole('region', { name: '灵感列表' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '灵感内容' })).not.toBeInTheDocument()
    expect(screen.getByTestId(`inspiration-folder-item-${parent.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`inspiration-item-${rootNote.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`inspiration-item-${childNote.id}`)).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId(`inspiration-folder-item-${parent.id}`))
    expect(screen.getByTestId(`inspiration-folder-item-${child.id}`)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId(`inspiration-folder-item-${child.id}`))
    expect(screen.getByTestId(`inspiration-item-${childNote.id}`)).toBeInTheDocument()
    const rootCrumb = screen.getByTestId('inspiration-breadcrumb-root')
    const parentCrumb = screen.getByTestId(`inspiration-breadcrumb-${parent.id}`)
    const currentCrumb = screen.getByTestId(`inspiration-breadcrumb-${child.id}`)
    expect(rootCrumb).toHaveTextContent('灵感库')
    expect(rootCrumb.tagName).toBe('BUTTON')
    expect(parentCrumb.tagName).toBe('BUTTON')
    expect(currentCrumb).toHaveClass('is-current')
    expect(currentCrumb).toHaveAttribute('aria-current', 'page')
    expect(currentCrumb.tagName).toBe('SPAN')
    expect(screen.queryByRole('button', { name: child.name })).not.toBeInTheDocument()
    await userEvent.click(parentCrumb)
    expect(screen.getByTestId(`inspiration-folder-item-${child.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`inspiration-breadcrumb-${parent.id}`)).toHaveAttribute('aria-current', 'page')
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

    await userEvent.click(screen.getByTestId(`inspiration-folder-item-${parent.id}`))
    await userEvent.click(screen.getByTestId(`inspiration-folder-item-${child.id}`))
    await userEvent.click(screen.getByRole('button', { name: `删除文件夹 ${child.name}` }))
    expect(screen.getByRole('dialog', { name: '删除文件夹？' })).toBeInTheDocument()
    expect(loadInspirationLibrary().items[0].folderId).toBe(child.id)
    await userEvent.click(screen.getByRole('button', { name: '删除' }))

    const saved = loadInspirationLibrary()
    expect(saved.folders.some((folder) => folder.id === child.id)).toBe(false)
    expect(saved.items.find((item) => item.id === note.id)?.folderId).toBe(parent.id)
  })

  it('删除文件夹移回上一级时也为冲突名称追加后缀', async () => {
    const parent = addInspirationFolder('目标目录')!
    const child = addInspirationFolder('待移除', parent.id)!
    const existing = addInspirationItem({ title: '同名', content: 'existing', kind: 'note', format: 'md', folderId: parent.id })!
    const moved = addInspirationItem({ title: '同名', content: 'moved', kind: 'note', format: 'md', folderId: child.id })!
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByTestId(`inspiration-folder-item-${parent.id}`))
    await userEvent.click(screen.getByTestId(`inspiration-folder-item-${child.id}`))
    await userEvent.click(screen.getByRole('button', { name: `删除文件夹 ${child.name}` }))
    await userEvent.click(screen.getByRole('button', { name: '删除' }))

    const saved = loadInspirationLibrary()
    expect(saved.items.find((item) => item.id === existing.id)?.title).toBe('同名')
    expect(saved.items.find((item) => item.id === moved.id)?.title).toBe('同名(1)')
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
    expect(screen.queryByRole('region', { name: '灵感列表' })).not.toBeInTheDocument()
  })

  it('打开笔记时隐藏目录，返回后保存草稿并恢复同一目录', async () => {
    const folder = addInspirationFolder('当前目录')!
    const item = addInspirationItem({ title: '目录内笔记', content: '原内容', kind: 'note', format: 'md', folderId: folder.id })!
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByTestId(`inspiration-folder-item-${folder.id}`))
    await userEvent.click(screen.getByTestId(`inspiration-item-${item.id}`))
    expect(screen.queryByRole('region', { name: '灵感列表' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '灵感内容' })).toBeInTheDocument()
    await userEvent.clear(screen.getByTestId('inspiration-content-input'))
    await userEvent.type(screen.getByTestId('inspiration-content-input'), '返回时保存')
    const returnButton = screen.getByRole('button', { name: '返回目录' })
    expect(returnButton).toHaveAttribute('title', '保存修改并返回当前目录')
    await userEvent.click(returnButton)

    expect(screen.getByRole('region', { name: '灵感列表' })).toBeInTheDocument()
    expect(screen.getByTestId(`inspiration-item-${item.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`inspiration-breadcrumb-${folder.id}`)).toHaveAttribute('aria-current', 'page')
    expect(loadInspirationLibrary().items.find((candidate) => candidate.id === item.id)?.content).toBe('返回时保存')
  })

  it('未修改时返回目录不会重复保存或更新时间', async () => {
    const item = addInspirationItem({ title: '无需保存', content: '内容', kind: 'note', format: 'md', folderId: null })!
    const setItem = vi.spyOn(localStorage, 'setItem')
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByTestId(`inspiration-item-${item.id}`))
    await userEvent.click(screen.getByRole('button', { name: '返回目录' }))

    expect(setItem).not.toHaveBeenCalled()
    expect(loadInspirationLibrary().items[0].updatedAt).toBe(item.updatedAt)
  })

  it('编辑为已存在名称时自动追加后缀并同步编辑框', async () => {
    const first = addInspirationItem({ title: '已有名称', content: 'one', kind: 'note', format: 'md', folderId: null })!
    const second = addInspirationItem({ title: '另一个名称', content: 'two', kind: 'note', format: 'md', folderId: null })!
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByTestId(`inspiration-item-${second.id}`))
    const title = screen.getByTestId('inspiration-title-input')
    await userEvent.clear(title)
    await userEvent.type(title, first.title)
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(title).toHaveValue('已有名称(1)')
    expect(loadInspirationLibrary().items.map((item) => item.title).sort()).toEqual(['已有名称', '已有名称(1)'])
  })

  it('返回时保存失败会保留编辑器和草稿', async () => {
    const item = addInspirationItem({ title: '保存失败', content: '原内容', kind: 'note', format: 'md', folderId: null })!
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('storage full') })
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)
    await userEvent.click(screen.getByTestId(`inspiration-item-${item.id}`))
    await userEvent.clear(screen.getByTestId('inspiration-content-input'))
    await userEvent.type(screen.getByTestId('inspiration-content-input'), '尚未落盘的草稿')

    await userEvent.click(screen.getByRole('button', { name: '返回目录' }))

    expect(screen.getByRole('region', { name: '灵感内容' })).toBeInTheDocument()
    expect(screen.getByTestId('inspiration-content-input')).toHaveValue('尚未落盘的草稿')
    expect(loadInspirationLibrary().items[0].content).toBe('原内容')
    expect(screen.getByTestId('inspiration-library-toast')).toHaveTextContent('保存失败')
  })

  it('删除当前笔记后返回目录且不自动打开其他笔记', async () => {
    const first = addInspirationItem({ title: '第一条', content: 'one', kind: 'note', format: 'md', folderId: null })!
    const second = addInspirationItem({ title: '第二条', content: 'two', kind: 'note', format: 'md', folderId: null })!
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByTestId(`inspiration-item-${first.id}`))
    await userEvent.click(screen.getByRole('button', { name: '删除灵感' }))
    await userEvent.click(screen.getByRole('button', { name: '删除' }))

    expect(screen.getByRole('region', { name: '灵感列表' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '灵感内容' })).not.toBeInTheDocument()
    expect(screen.getByTestId(`inspiration-item-${second.id}`)).toBeInTheDocument()
  })

  it('文件卡原位确认后直接持久化删除，不打开编辑器或二次弹窗', async () => {
    const item = addInspirationItem({ title: '卡片删除', content: 'one', kind: 'note', format: 'md', folderId: null })!
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByRole('button', { name: '删除笔记 卡片删除' }))
    expect(await screen.findByRole('button', { name: '确认删除 卡片删除' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '灵感内容' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '确认删除 卡片删除' }))

    expect(loadInspirationLibrary().items.some((candidate) => candidate.id === item.id)).toBe(false)
    expect(screen.queryByTestId(`inspiration-item-${item.id}`)).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('编辑时面包屑以笔记为当前位置，并可保存后返回目录', async () => {
    const folder = addInspirationFolder('面包屑目录')!
    const item = addInspirationItem({ title: '面包屑笔记', content: 'before', kind: 'note', format: 'md', folderId: folder.id })!
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)
    await userEvent.click(screen.getByTestId(`inspiration-folder-item-${folder.id}`))
    await userEvent.click(screen.getByTestId(`inspiration-item-${item.id}`))
    await userEvent.clear(screen.getByTestId('inspiration-content-input'))
    await userEvent.type(screen.getByTestId('inspiration-content-input'), 'after')

    expect(screen.getByTestId('inspiration-breadcrumb-note')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId(`inspiration-breadcrumb-${folder.id}`).tagName).toBe('BUTTON')
    await userEvent.click(screen.getByTestId(`inspiration-breadcrumb-${folder.id}`))

    expect(screen.getByRole('region', { name: '灵感列表' })).toBeInTheDocument()
    expect(loadInspirationLibrary().items.find((candidate) => candidate.id === item.id)?.content).toBe('after')
  })

  it('空文件夹显示创建提示，搜索为空时保留搜索提示', async () => {
    const folder = addInspirationFolder('空目录')!
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)
    await userEvent.click(screen.getByTestId(`inspiration-folder-item-${folder.id}`))
    expect(screen.getByRole('status', { name: '此文件夹为空' })).toHaveTextContent('新建笔记或文件夹')

    await userEvent.type(screen.getByRole('combobox', { name: '搜索灵感' }), '无结果')
    expect(screen.getByRole('status', { name: '没有匹配的灵感' })).toHaveTextContent('请尝试其他关键词')
  })

  it('可以从编辑器导出当前草稿', async () => {
    const item = addInspirationItem({ title: '导出笔记', content: '导出内容', kind: 'note', format: 'md', folderId: null })!
    vi.mocked(saveTextFileAs).mockResolvedValue(true)
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)
    await userEvent.click(screen.getByTestId(`inspiration-item-${item.id}`))

    await userEvent.click(screen.getByRole('button', { name: '导出文件' }))

    expect(saveTextFileAs).toHaveBeenCalledWith('导出笔记.md', '导出内容')
  })
})
