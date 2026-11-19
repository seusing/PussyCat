import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addInspirationFolder, addInspirationItem, loadInspirationLibrary } from './inspirationLibrary'
import { InspirationLibraryPanel } from './InspirationLibraryPanel'

vi.mock('../../lib/saveTextFile', () => ({ saveTextFileAs: vi.fn() }))

function note(title: string, folderId: string | null = null, content = '') {
  return addInspirationItem({ title, content, kind: 'note', format: 'md', folderId })!
}

const itemOf = (id: string) => loadInspirationLibrary().items.find((item) => item.id === id)
const folderOf = (id: string) => loadInspirationLibrary().folders.find((folder) => folder.id === id)

describe('移动到文件夹', () => {
  it('菜单列出根目录和按层级缩进的文件夹，当前位置打勾不可选；原来的文件夹下拉框已不在', async () => {
    const a = addInspirationFolder('甲')!
    addInspirationFolder('甲一', a.id)
    addInspirationFolder('乙')
    const item = note('想法')
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByTestId(`inspiration-item-${item.id}`))
    expect(screen.queryByRole('combobox', { name: '选择文件夹' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '移动到文件夹' }))

    const menu = screen.getByRole('menu', { name: '移动到文件夹' })
    const options = within(menu).getAllByRole('menuitemradio')
    expect(options.map((option) => option.textContent)).toEqual(['灵感库（根目录）', '甲', '甲一', '乙'])
    expect(options[0]).toHaveAttribute('aria-checked', 'true')
    expect(options[0]).toBeDisabled()
    expect(options[1]).toHaveAttribute('aria-checked', 'false')
    expect(parseFloat(options[2].style.paddingLeft)).toBeGreaterThan(parseFloat(options[1].style.paddingLeft))
    expect(within(menu).getByRole('menuitem', { name: '移动到新建的文件夹…' })).toBeInTheDocument()
  })

  it('移动立即生效，未保存的正文留在编辑器里', async () => {
    const b = addInspirationFolder('乙')!
    const item = note('想法', null, '原文')
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByTestId(`inspiration-item-${item.id}`))
    const content = screen.getByTestId('inspiration-content-input')
    await userEvent.type(content, '，还没保存')
    await userEvent.click(screen.getByRole('button', { name: '移动到文件夹' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: '乙' }))

    expect(itemOf(item.id)).toMatchObject({ folderId: b.id, content: '原文' })
    expect(screen.getByTestId('inspiration-content-input')).toHaveValue('原文，还没保存')
    expect(screen.getByRole('navigation', { name: '文件夹路径' })).toHaveTextContent('灵感库›乙›想法')
    expect(screen.getByTestId('inspiration-library-toast')).toHaveTextContent('已把“想法”移到“乙”')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('目标里有同名的会改名，提示里写明新名字', async () => {
    const b = addInspirationFolder('乙')!
    note('想法', b.id)
    const item = note('想法')
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByTestId(`inspiration-item-${item.id}`))
    await userEvent.click(screen.getByRole('button', { name: '移动到文件夹' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: '乙' }))

    expect(itemOf(item.id)?.title).toBe('想法(1)')
    expect(screen.getByTestId('inspiration-title-input')).toHaveValue('想法(1)')
    expect(screen.getByTestId('inspiration-library-toast')).toHaveTextContent('已改名为“想法(1)”')
  })

  it('在菜单里新建文件夹并移入，新文件夹建在笔记当前所在的目录', async () => {
    const a = addInspirationFolder('甲')!
    const item = note('想法', a.id)
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByTestId(`inspiration-folder-item-${a.id}`))
    await userEvent.click(screen.getByTestId(`inspiration-item-${item.id}`))
    await userEvent.click(screen.getByRole('button', { name: '移动到文件夹' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '移动到新建的文件夹…' }))
    await userEvent.type(screen.getByRole('textbox', { name: '新文件夹名称' }), '新的{Escape}')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '新文件夹名称' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('menuitem', { name: '移动到新建的文件夹…' }))
    await userEvent.type(screen.getByRole('textbox', { name: '新文件夹名称' }), '子目录{Enter}')

    const created = loadInspirationLibrary().folders.find((folder) => folder.name === '子目录')
    expect(created?.parentId).toBe(a.id)
    expect(itemOf(item.id)?.folderId).toBe(created?.id)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '文件夹路径' })).toHaveTextContent('灵感库›甲›子目录›想法')
  })

  it('Esc 关闭菜单，什么都不移动', async () => {
    addInspirationFolder('乙')
    const item = note('想法')
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)

    await userEvent.click(screen.getByTestId(`inspiration-item-${item.id}`))
    await userEvent.click(screen.getByRole('button', { name: '移动到文件夹' }))
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: '乙' })).toHaveFocus())
    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(itemOf(item.id)?.folderId).toBeNull()
  })
})

// jsdom 没有 PointerEvent;dnd-kit 的 PointerSensor 只认 isPrimary 的左键。
class TestPointerEvent extends MouseEvent {
  isPrimary: boolean
  pointerId: number
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.isPrimary = init.isPrimary ?? true
    this.pointerId = init.pointerId ?? 1
  }
}

type Box = { x: number; y: number; w: number; h: number }
const boxes = new Map<string, Box>()

function rectFor(element: Element): DOMRect {
  const testId = element.getAttribute('data-testid')
  const box = testId ? boxes.get(testId) : undefined
  const { x, y, w, h } = box ?? { x: 0, y: 0, w: 0, h: 0 }
  return { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) } as DOMRect
}

const center = (testId: string) => {
  const box = boxes.get(testId)!
  return { clientX: box.x + box.w / 2, clientY: box.y + box.h / 2 }
}

// 放下后 dnd-kit 会在 document 上拦 50ms 的 click,并跑完放下动画;等它们结束再断言。
async function drag(sourceTestId: string, targetTestId: string) {
  const source = screen.getByTestId(sourceTestId)
  const start = center(sourceTestId)
  const end = center(targetTestId)
  fireEvent.pointerDown(source, { ...start, button: 0, isPrimary: true })
  fireEvent.pointerMove(document, { clientX: start.clientX + 10, clientY: start.clientY })
  fireEvent.pointerMove(document, end)
  fireEvent.pointerUp(document, end)
  await act(() => new Promise((resolve) => setTimeout(resolve, 60)))
}

describe('拖拽移动', () => {
  beforeEach(() => {
    vi.stubGlobal('PointerEvent', TestPointerEvent)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) { return rectFor(this) })
  })
  afterEach(() => boxes.clear())

  function layout(folderIds: string[], itemIds: string[]) {
    boxes.set('inspiration-breadcrumb-root', { x: 0, y: 0, w: 60, h: 30 })
    folderIds.forEach((id, index) => boxes.set(`inspiration-folder-item-${id}`, { x: index * 200, y: 100, w: 180, h: 180 }))
    itemIds.forEach((id, index) => boxes.set(`inspiration-item-${id}`, { x: index * 200, y: 400, w: 180, h: 180 }))
  }

  it('把笔记拖进文件夹', async () => {
    const a = addInspirationFolder('甲')!
    const item = note('想法')
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)
    layout([a.id], [item.id])

    await drag(`inspiration-item-${item.id}`, `inspiration-folder-item-${a.id}`)

    expect(itemOf(item.id)?.folderId).toBe(a.id)
    expect(screen.queryByTestId(`inspiration-item-${item.id}`)).not.toBeInTheDocument()
    expect(screen.getByTestId('inspiration-library-toast')).toHaveTextContent('已把“想法”移到“甲”')
  })

  it('把文件夹拖进兄弟文件夹', async () => {
    const a = addInspirationFolder('甲')!
    const b = addInspirationFolder('乙')!
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)
    layout([a.id, b.id], [])

    await drag(`inspiration-folder-item-${a.id}`, `inspiration-folder-item-${b.id}`)

    expect(folderOf(a.id)?.parentId).toBe(b.id)
  })

  it('文件夹拖到自己身上没有反应', async () => {
    const a = addInspirationFolder('甲')!
    const before = loadInspirationLibrary()
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)
    layout([a.id], [])

    await drag(`inspiration-folder-item-${a.id}`, `inspiration-folder-item-${a.id}`)

    expect(loadInspirationLibrary()).toBe(before)
    expect(screen.getByTestId('inspiration-breadcrumb-root')).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByTestId('inspiration-library-toast')).not.toBeInTheDocument()
  })

  it('拖到路径栏的「灵感库」把笔记移出当前文件夹', async () => {
    const a = addInspirationFolder('甲')!
    const item = note('想法', a.id)
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)
    await userEvent.click(screen.getByTestId(`inspiration-folder-item-${a.id}`))
    layout([], [item.id])

    await drag(`inspiration-item-${item.id}`, 'inspiration-breadcrumb-root')

    expect(itemOf(item.id)?.folderId).toBeNull()
    expect(screen.getByTestId('inspiration-library-toast')).toHaveTextContent('已把“想法”移到“灵感库”')
  })

  it('点一下仍是打开', async () => {
    const a = addInspirationFolder('甲')!
    const item = note('想法', a.id)
    render(<InspirationLibraryPanel onOpenSources={() => {}} />)
    layout([a.id], [])

    await userEvent.click(screen.getByTestId(`inspiration-folder-item-${a.id}`))
    expect(screen.getByTestId('inspiration-breadcrumb-root')).toHaveRole('button')
    await userEvent.click(screen.getByTestId(`inspiration-item-${item.id}`))
    expect(screen.getByTestId('inspiration-title-input')).toHaveValue('想法')
    expect(itemOf(item.id)?.folderId).toBe(a.id)
  })
})
