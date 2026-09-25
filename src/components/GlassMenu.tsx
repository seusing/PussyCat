import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import '../vendor/hyalite/hyalite.js'
import './GlassMenu.css'

export interface GlassOption {
  value: string
  label: string
  disabled?: boolean
  group?: string
}

const HYALITE_OPTIONS = {
  bevel: 4,
  thickness: 2,
  slope: 0.30,
  shade: 0,
  edgeW: 0.5,
  rim: 2,
  blur: 4.5,
  dispersion: 0.8,
  light: -55,
  materialize: 120,
  settle: 90,
} as const

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

export function useGlassMenuSurface(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const element = ref.current
    const hyalite = window.Hyalite
    if (!active || !element || !hyalite?.supported()) return
    hyalite.attach(element, {
      ...HYALITE_OPTIONS,
      ...(reducedMotion() ? { materialize: 0, settle: 0, dispersion: 0 } : {}),
    })
    return () => hyalite.detach(element)
  }, [active, ref])
}

type MenuPosition = { top: number; left: number; width: number; maxHeight: number }

function positionMenu(trigger: HTMLElement, menu: HTMLElement): MenuPosition {
  const gap = 6
  const margin = 8
  const rect = trigger.getBoundingClientRect()
  const naturalHeight = Math.max(menu.scrollHeight, menu.getBoundingClientRect().height)
  const width = Math.min(Math.max(rect.width, menu.scrollWidth, 160), Math.max(160, window.innerWidth - margin * 2))
  const below = window.innerHeight - rect.bottom - gap - margin
  const above = rect.top - gap - margin
  const openAbove = below < Math.min(naturalHeight, 220) && above > below
  const maxHeight = Math.max(80, openAbove ? above : below)
  const shownHeight = Math.min(naturalHeight, maxHeight)
  const top = openAbove ? Math.max(margin, rect.top - gap - shownHeight) : Math.min(rect.bottom + gap, window.innerHeight - margin - shownHeight)
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - margin - width))
  return { top, left, width, maxHeight }
}

function usePortalMenu(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLDivElement | null>,
  close: () => void,
): MenuPosition | null {
  const [position, setPosition] = useState<MenuPosition | null>(null)
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) {
      setPosition(null)
      return
    }
    setPosition(positionMenu(triggerRef.current, menuRef.current))
  }, [open, triggerRef, menuRef])
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close()
    }
    const onViewportChange = () => {
      if (triggerRef.current && menuRef.current) setPosition(positionMenu(triggerRef.current, menuRef.current))
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [open, close, triggerRef, menuRef])
  return position
}

function enabledIndexes(options: readonly GlassOption[]): number[] {
  return options.flatMap((option, index) => option.disabled ? [] : [index])
}

function nextEnabled(options: readonly GlassOption[], current: number, direction: 1 | -1): number {
  const enabled = enabledIndexes(options)
  if (!enabled.length) return -1
  const position = enabled.indexOf(current)
  if (position < 0) return direction === 1 ? enabled[0] : enabled[enabled.length - 1]
  return enabled[(position + direction + enabled.length) % enabled.length]
}

function menuStyle(position: MenuPosition | null): CSSProperties {
  return position
    ? { top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight, visibility: 'visible' }
    : { top: 0, left: 0, visibility: 'hidden' }
}

export interface GlassSelectProps {
  value: string
  onChange: (value: string) => void
  options: readonly GlassOption[]
  'aria-label': string
  disabled?: boolean
  className?: string
  style?: CSSProperties
  id?: string
  'data-testid'?: string
  placeholder?: string
  title?: string
}

export interface GlassMultiSelectProps {
  value: readonly string[]
  onChange: (value: string[]) => void
  options: readonly GlassOption[]
  'aria-label': string
  disabled?: boolean
  className?: string
  style?: CSSProperties
  id?: string
  'data-testid'?: string
  placeholder?: string
}

export function GlassMultiSelect({ value, onChange, options, disabled, className = '', style, id, placeholder = '— 还没指定 —', ...aria }: GlassMultiSelectProps) {
  const listboxId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef(new Map<number, HTMLButtonElement>())
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const close = () => setOpen(false)
  const position = usePortalMenu(open, triggerRef, menuRef, close)
  useGlassMenuSurface(menuRef, open)
  const selected = new Set(value)
  useEffect(() => {
    if (!open) return
    const selectedIndex = options.findIndex((option) => selected.has(option.value) && !option.disabled)
    const target = selectedIndex >= 0 ? selectedIndex : nextEnabled(options, -1, 1)
    focusIndex(target)
  // Only initialize on the closed -> open edge. Toggling must keep the current option focused.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const toggle = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(selected.has(option.value) ? value.filter((item) => item !== option.value) : [...value, option.value])
  }
  const focusIndex = (index: number) => {
    setActiveIndex(index)
    requestAnimationFrame(() => optionRefs.current.get(index)?.focus({ preventScroll: true }))
  }
  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' && open) { event.preventDefault(); close(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return
    event.preventDefault()
    if (!open) { setOpen(true); focusIndex(event.key === 'End' || event.key === 'ArrowUp' ? enabledIndexes(options).at(-1) ?? -1 : enabledIndexes(options)[0] ?? -1); return }
  }
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next = activeIndex
    if (event.key === 'ArrowDown') next = nextEnabled(options, activeIndex, 1)
    else if (event.key === 'ArrowUp') next = nextEnabled(options, activeIndex, -1)
    else if (event.key === 'Home') next = enabledIndexes(options)[0] ?? -1
    else if (event.key === 'End') next = enabledIndexes(options).at(-1) ?? -1
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(activeIndex); return }
    else if (event.key === 'Escape') { event.preventDefault(); close(); triggerRef.current?.focus(); return }
    else if (event.key === 'Tab') { close(); return }
    else return
    event.preventDefault(); focusIndex(next)
  }
  return <>
    <button {...aria} ref={triggerRef} id={id} type="button" role="combobox" aria-controls={listboxId} aria-expanded={open} aria-haspopup="listbox" disabled={disabled} className={`glass-select-trigger ${className}`.trim()} style={style} onClick={() => setOpen((current) => !current)} onKeyDown={onTriggerKeyDown}>
      <span className="glass-menu-content glass-select-value">{value.length ? `已选 ${value.length} 个` : placeholder}</span>
      <ChevronDown className="glass-menu-content glass-select-chevron" size={15} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={menuRef} id={listboxId} role="listbox" aria-label={aria['aria-label']} aria-multiselectable="true" className="glass-menu-surface" style={menuStyle(position)} onKeyDown={onMenuKeyDown}>
      <div className="glass-menu-content">{options.map((option, index) => {
        const selectedIndex = value.indexOf(option.value)
        return <button key={option.value} ref={(element) => { if (element) optionRefs.current.set(index, element); else optionRefs.current.delete(index) }} type="button" role="option" aria-selected={selected.has(option.value)} disabled={option.disabled} tabIndex={index === activeIndex ? 0 : -1} className="glass-menu-option glass-multi-option" onMouseMove={() => !option.disabled && setActiveIndex(index)} onClick={() => toggle(index)}>
          <span className="glass-multi-check" data-priority={selectedIndex >= 0 ? selectedIndex + 1 : undefined} aria-label={selectedIndex >= 0 ? `优先级 ${selectedIndex + 1}` : '未选择'}>{selectedIndex >= 0 ? selectedIndex + 1 : ''}</span>
          <span>{option.label}{option.disabled ? '（已停用）' : ''}</span>
        </button>
      })}</div>
    </div>, document.body)}
  </>
}

export function GlassSelect({ value, onChange, options, disabled, className = '', style, id, placeholder, ...aria }: GlassSelectProps) {
  const listboxId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef(new Map<number, HTMLButtonElement>())
  const openingIndexRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const selectedIndex = options.findIndex((option) => option.value === value)
  const [activeIndex, setActiveIndex] = useState(selectedIndex)
  const close = () => setOpen(false)
  const position = usePortalMenu(open, triggerRef, menuRef, close)
  useGlassMenuSurface(menuRef, open)

  useEffect(() => {
    if (!open) return
    const requested = openingIndexRef.current
    openingIndexRef.current = null
    const initial = requested !== null
      ? requested
      : options[selectedIndex]?.disabled ? nextEnabled(options, selectedIndex, 1) : selectedIndex
    const target = initial >= 0 ? initial : nextEnabled(options, -1, 1)
    setActiveIndex(target)
    requestAnimationFrame(() => optionRefs.current.get(target)?.focus({ preventScroll: true }))
  }, [open, options, selectedIndex])

  const choose = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    close()
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }
  const openAt = (index: number) => {
    if (disabled) return
    openingIndexRef.current = index
    setActiveIndex(index)
    setOpen(true)
  }
  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (open && event.key === 'Escape') {
      event.preventDefault()
      close()
      triggerRef.current?.focus({ preventScroll: true })
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return
    event.preventDefault()
    const enabled = enabledIndexes(options)
    const index = event.key === 'End' || event.key === 'ArrowUp' ? enabled.at(-1) : enabled[0]
    openAt(index ?? -1)
  }
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next = activeIndex
    if (event.key === 'ArrowDown') next = nextEnabled(options, activeIndex, 1)
    else if (event.key === 'ArrowUp') next = nextEnabled(options, activeIndex, -1)
    else if (event.key === 'Home') next = enabledIndexes(options)[0] ?? -1
    else if (event.key === 'End') next = enabledIndexes(options).at(-1) ?? -1
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(activeIndex)
      return
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
      triggerRef.current?.focus()
      return
    } else if (event.key === 'Tab') {
      close()
      return
    } else return
    event.preventDefault()
    setActiveIndex(next)
    optionRefs.current.get(next)?.focus({ preventScroll: true })
  }
  const selected = options[selectedIndex]
  return (
    <>
      <button
        {...aria}
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        data-value={value}
        disabled={disabled}
        className={`glass-select-trigger ${className}`.trim()}
        style={style}
        onClick={() => open ? close() : openAt(selectedIndex)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="glass-menu-content glass-select-value">{selected?.label || placeholder || value}</span>
        <ChevronDown className="glass-menu-content glass-select-chevron" size={15} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div ref={menuRef} id={listboxId} role="listbox" aria-label={aria['aria-label']} className="glass-menu-surface" style={menuStyle(position)} onKeyDown={onMenuKeyDown}>
          <div className="glass-menu-content">
            {options.map((option, index) => {
              const showGroup = option.group && option.group !== options[index - 1]?.group
              return <div key={`${option.group ?? ''}-${option.value}`}>
                {showGroup && <div className="glass-menu-group" role="presentation">{option.group}</div>}
                <button
                  ref={(element) => { if (element) optionRefs.current.set(index, element); else optionRefs.current.delete(index) }}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  data-value={option.value}
                  disabled={option.disabled}
                  tabIndex={index === activeIndex ? 0 : -1}
                  className="glass-menu-option"
                  onMouseMove={() => !option.disabled && setActiveIndex(index)}
                  onClick={() => choose(index)}
                >
                  <span>{option.label}</span>
                  {option.value === value && <Check size={14} aria-hidden="true" />}
                </button>
              </div>
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

export interface GlassComboboxProps {
  value: string
  onChange: (value: string) => void
  options: readonly GlassOption[]
  'aria-label': string
  disabled?: boolean
  className?: string
  style?: CSSProperties
  id?: string
  'data-testid'?: string
  placeholder?: string
  title?: string
}

export function GlassCombobox({ value, onChange, options, disabled, className = '', style, id, placeholder, ...aria }: GlassComboboxProps) {
  const listboxId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const filtered = useMemo(() => {
    const query = value.trim().toLocaleLowerCase()
    return options.filter((option) => !query || option.label.toLocaleLowerCase().includes(query) || option.value.toLocaleLowerCase().includes(query))
  }, [options, value])
  const close = () => setOpen(false)
  const position = usePortalMenu(open, inputRef, menuRef, close)
  useGlassMenuSurface(menuRef, open)
  useEffect(() => {
    if (open) setActiveIndex(nextEnabled(filtered, -1, 1))
  }, [open, filtered])
  const choose = (index: number) => {
    const option = filtered[index]
    if (!option || option.disabled) return
    onChange(option.value)
    close()
    inputRef.current?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) setOpen(true)
      else setActiveIndex(nextEnabled(filtered, activeIndex, event.key === 'ArrowDown' ? 1 : -1))
    } else if (event.key === 'Home' && open) {
      event.preventDefault(); setActiveIndex(enabledIndexes(filtered)[0] ?? -1)
    } else if (event.key === 'End' && open) {
      event.preventDefault(); setActiveIndex(enabledIndexes(filtered).at(-1) ?? -1)
    } else if ((event.key === 'Enter' || event.key === ' ') && open && activeIndex >= 0) {
      event.preventDefault(); choose(activeIndex)
    } else if (event.key === 'Escape' && open) {
      event.preventDefault(); close()
    } else if (event.key === 'Tab') close()
  }
  return (
    <>
      <input
        {...aria}
        ref={inputRef}
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        disabled={disabled}
        className={`glass-combobox-input ${className}`.trim()}
        style={style}
        placeholder={placeholder}
        value={value}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(event) => { onChange(event.target.value); setOpen(true) }}
        onKeyDown={onKeyDown}
      />
      {open && createPortal(
        <div ref={menuRef} id={listboxId} role="listbox" aria-label={`${aria['aria-label']}建议`} className="glass-menu-surface" style={menuStyle(position)}>
          <div className="glass-menu-content">
            {filtered.length === 0 && <div className="glass-menu-empty">无匹配建议</div>}
            {filtered.map((option, index) => (
              <button
                id={`${listboxId}-${index}`}
                key={`${option.group ?? ''}-${option.value}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                data-value={option.value}
                disabled={option.disabled}
                tabIndex={-1}
                className="glass-menu-option"
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => !option.disabled && setActiveIndex(index)}
                onClick={() => choose(index)}
              >{option.label}</button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
