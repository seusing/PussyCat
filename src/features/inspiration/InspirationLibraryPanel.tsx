import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import {
  BookOpen, Check, Download, Eye, FilePlus2, FileText, Folder, FolderOpen,
  FolderPlus, Pencil, Search, Trash2, Video, X,
} from 'lucide-react'
import Markdown from 'react-markdown'
import { AppAlert, type AppAlertTone } from '../../components/AppAlert'
import { AppNotificationPortal } from '../../components/AppNotificationPortal'
import { saveTextFileAs } from '../../lib/saveTextFile'
import {
  INSPIRATION_LIBRARY_EVENT,
  addInspirationFolder,
  addInspirationItem,
  inspirationKindLabel,
  loadInspirationLibrary,
  saveInspirationLibrary,
  type InspirationFolder,
  type InspirationItem,
  type InspirationLibrary,
} from './inspirationLibrary'
import './InspirationLibraryPanel.css'

type FolderFilter = 'all' | string
type ViewMode = 'edit' | 'read'
type ToastState = { id: number; tone: AppAlertTone; title: string; description?: string }
type PendingDelete = { kind: 'item' | 'folder'; id: string; name: string }
type SearchSuggestion = { kind: 'item' | 'folder'; id: string; label: string; detail: string }
type FolderOption = { folder: InspirationFolder; depth: number }

function formatDate(value: number): string {
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function fileNameFor(item: InspirationItem): string {
  const base = item.title.trim().replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || '灵感笔记'
  return `${base}.${item.format}`
}

function kindIcon(item: InspirationItem) {
  if (item.kind === 'video') return <Video size={15} aria-hidden="true" />
  if (item.kind === 'source') return <BookOpen size={15} aria-hidden="true" />
  return <FileText size={15} aria-hidden="true" />
}

function isWebSource(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function updateItem(library: InspirationLibrary, itemId: string, patch: Partial<InspirationItem>): InspirationLibrary {
  return {
    ...library,
    items: library.items.map((item) => item.id === itemId ? { ...item, ...patch, updatedAt: Date.now() } : item),
  }
}

function flattenFolders(folders: InspirationFolder[], parentId: string | null = null, depth = 0): FolderOption[] {
  return folders
    .filter((folder) => folder.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((folder) => [{ folder, depth }, ...flattenFolders(folders, folder.id, depth + 1)])
}

export function InspirationLibraryPanel({ onOpenSources, searchRef }: { onOpenSources: () => void; searchRef?: Ref<HTMLInputElement> }) {
  const [library, setLibrary] = useState<InspirationLibrary>(() => loadInspirationLibrary())
  const [folderFilter, setFolderFilter] = useState<FolderFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(-1)
  const [folderDraft, setFolderDraft] = useState('')
  const [folderParentDraft, setFolderParentDraft] = useState<string | null>(null)
  const [showFolderForm, setShowFolderForm] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [contentDraft, setContentDraft] = useState('')
  const [formatDraft, setFormatDraft] = useState<'md' | 'txt'>('md')
  const [itemFolderDraft, setItemFolderDraft] = useState<string>('')
  const [viewMode, setViewMode] = useState<ViewMode>('edit')
  const [toast, setToast] = useState<ToastState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const searchContainerRef = useRef<HTMLDivElement>(null)
  const toastSequenceRef = useRef(0)
  const deleteConfirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const reload = () => setLibrary(loadInspirationLibrary())
    window.addEventListener(INSPIRATION_LIBRARY_EVENT, reload)
    return () => window.removeEventListener(INSPIRATION_LIBRARY_EVENT, reload)
  }, [])

  useEffect(() => {
    const closeSearch = (event: PointerEvent) => {
      if (!searchContainerRef.current?.contains(event.target as Node)) setSearchOpen(false)
    }
    document.addEventListener('pointerdown', closeSearch)
    return () => document.removeEventListener('pointerdown', closeSearch)
  }, [])

  useEffect(() => {
    if (!pendingDelete) return
    deleteConfirmRef.current?.focus()
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setPendingDelete(null)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [pendingDelete])

  const selectedItem = library.items.find((item) => item.id === selectedId) ?? null

  useEffect(() => {
    if (!selectedItem) {
      const first = library.items.find((item) => item.folderId === null)
      if (first) setSelectedId(first.id)
      return
    }
    setTitleDraft(selectedItem.title)
    setContentDraft(selectedItem.content)
    setFormatDraft(selectedItem.format)
    setItemFolderDraft(selectedItem.folderId ?? '')
  }, [selectedItem?.id, selectedItem?.folderId, library.items.length])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleItems = useMemo(() => library.items.filter((item) => {
    const inFolder = folderFilter === 'all' ? item.folderId === null : item.folderId === folderFilter
    if (!inFolder) return false
    if (!normalizedQuery) return true
    return [item.title, item.content, item.source ?? ''].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
  }).sort((a, b) => b.updatedAt - a.updatedAt), [folderFilter, library.items, normalizedQuery])

  const visibleFolders = useMemo(() => library.folders.filter((folder) => {
    const parentId = folderFilter === 'all' ? null : folderFilter
    if (folder.parentId !== parentId) return false
    return !normalizedQuery || folder.name.toLocaleLowerCase().includes(normalizedQuery)
  }).sort((a, b) => a.name.localeCompare(b.name)), [folderFilter, library.folders, normalizedQuery])

  const folderOptions = useMemo(() => flattenFolders(library.folders), [library.folders])
  const currentFolder = folderFilter === 'all' ? null : library.folders.find((folder) => folder.id === folderFilter) ?? null
  const currentFolderTitle = currentFolder?.name ?? '全部灵感'

  const searchSuggestions = useMemo<SearchSuggestion[]>(() => {
    if (!normalizedQuery) return []
    const itemSuggestions = library.items
      .filter((item) => [item.title, item.content, item.source ?? ''].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 6)
      .map((item) => ({ kind: 'item' as const, id: item.id, label: item.title || '未命名灵感', detail: `${inspirationKindLabel(item.kind)} · ${formatDate(item.updatedAt)}` }))
    const folderSuggestions = library.folders
      .filter((folder) => folder.name.toLocaleLowerCase().includes(normalizedQuery))
      .slice(0, 4)
      .map((folder) => ({ kind: 'folder' as const, id: folder.id, label: folder.name, detail: '文件夹' }))
    return [...itemSuggestions, ...folderSuggestions].slice(0, 8)
  }, [library.folders, library.items, normalizedQuery])

  const showToast = (tone: AppAlertTone, title: string, description?: string) => {
    setToast({ id: ++toastSequenceRef.current, tone, title, description })
  }

  const persist = (next: InspirationLibrary, success?: { title: string; description?: string }): boolean => {
    if (!saveInspirationLibrary(next)) {
      showToast('error', '保存失败', '请检查本地存储空间后重试')
      return false
    }
    setLibrary(next)
    if (success) showToast('success', success.title, success.description)
    return true
  }

  const createNote = () => {
    const item = addInspirationItem({
      title: '未命名灵感',
      content: '# 未命名灵感\n\n',
      kind: 'note',
      format: 'md',
      folderId: folderFilter === 'all' ? null : folderFilter,
    })
    if (!item) {
      showToast('error', '创建笔记失败', '请检查本地存储空间后重试')
      return
    }
    setLibrary(loadInspirationLibrary())
    setSelectedId(item.id)
    setViewMode('edit')
    showToast('success', '已新建笔记', '可以开始记录你的想法了')
  }

  const openFolderForm = (parentId: string | null = folderFilter === 'all' ? null : folderFilter) => {
    if (showFolderForm && folderParentDraft === parentId) {
      setShowFolderForm(false)
      return
    }
    setFolderParentDraft(parentId)
    setFolderDraft('')
    setShowFolderForm(true)
  }

  const createFolder = (event: FormEvent) => {
    event.preventDefault()
    if (!folderDraft.trim()) {
      showToast('warning', '请输入文件夹名称')
      return
    }
    const folder = addInspirationFolder(folderDraft, folderParentDraft)
    if (!folder) {
      showToast('error', '创建文件夹失败', '请检查本地存储空间后重试')
      return
    }
    setLibrary(loadInspirationLibrary())
    setFolderFilter(folder.id)
    setFolderDraft('')
    setShowFolderForm(false)
    showToast('success', `已创建文件夹“${folder.name}”`)
  }

  const saveSelected = () => {
    if (!selectedItem) return
    const title = titleDraft.trim() || '未命名灵感'
    const next = updateItem(library, selectedItem.id, {
      title,
      content: contentDraft,
      format: formatDraft,
      folderId: itemFolderDraft || null,
    })
    persist(next, { title: `已保存“${title}”` })
  }

  const requestDeleteSelected = () => {
    if (selectedItem) setPendingDelete({ kind: 'item', id: selectedItem.id, name: selectedItem.title || '未命名灵感' })
  }

  const requestDeleteFolder = (folderId: string) => {
    const folder = library.folders.find((item) => item.id === folderId)
    if (folder) setPendingDelete({ kind: 'folder', id: folder.id, name: folder.name })
  }

  const confirmDelete = () => {
    if (!pendingDelete) return
    if (pendingDelete.kind === 'item') {
      const next = { ...library, items: library.items.filter((item) => item.id !== pendingDelete.id) }
      if (!persist(next, { title: `已删除笔记“${pendingDelete.name}”` })) return
      setSelectedId(next.items[0]?.id ?? null)
      setPendingDelete(null)
      return
    }

    const folder = library.folders.find((item) => item.id === pendingDelete.id)
    if (!folder) {
      setPendingDelete(null)
      return
    }
    const parentId = folder.parentId
    const now = Date.now()
    const next: InspirationLibrary = {
      ...library,
      folders: library.folders
        .filter((item) => item.id !== folder.id)
        .map((item) => item.parentId === folder.id ? { ...item, parentId } : item),
      items: library.items.map((item) => item.folderId === folder.id ? { ...item, folderId: parentId, updatedAt: now } : item),
    }
    if (!persist(next, { title: `已删除文件夹“${folder.name}”`, description: '其中的笔记和子文件夹已移到上一级' })) return
    setFolderFilter(parentId ?? 'all')
    setPendingDelete(null)
  }

  const exportSelected = async () => {
    if (!selectedItem) return
    const fileName = fileNameFor({ ...selectedItem, title: titleDraft, format: formatDraft })
    try {
      const saved = await saveTextFileAs(fileName, contentDraft)
      if (saved) showToast('success', `已导出“${fileName}”`)
    } catch {
      showToast('error', '导出失败', '请重试或检查文件保存权限')
    }
  }

  const selectSuggestion = (suggestion: SearchSuggestion) => {
    if (suggestion.kind === 'folder') {
      setFolderFilter(suggestion.id)
    } else {
      const item = library.items.find((candidate) => candidate.id === suggestion.id)
      if (item) {
        setSelectedId(item.id)
        setFolderFilter(item.folderId ?? 'all')
      }
    }
    setQuery('')
    setSearchOpen(false)
    setActiveSuggestion(-1)
  }

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setSearchOpen(false)
      setActiveSuggestion(-1)
      return
    }
    if (!searchOpen || searchSuggestions.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveSuggestion((index) => Math.min(index + 1, searchSuggestions.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveSuggestion((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter' && activeSuggestion >= 0) {
      event.preventDefault()
      selectSuggestion(searchSuggestions[activeSuggestion])
    }
  }

  const renderFolderTree = (parentId: string | null, depth = 0): ReactNode => library.folders
    .filter((folder) => folder.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((folder) => (
      <div key={folder.id} className="inspiration-library-folder-tree-node">
        <div className="inspiration-library-folder-row" style={{ paddingLeft: `${depth * 14}px` }}>
          <button
            type="button"
            data-testid={`inspiration-folder-${folder.id}`}
            className={folderFilter === folder.id ? 'is-active' : ''}
            onClick={() => setFolderFilter(folder.id)}
          >
            {folderFilter === folder.id ? <FolderOpen size={15} /> : <Folder size={15} />}
            <span>{folder.name}</span>
            <span>{library.items.filter((item) => item.folderId === folder.id).length}</span>
          </button>
          <button type="button" aria-label={`在 ${folder.name} 中新建子文件夹`} title="新建子文件夹" onClick={() => openFolderForm(folder.id)}><FolderPlus size={13} /></button>
          <button type="button" aria-label={`删除文件夹 ${folder.name}`} title="删除文件夹" onClick={() => requestDeleteFolder(folder.id)}><Trash2 size={13} /></button>
        </div>
        {renderFolderTree(folder.id, depth + 1)}
      </div>
    ))

  const hasContent = library.items.length > 0 || library.folders.length > 0
  const listCount = visibleItems.length + visibleFolders.length
  const dialogTitleId = 'inspiration-delete-dialog-title'

  return (
    <div data-testid="inspiration-library" className="inspiration-library-page">
      {toast && (
        <AppNotificationPortal>
          <AppAlert
            key={toast.id}
            testId="inspiration-library-toast"
            className="inspiration-library-toast"
            tone={toast.tone}
            title={toast.title}
            description={toast.description}
            durationMs={3200}
            onExpire={() => setToast(null)}
            onClose={() => setToast(null)}
          />
        </AppNotificationPortal>
      )}

      <header className="inspiration-library-header">
        <div className="inspiration-library-heading">
          <span>PERSONAL LIBRARY</span>
          <h1>灵感库</h1>
          <p>把值得回看的视频、来源和想法放在一个地方。</p>
        </div>
        <div className="inspiration-library-header-actions">
          <div className="inspiration-library-switch" role="group" aria-label="灵感工作区">
            <button type="button" data-testid="inspiration-library-tab" aria-pressed="true" title="查看灵感库">
              <FolderOpen size={15} aria-hidden="true" />灵感库
            </button>
            <button type="button" data-testid="inspiration-sources-tab" aria-pressed="false" onClick={onOpenSources} title="获取新的灵感">
              <BookOpen size={15} aria-hidden="true" />灵感来源
            </button>
          </div>
          <div ref={searchContainerRef} className="inspiration-library-search-wrap">
            <label className="inspiration-library-search">
              <Search size={16} aria-hidden="true" />
              <input
                ref={searchRef}
                data-testid="nav-search"
                data-library-search
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={searchOpen}
                aria-controls="inspiration-search-listbox"
                aria-activedescendant={activeSuggestion >= 0 ? `inspiration-search-option-${activeSuggestion}` : undefined}
                value={query}
                onFocus={() => setSearchOpen(true)}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setSearchOpen(true)
                  setActiveSuggestion(-1)
                }}
                onKeyDown={handleSearchKeyDown}
                placeholder="搜索灵感"
                aria-label="搜索灵感"
              />
              {query && <button type="button" aria-label="清除搜索" title="清除搜索" onClick={() => { setQuery(''); setSearchOpen(false); setActiveSuggestion(-1) }}><X size={14} /></button>}
            </label>
            {searchOpen && normalizedQuery && (
              <div id="inspiration-search-listbox" className="inspiration-library-search-listbox" role="listbox" aria-label="搜索建议">
                {searchSuggestions.length > 0 ? searchSuggestions.map((suggestion, index) => (
                  <div
                    key={`${suggestion.kind}-${suggestion.id}`}
                    id={`inspiration-search-option-${index}`}
                    role="option"
                    aria-selected={index === activeSuggestion}
                    className={index === activeSuggestion ? 'is-active' : ''}
                    onMouseDown={(event) => { event.preventDefault(); selectSuggestion(suggestion) }}
                    onClick={() => selectSuggestion(suggestion)}
                  >
                    {suggestion.kind === 'folder' ? <Folder size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
                    <span><strong>{suggestion.label}</strong><small>{suggestion.detail}</small></span>
                  </div>
                )) : <p className="inspiration-library-search-empty">暂无匹配建议</p>}
              </div>
            )}
          </div>
        </div>
      </header>

      {!hasContent ? (
        <section data-testid="inspiration-library-empty" className="inspiration-library-empty">
          <div className="inspiration-library-empty-icon"><FolderOpen size={30} aria-hidden="true" /></div>
          <h2>还没有灵感</h2>
          <p>先去获取灵感，或写下一个想法。视频解析结果也可以直接收进这里。</p>
          <div className="inspiration-library-empty-actions">
            <button type="button" className="inspiration-library-primary-action" onClick={createNote}><FilePlus2 size={16} aria-hidden="true" />新建笔记</button>
            <button type="button" className="inspiration-library-secondary-action" onClick={() => openFolderForm(null)}><FolderPlus size={16} aria-hidden="true" />新建文件夹</button>
            <button type="button" className="inspiration-library-secondary-action" onClick={onOpenSources}><BookOpen size={16} aria-hidden="true" />去找灵感</button>
          </div>
          {showFolderForm && (
            <form className="inspiration-library-empty-folder-form" onSubmit={createFolder}>
              <input autoFocus value={folderDraft} onChange={(event) => setFolderDraft(event.target.value)} placeholder="文件夹名称" aria-label="文件夹名称" />
              <button type="submit" className="inspiration-library-primary-action"><Check size={14} aria-hidden="true" />创建</button>
            </form>
          )}
        </section>
      ) : (
        <div className="inspiration-library-workspace">
          <aside className="inspiration-library-sidebar scroll-fade" aria-label="灵感文件夹">
            <div className="inspiration-library-sidebar-heading">
              <strong>文件夹</strong>
              <button type="button" aria-label="新建文件夹" title="新建文件夹" onClick={() => openFolderForm()}><FolderPlus size={16} /></button>
            </div>
            {showFolderForm && (
              <form className="inspiration-library-folder-form" onSubmit={createFolder}>
                <input autoFocus value={folderDraft} onChange={(event) => setFolderDraft(event.target.value)} placeholder="文件夹名称" aria-label="文件夹名称" />
                {folderParentDraft && <small>位置：{library.folders.find((folder) => folder.id === folderParentDraft)?.name}</small>}
                <button type="submit" aria-label="确认新建文件夹" title="确认"><Check size={14} /></button>
              </form>
            )}
            <nav className="inspiration-library-folder-list">
              <button type="button" className={folderFilter === 'all' ? 'is-active' : ''} onClick={() => setFolderFilter('all')}><FolderOpen size={15} />全部灵感<span>{library.items.filter((item) => item.folderId === null).length}</span></button>
              {renderFolderTree(null)}
            </nav>
          </aside>

          <section className="inspiration-library-list-pane" aria-label="灵感列表">
            <div className="inspiration-library-pane-heading">
              <div><strong>{currentFolderTitle}</strong><span>{listCount} 项</span></div>
              <button type="button" className="inspiration-library-primary-action" onClick={createNote}><FilePlus2 size={15} aria-hidden="true" />新建笔记</button>
            </div>
            <div className="inspiration-library-items scroll-fade">
              {listCount === 0 ? <p className="inspiration-library-no-results">没有匹配的灵感</p> : (
                <>
                  {visibleFolders.map((folder) => (
                    <button type="button" key={folder.id} data-testid={`inspiration-folder-item-${folder.id}`} className="inspiration-library-folder-item" onClick={() => setFolderFilter(folder.id)}>
                      <span className="inspiration-library-item-icon"><FolderOpen size={15} aria-hidden="true" /></span>
                      <span className="inspiration-library-item-copy"><strong>{folder.name}</strong><small>文件夹 · {library.items.filter((item) => item.folderId === folder.id).length} 项</small><em>打开文件夹</em></span>
                    </button>
                  ))}
                  {visibleItems.map((item) => (
                    <button type="button" key={item.id} data-testid={`inspiration-item-${item.id}`} className={`inspiration-library-item${item.id === selectedId ? ' is-selected' : ''}`} onClick={() => setSelectedId(item.id)}>
                      <span className={`inspiration-library-item-icon is-${item.kind}`}>{kindIcon(item)}</span>
                      <span className="inspiration-library-item-copy"><strong>{item.title || '未命名灵感'}</strong><small>{inspirationKindLabel(item.kind)} · {formatDate(item.updatedAt)}</small><em>{item.content.replace(/[#*_`\n]/g, ' ').trim() || '空白笔记'}</em></span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </section>

          <section className="inspiration-library-editor" aria-label="灵感内容">
            {selectedItem ? (
              <>
                <div className="inspiration-library-editor-heading">
                  <div className="inspiration-library-editor-title"><Pencil size={15} aria-hidden="true" /><input data-testid="inspiration-title-input" value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} aria-label="灵感标题" /></div>
                  <div className="inspiration-library-editor-actions">
                    <div className="inspiration-library-view-switch" role="group" aria-label="内容视图">
                      <button type="button" aria-pressed={viewMode === 'edit'} onClick={() => setViewMode('edit')} title="编辑"><Pencil size={14} /></button>
                      <button type="button" aria-pressed={viewMode === 'read'} onClick={() => setViewMode('read')} title="阅读"><Eye size={14} /></button>
                    </div>
                    <button type="button" aria-label="导出文件" title="导出文件" onClick={() => { void exportSelected() }}><Download size={15} /></button>
                    <button type="button" aria-label="删除灵感" title="删除灵感" onClick={requestDeleteSelected}><Trash2 size={15} /></button>
                  </div>
                </div>
                <div className="inspiration-library-editor-meta">
                  <span>{inspirationKindLabel(selectedItem.kind)}</span>
                  {selectedItem.source && (isWebSource(selectedItem.source)
                    ? <a href={selectedItem.source} target="_blank" rel="noreferrer">打开来源</a>
                    : <span>来源：{selectedItem.source}</span>)}
                  <label>文件夹
                    <select value={itemFolderDraft} onChange={(event) => setItemFolderDraft(event.target.value)} aria-label="选择文件夹">
                      <option value="">灵感库（根目录）</option>
                      {folderOptions.map(({ folder, depth }) => <option key={folder.id} value={folder.id}>{`${'  '.repeat(depth)}${folder.name}`}</option>)}
                    </select>
                  </label>
                  <label>格式
                    <select value={formatDraft} onChange={(event) => setFormatDraft(event.target.value as 'md' | 'txt')} aria-label="选择文件格式"><option value="md">Markdown</option><option value="txt">纯文本</option></select>
                  </label>
                </div>
                {viewMode === 'edit' ? (
                  <textarea data-testid="inspiration-content-input" value={contentDraft} onChange={(event) => setContentDraft(event.target.value)} aria-label="灵感内容" placeholder="写下你的想法…" />
                ) : (
                  <div data-testid="inspiration-content-preview" className="inspiration-library-preview scroll-fade"><Markdown>{contentDraft || '*还没有内容*'}</Markdown></div>
                )}
                <div className="inspiration-library-editor-footer">
                  <span>更新于 {formatDate(selectedItem.updatedAt)}</span>
                  <button type="button" className="inspiration-library-primary-action" onClick={saveSelected}><Check size={15} aria-hidden="true" />保存</button>
                </div>
              </>
            ) : (
              <div className="inspiration-library-editor-empty"><FileText size={22} /><span>选择一条灵感开始阅读或编辑</span></div>
            )}
          </section>
        </div>
      )}

      {hasContent && <div className="inspiration-library-mobile-add"><button type="button" className="inspiration-library-primary-action" onClick={createNote}><FilePlus2 size={15} />新建笔记</button></div>}

      {pendingDelete && (
        <div
          className="inspiration-library-dialog-backdrop"
          data-testid="inspiration-delete-dialog-backdrop"
          onClick={(event) => { if (event.target === event.currentTarget) setPendingDelete(null) }}
        >
          <section className="inspiration-library-dialog" role="dialog" aria-modal="true" aria-labelledby={dialogTitleId}>
            <div className="inspiration-library-dialog-heading">
              <h2 id={dialogTitleId}>{pendingDelete.kind === 'item' ? '删除笔记？' : '删除文件夹？'}</h2>
              <button type="button" aria-label="关闭确认窗口" title="关闭" onClick={() => setPendingDelete(null)}><X size={18} /></button>
            </div>
            <p>将删除“{pendingDelete.name}”。</p>
            <p className="inspiration-library-dialog-detail">{pendingDelete.kind === 'folder' ? '其中的笔记和子文件夹会移到上一级。' : '删除后无法从灵感库中恢复。'}</p>
            <div className="inspiration-library-dialog-actions">
              <button type="button" className="inspiration-library-secondary-action" onClick={() => setPendingDelete(null)}>取消</button>
              <button ref={deleteConfirmRef} type="button" className="inspiration-library-danger-action" onClick={confirmDelete}>删除</button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
