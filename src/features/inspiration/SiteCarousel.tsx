import { useState } from 'react'
import { motion } from 'motion/react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { BorderBeam } from 'border-beam'
import type { SupportedSite } from '../../data/supportedSites'

const SLIDE_WIDTH = 160

export function SiteCarousel({ sites, onSelect }: { sites: SupportedSite[]; onSelect: (site: SupportedSite) => void }) {
  const [activeIndex, setActiveIndex] = useState(() => Math.min(2, Math.max(0, sites.length - 1)))
  const [isHovered, setIsHovered] = useState(false)
  if (sites.length === 0) return null

  const toPrev = () => setActiveIndex((index) => Math.max(0, index - 1))
  const toNext = () => setActiveIndex((index) => Math.min(sites.length - 1, index + 1))
  const toSlide = (index: number) => setActiveIndex(index)

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
                style={{ width: SLIDE_WIDTH }}
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
                  onClick={() => { if (selected) onSelect(site); else toSlide(index) }}
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
