import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, FolderInput, FolderPlus } from 'lucide-react'
import { menuStyle, useGlassMenuSurface, usePortalMenu } from '../../components/GlassMenu'
import type { InspirationFolder } from './inspirationLibrary'

type Destination = { folderId: string | null; label: string; depth: number }

function flattenFolders(folders: InspirationFolder[], parentId: string | null = null, depth = 1): Destination[] {
  return folders
    .filter((folder) => folder.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((folder) => [{ folderId: folder.id, label: folder.name, depth }, ...flattenFolders(folders, folder.id, depth + 1)])
}

export function MoveToFolderMenu({
  folders,
  currentFolderId,
  onMove,
  onMoveToNewFolder,
}: {
  folders: InspirationFolder[]
  currentFolderId: string | null
  onMove: (folderId: string | null) => void
  onMoveToNewFolder: (name: string) => boolean
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const close = () => { setOpen(false); setCreating(false) }
  const position = usePortalMenu(open, triggerRef, menuRef, close, creating ? 'create' : 'list')
  useGlassMenuSurface(menuRef, open)

  const destinations: Destination[] = [{ folderId: null, label: '灵感库（根目录）', depth: 0 }, ...flattenFolders(folders)]
  const newFolderIndex = destinations.length
  const enabled = [...destinations.flatMap((entry, index) => entry.folderId === currentFolderId ? [] : [index]), newFolderIndex]

  useEffect(() => {
    if (open && !creating) requestAnimationFrame(() => itemRefs.current[enabled[0]]?.focus({ preventScroll: true }))
  }, [open])

  const closeToTrigger = () => {
    close()
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }
  const choose = (folderId: string | null) => {
    closeToTrigger()
    onMove(folderId)
  }
  const startCreating = () => {
    setNameDraft('')
    setCreating(true)
  }
  const cancelCreating = () => {
    setCreating(false)
    requestAnimationFrame(() => itemRefs.current[newFolderIndex]?.focus({ preventScroll: true }))
  }
  const submitNewFolder = (event: FormEvent) => {
    event.preventDefault()
    if (nameDraft.trim() && onMoveToNewFolder(nameDraft)) closeToTrigger()
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeToTrigger()
      return
    }
    if (event.key === 'Tab') { close(); return }
    if (event.target instanceof HTMLInputElement) return
    const current = enabled.indexOf(itemRefs.current.findIndex((element) => element === document.activeElement))
    let next: number
    if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % enabled.length
    else if (event.key === 'ArrowUp') next = current < 0 ? enabled.length - 1 : (current - 1 + enabled.length) % enabled.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = enabled.length - 1
    else return
    event.preventDefault()
    itemRefs.current[enabled[next]]?.focus({ preventScroll: true })
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="移动到文件夹"
        title="移动到文件夹"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => open ? close() : setOpen(true)}
      ><FolderInput size={15} /></button>
      {open && createPortal(
        <div ref={menuRef} role="menu" aria-label="移动到文件夹" className="glass-menu-surface inspiration-move-menu" style={menuStyle(position)} onKeyDown={onMenuKeyDown}>
          <div className="glass-menu-content">
            {destinations.map((entry, index) => {
              const current = entry.folderId === currentFolderId
              return (
                <button
                  key={entry.folderId ?? 'root'}
                  ref={(element) => { itemRefs.current[index] = element }}
                  type="button"
                  role="menuitemradio"
                  aria-checked={current}
                  disabled={current}
                  tabIndex={-1}
                  className="glass-menu-option"
                  style={{ paddingLeft: 8 + entry.depth * 14 }}
                  onClick={() => choose(entry.folderId)}
                >
                  <span>{entry.label}</span>
                  {current && <Check size={14} aria-hidden="true" />}
                </button>
              )
            })}
            <div className="inspiration-move-menu-divider" role="separator" />
            {creating ? (
              <form className="inspiration-move-menu-create" onSubmit={submitNewFolder}>
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape') return
                    event.preventDefault()
                    event.stopPropagation()
                    cancelCreating()
                  }}
                  placeholder="新文件夹名称"
                  aria-label="新文件夹名称"
                />
              </form>
            ) : (
              <button
                ref={(element) => { itemRefs.current[newFolderIndex] = element }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="glass-menu-option inspiration-move-menu-new"
                onClick={startCreating}
              ><FolderPlus size={14} aria-hidden="true" /><span>移动到新建的文件夹…</span></button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
