import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import samples from '../../../opencli-overrides/xiaohongshu/xhs-link-samples.json'
import { detectVideoSources, VideoSourceCoverFlow } from './VideoSourceCoverFlow'
import { extractSources } from './sourceInput'

// 与 VkPanel 的预检同一条路径:先整理成来源列表,再按来源识别平台。
const detectedIds = (input: string) => detectVideoSources(extractSources(input).sources.join('\n')).map(({ id }) => id)

describe('VideoSourceCoverFlow', () => {
  it('recognizes supported video-link domains and uses the colored site logos', () => {
    render(<VideoSourceCoverFlow source={[
      'https://channels.weixin.qq.com/web/pages/feed?finderUserName=one',
      'https://x.com/account/status/1',
      'https://www.xiaohongshu.com/explore/one',
      'https://youtu.be/abc',
      'https://www.bilibili.com/video/BV1',
    ].join('\n')} />)

    expect(screen.getByTestId('video-source-card-wechat').querySelector('img')).toHaveAttribute('src', '/site-logos/wechat.svg')
    expect(screen.getByTestId('video-source-card-x').querySelector('img')).toHaveAttribute('src', '/site-logos/x.svg')
    expect(screen.getByTestId('video-source-card-xiaohongshu').querySelector('img')).toHaveAttribute('src', '/site-logos/xiaohongshu.svg')
    expect(screen.getByTestId('video-source-card-youtube').querySelector('img')).toHaveAttribute('src', '/site-logos/youtube.svg')
    expect(screen.getByTestId('video-source-card-bilibili').querySelector('img')).toHaveAttribute('src', '/site-logos/bilibili.svg')
  })

  it('sorts by unique-link count and keeps first appearance order for ties', () => {
    const detected = detectVideoSources([
      'https://x.com/account/status/1',
      'https://youtu.be/one',
      'https://b23.tv/one',
      'https://youtube.com/watch?v=two',
      'https://twitter.com/account/status/2',
      'https://www.youtube.com/shorts/three',
    ].join('\n'))

    expect(detected.map(({ id, count }) => [id, count])).toEqual([
      ['youtube', 3],
      ['x', 2],
      ['bilibili', 1],
    ])

    const tied = detectVideoSources('https://x.com/a/status/1\nhttps://youtu.be/one')
    expect(tied.map(({ id }) => id)).toEqual(['x', 'youtube'])
  })

  it('counts a duplicated normalized link only once', () => {
    render(<VideoSourceCoverFlow source={[
      'https://youtu.be/abc',
      'https://youtu.be/abc#chapter',
      'youtu.be/second',
    ].join('\n')} />)

    expect(screen.getByTestId('video-source-card-youtube')).toHaveAttribute('data-count', '2')
    expect(screen.getByTestId('video-source-coverflow')).toHaveAccessibleName('已识别视频来源：YouTube 2 条')
  })

  it('renders a single compact logo for one detected site', () => {
    render(<VideoSourceCoverFlow source="https://www.xiaohongshu.com/explore/one" />)

    expect(screen.getByTestId('video-source-coverflow')).toHaveClass('is-single')
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('renders nothing when no supported source is detected', () => {
    render(<VideoSourceCoverFlow source={'not a link\nhttps://example.com/video'} />)

    expect(screen.queryByTestId('video-source-coverflow')).not.toBeInTheDocument()
  })

  it('recognizes every Xiaohongshu sample link as Xiaohongshu, including App share texts', () => {
    for (const { input, link, kind } of samples.samples) {
      if (!link) continue
      expect(extractSources(input).sources, `${kind}: ${input}`).toContain(link)
      expect(detectedIds(input), `${kind}: ${input}`).toContain('xiaohongshu')
    }
  })

  it('does not take look-alike hosts, other schemes or plain text for Xiaohongshu', () => {
    const others = samples.samples.filter(({ kind }) => kind === 'other')
    expect(others.length).toBeGreaterThan(0)
    for (const { input } of others) expect(detectedIds(input), input).not.toContain('xiaohongshu')
    expect(detectedIds('https://www.bilibili.com/video/BV1xx411c7mD')).toEqual(['bilibili'])
  })
})
