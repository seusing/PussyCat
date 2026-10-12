import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { motion, useMotionValue } from 'motion/react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { BorderBeam } from 'border-beam'
import type { SupportedSite } from '../../data/supportedSites'

const SLIDE_WIDTH = 160

const swallowDoubleClick = (event: MouseEvent) => {
  if (event.detail > 1) {
    event.stopPropagation()
    event.preventDefault()
  }
}

export function SiteCarousel({ sites, onSelect }: { sites: SupportedSite[]; onSelect: (site: SupportedSite) => void }) {
  const [activeIndex, setActiveIndex] = useState(() => Math.min(2, Math.max(0, sites.length - 1)))
  const [isHovered, setIsHovered] = useState(false)
  const x = useMotionValue(0)
  if (sites.length === 0) return null

  const toSlide = (index: number) => setActiveIndex(index)
  const toPrev = () => toSlide(Math.max(0, activeIndex - 1))
  const toNext = () => toSlide(Math.min(sites.length - 1, activeIndex + 1))
  const openSite = (site: SupportedSite) => {
    // 单击就会换成命令列表,习惯双击时第二下会落在列表里某条命令上,所以只吞掉紧跟着的那次连击
    window.addEventListener('click', swallowDoubleClick, { capture: true, once: true })
    onSelect(site)
  }
  const onCardClick = (event: ReactMouseEvent, site: SupportedSite, index: number) => {
    // 连击的后几下不算:侧边卡第一下就开始滑了,后几下会落到滑到鼠标下的别的卡上
    if (event.detail > 1) return
    // 条带离目标不到半张卡时,每张卡都离自己的终点比离邻位近,鼠标下是谁不再有歧义;还没到这一步先忽略点击
    if (Math.abs(x.get() + activeIndex * SLIDE_WIDTH) >= SLIDE_WIDTH / 2) return
    if (index === activeIndex) openSite(site)
    else toSlide(index)
  }

  return (
    <div
      data-testid="site-carousel"
      className="site-carousel"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="site-carousel-track">
        <motion.div
          className="site-carousel-strip"
          style={{ x }}
          animate={{ x: -activeIndex * SLIDE_WIDTH }}
          transition={{ type: 'spring', bounce: 0.1, duration: 0.8 }}
        >
          {sites.map((site, index) => {
            const selected = activeIndex === index
            const diff = index - activeIndex
            return (
              <motion.div
                key={site.id}
                className="site-carousel-slide"
                style={{ width: SLIDE_WIDTH, zIndex: sites.length - Math.abs(diff) }}
                animate={{
                  rotate: isHovered ? diff * 20 : diff * 5,
                  scale: selected ? 1.05 : isHovered ? 0.65 : 0.8,
                  y: isHovered ? diff * 24 : 0,
                }}
                transition={{ type: 'spring', bounce: 0.2, duration: 0.8 }}
              >
                <div className={`site-carousel-title ${selected ? 'is-active' : ''}`}>
                  {site.label}
                </div>
                <BorderBeam
                  size="pulse-outside"
                  colorVariant="colorful"
                  strength={1}
                  borderRadius={12}
                  active={selected}
                  className="site-carousel-beam"
                >
                  <button
                    type="button"
                    data-testid={`site-row-${site.id}`}
                    data-selected={selected}
                    aria-label={`打开 ${site.label}`}
                    onClick={(event) => onCardClick(event, site, index)}
                    className="site-carousel-card"
                  >
                    <img src={site.logo} alt={site.label} />
                  </button>
                </BorderBeam>
              </motion.div>
            )
          })}
        </motion.div>
      </div>

      <div className="site-carousel-controls">
        <button type="button" onClick={toPrev} aria-label="上一个站点" disabled={activeIndex === 0}>
          <ChevronLeft size={15} />
        </button>
        <div className="site-carousel-dots" aria-label="站点位置">
          {sites.map((site, index) => (
            <button
              key={site.id}
              type="button"
              aria-label={`定位到 ${site.label}`}
              aria-pressed={activeIndex === index}
              onClick={() => toSlide(index)}
            />
          ))}
        </div>
        <button type="button" onClick={toNext} aria-label="下一个站点" disabled={activeIndex === sites.length - 1}>
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  )
}
