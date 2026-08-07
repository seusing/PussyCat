import { motion } from 'motion/react'
import './VideoSourceCoverFlow.css'

export type VideoSourceId = 'wechat' | 'x' | 'xiaohongshu' | 'youtube' | 'bilibili'

export interface DetectedVideoSource {
  id: VideoSourceId
  label: string
  logo: string
  count: number
}

interface VideoSourceDefinition {
  id: VideoSourceId
  label: string
  logo: string
  domains: readonly string[]
}

const VIDEO_SOURCES: readonly VideoSourceDefinition[] = [
  {
    id: 'wechat',
    label: '微信',
    logo: '/site-logos/wechat.svg',
    domains: ['weixin.qq.com', 'wechat.com'],
  },
  {
    id: 'x',
    label: 'X',
    logo: '/site-logos/x.svg',
    domains: ['x.com', 'twitter.com'],
  },
  {
    id: 'xiaohongshu',
    label: '小红书',
    logo: '/site-logos/xiaohongshu.svg',
    domains: ['xiaohongshu.com', 'xhslink.com'],
  },
  {
    id: 'youtube',
    label: 'YouTube',
    logo: '/site-logos/youtube.svg',
    domains: ['youtube.com', 'youtu.be'],
  },
  {
    id: 'bilibili',
    label: 'B站',
    logo: '/site-logos/bilibili.svg',
    domains: ['bilibili.com', 'b23.tv'],
  },
]

function parseLink(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return null

  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url
  } catch {
    return null
  }
}

function domainMatches(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

export function detectVideoSources(source: string): DetectedVideoSource[] {
  const counts = new Map<VideoSourceId, { count: number; firstIndex: number }>()
  const seenLinks = new Set<string>()

  source.split(/\r?\n/).forEach((line, index) => {
    const url = parseLink(line)
    if (!url) return

    const normalizedLink = url.toString()
    if (seenLinks.has(normalizedLink)) return
    seenLinks.add(normalizedLink)

    const hostname = url.hostname.toLowerCase()
    const definition = VIDEO_SOURCES.find((item) =>
      item.domains.some((domain) => domainMatches(hostname, domain)),
    )
    if (!definition) return

    const current = counts.get(definition.id)
    counts.set(definition.id, current
      ? { ...current, count: current.count + 1 }
      : { count: 1, firstIndex: index })
  })

  return VIDEO_SOURCES
    .flatMap((definition) => {
      const detected = counts.get(definition.id)
      return detected ? [{ ...definition, ...detected }] : []
    })
    .sort((left, right) => right.count - left.count || left.firstIndex - right.firstIndex)
    .map(({ id, label, logo, count }) => ({ id, label, logo, count }))
}

function coverOffset(rank: number) {
  if (rank === 0) return 0
  const distance = Math.ceil(rank / 2)
  return rank % 2 === 1 ? -distance : distance
}

export function VideoSourceCoverFlow({ source }: { source: string }) {
  const sources = detectVideoSources(source)
  if (sources.length === 0) return null

  const summary = sources.map((item) => `${item.label} ${item.count} 条`).join('，')

  return (
    <div
      className={`video-source-coverflow${sources.length === 1 ? ' is-single' : ''}`}
      data-testid="video-source-coverflow"
      role="list"
      aria-label={`已识别视频来源：${summary}`}
    >
      <div className="video-source-coverflow-track">
        {sources.map((item, rank) => {
          const offset = coverOffset(rank)
          const distance = Math.abs(offset)
          const active = rank === 0

          return (
            <motion.div
              key={item.id}
              className={`video-source-coverflow-card${active ? ' is-primary' : ''}`}
              data-testid={`video-source-card-${item.id}`}
              data-source-id={item.id}
              data-count={item.count}
              data-rank={rank}
              role="listitem"
              aria-label={`${item.label}，${item.count} 条链接`}
              title={`${item.label} · ${item.count} 条链接`}
              initial={false}
              animate={{
                x: offset * 18,
                rotateY: active ? 0 : offset < 0 ? 38 : -38,
                z: active ? 30 : -distance * 35,
                scale: active ? 1.08 : 1 - distance * 0.08,
                opacity: distance > 2 ? 0 : 1 - distance * 0.25,
              }}
              transition={{ type: 'spring', stiffness: 200, damping: 25 }}
              style={{ zIndex: 100 - distance }}
            >
              <img src={item.logo} alt="" draggable={false} />
              <span className="video-source-coverflow-count" aria-hidden="true">{item.count}</span>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}

export default VideoSourceCoverFlow
