import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
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
  description?: string
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
  materialize: 0,
  settle: 0,
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

/**
 * 由 motion 驱动的上拉浮层(菜单、确认气泡)共用的进出动效:从触发按钮一侧淡入并展开,收起时反向。
 * 两者交叉淡入淡出时参数一致才不会各演各的;缩减动效时不位移不缩放,时长归零。
 * 这类浮层的 CSS 里要把 .glass-menu-effect 自带的 glass-menu-enter 关掉,否则它会盖住这里的 opacity / transform。
 */
export function glassPopMotion(reduceMotion: boolean | null) {
  const hidden = reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scaleY: 0.94 }
  const ease = [0.23, 1, 0.32, 1] as [number, number, number, number]
  return {
    initial: hidden,
    animate: { opacity: 1, y: 0, scaleY: 1, pointerEvents: 'auto' as const },
    exit: { ...hidden, pointerEvents: 'none' as const, transition: { duration: reduceMotion ? 0 : 0.15, ease } },
    transition: { duration: reduceMotion ? 0 : 0.18, ease },
  }
}

export function positionMenu(trigger: HTMLElement, menu: HTMLElement): MenuPosition {
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
  layoutKey?: string,
): MenuPosition | null {
  const [position, setPosition] = useState<MenuPosition | null>(null)
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) {
      setPosition(null)
      return
    }
    setPosition(positionMenu(triggerRef.current, menuRef.current))
  }, [open, triggerRef, menuRef, layoutKey])
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
  'aria-invalid'?: boolean
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

const MULTI_MAX_TAGS = 3

function filterOptions(options: readonly GlassOption[], query: string): readonly GlassOption[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return options
  return options.filter((option) => (
    option.label.toLocaleLowerCase().includes(needle) || (option.description?.toLocaleLowerCase().includes(needle) ?? false)
  ))
}

// 多选:已选项按优先级(选择顺序)显示成带序号的标签,输入框按名称或说明过滤下拉。
// 焦点始终留在输入框里,当前项用 aria-activedescendant 指示。
export function GlassMultiSelect({ value, onChange, options, disabled, className = '', style, id, placeholder = '— 还没指定 —', 'data-testid': testId, ...aria }: GlassMultiSelectProps) {
  const listboxId = useId()
  const fieldRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef(new Map<number, HTMLButtonElement>())
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const filtered = filterOptions(options, query)
  const selected = new Set(value)
  const close = () => { setOpen(false); setQuery('') }
  const position = usePortalMenu(open, fieldRef, menuRef, close, `${filtered.length}:${value.length}`)
  useGlassMenuSurface(menuRef, open)
  useEffect(() => {
    if (open) optionRefs.current.get(activeIndex)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex])

  const labelOf = (itemValue: string) => options.find((option) => option.value === itemValue)?.label ?? itemValue
  const shown = value.slice(0, MULTI_MAX_TAGS)
  const folded = value.slice(MULTI_MAX_TAGS)

  const openMenu = () => {
    const selectedIndex = filtered.findIndex((option) => selected.has(option.value) && !option.disabled)
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : nextEnabled(filtered, -1, 1))
    setOpen(true)
  }
  const toggle = (option: GlassOption | undefined) => {
    if (!option || option.disabled) return
    onChange(selected.has(option.value) ? value.filter((item) => item !== option.value) : [...value, option.value])
  }
  const remove = (itemValue: string) => {
    onChange(value.filter((item) => item !== itemValue))
    inputRef.current?.focus()
  }
  const onFieldClick = (event: MouseEvent<HTMLDivElement>) => {
    if (disabled) return
    inputRef.current?.focus()
    if (event.target === inputRef.current) { if (!open) openMenu(); return }
    if (open) close(); else openMenu()
  }
  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    const { key } = event
    if (key === 'Escape') {
      if (open) { event.preventDefault(); event.stopPropagation(); close() }
    } else if (key === 'Tab') {
      close()
    } else if (key === 'Backspace') {
      if (query === '' && value.length) { event.preventDefault(); onChange(value.slice(0, -1)) }
    } else if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault()
      if (open) setActiveIndex(nextEnabled(filtered, activeIndex, key === 'ArrowDown' ? 1 : -1))
      else openMenu()
    } else if (key === 'Enter' || (key === ' ' && query === '')) {
      // 空格只在没有过滤词时当作切换;有过滤词时是名称里的空格
      event.preventDefault()
      if (open) toggle(filtered[activeIndex]); else openMenu()
    } else if (open && key === 'Home') {
      event.preventDefault(); setActiveIndex(enabledIndexes(filtered)[0] ?? -1)
    } else if (open && key === 'End') {
      event.preventDefault(); setActiveIndex(enabledIndexes(filtered).at(-1) ?? -1)
    }
  }

  return <>
    <div ref={fieldRef} id={id} data-testid={testId} data-open={open} data-disabled={disabled || undefined} className={`glass-multi-field ${className}`.trim()} style={style} onClick={onFieldClick}>
      {shown.map((itemValue, index) => <span key={itemValue} className="glass-multi-tag">
        <span className="glass-multi-check" data-priority={index + 1} title={`优先级 ${index + 1}`}>{index + 1}</span>
        <span className="glass-multi-tag-label">{labelOf(itemValue)}</span>
        <button type="button" className="glass-multi-tag-remove" aria-label={`移除 ${labelOf(itemValue)}`} disabled={disabled} onClick={(event) => { event.stopPropagation(); remove(itemValue) }}>×</button>
      </span>)}
      {folded.length > 0 && <span className="glass-multi-more" title={folded.map(labelOf).join('、')}>+{folded.length}</span>}
      <input
        {...aria}
        ref={inputRef}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open && filtered[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
        disabled={disabled}
        className="glass-multi-input"
        placeholder={value.length ? undefined : placeholder}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActiveIndex(nextEnabled(filterOptions(options, event.target.value), -1, 1))
          setOpen(true)
        }}
        onKeyDown={onInputKeyDown}
      />
      <ChevronDown className="glass-select-chevron" size={15} aria-hidden="true" />
    </div>
    {open && createPortal(<div ref={menuRef} id={listboxId} role="listbox" aria-label={aria['aria-label']} aria-multiselectable="true" className="glass-menu-surface" style={menuStyle(position)} onMouseDown={(event) => event.preventDefault()}>
      <div className="glass-menu-content">
        {filtered.length === 0 && <div className="glass-menu-empty">没有匹配的配置</div>}
        {filtered.map((option, index) => {
          const priority = value.indexOf(option.value) + 1
          return <button key={option.value} id={`${listboxId}-${index}`} ref={(element) => { if (element) optionRefs.current.set(index, element); else optionRefs.current.delete(index) }} type="button" role="option" aria-selected={priority > 0} disabled={option.disabled} tabIndex={-1} data-active={index === activeIndex || undefined} className="glass-menu-option glass-multi-option" onMouseMove={() => !option.disabled && setActiveIndex(index)} onClick={() => toggle(option)}>
            <span className="glass-multi-option-text">
              <span className="glass-multi-option-label">{option.label}{option.disabled ? '（已停用）' : ''}</span>
              {option.description && <span className="glass-multi-option-desc">{option.description}</span>}
            </span>
            {priority > 0 && <span className="glass-multi-check" data-priority={priority} title={`优先级 ${priority}`}>{priority}</span>}
          </button>
        })}
      </div>
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
