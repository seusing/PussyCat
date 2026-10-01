import { cleanPastedSources, extractSources } from './sourceInput'

const WECHAT_PASTE = [
  'Ceoi Wingsam 🐂',
  '2026年10月01日 13:14',
  'http://xhslink.com/o/7jNHVIMi1N3',
  '',
  'Ceoi Wingsam 🐂',
  '2026年10月01日 13:14',
  'http://xhslink.com/o/6gtmNhcgSDT',
].join('\n')

describe('extractSources', () => {
  it('keeps only the links of a multi-selected WeChat paste and counts the dropped lines', () => {
    expect(extractSources(WECHAT_PASTE)).toEqual({
      sources: ['http://xhslink.com/o/7jNHVIMi1N3', 'http://xhslink.com/o/6gtmNhcgSDT'],
      dropped: 4,
    })
    expect(extractSources(WECHAT_PASTE.replace(/\n/g, '\r\n')).sources).toHaveLength(2)
  })

  it('takes the link out of a Xiaohongshu share sentence', () => {
    const share = '48 【标题 - 小红书】 😆 abc http://xhslink.com/o/xxx 复制本条信息，打开【小红书】App查看精彩内容！'
    expect(extractSources(share)).toEqual({ sources: ['http://xhslink.com/o/xxx'], dropped: 0 })
  })

  it('takes the link out of a Bilibili share line that closes with a full-width bracket', () => {
    expect(extractSources('【标题】https://b23.tv/AbC】').sources).toEqual(['https://b23.tv/AbC'])
    expect(extractSources('【标题】https://b23.tv/AbC】复制后打开').sources).toEqual(['https://b23.tv/AbC'])
  })

  it('splits a line with several links into one source each', () => {
    expect(extractSources('看这两个 https://youtu.be/a 和 https://www.bilibili.com/video/BV1 都行').sources)
      .toEqual(['https://youtu.be/a', 'https://www.bilibili.com/video/BV1'])
  })

  it.each([
    ['.', ','], [';', ':'], ['!', '?'], [')', ']'], ['}', '>'], ["'", '"'],
    ['，', '。'], ['；', '：'], ['！', '？'], ['、', '）'], ['】', '」'], ['』', '》'], ['〉', '…'],
  ])('strips trailing %s and %s', (first, second) => {
    expect(extractSources(`https://example.com/v?id=1${first}`).sources).toEqual(['https://example.com/v?id=1'])
    expect(extractSources(`https://example.com/v?id=1${first}${second}`).sources).toEqual(['https://example.com/v?id=1'])
  })

  it('strips a run of mixed trailing punctuation and keeps inner punctuation', () => {
    expect(extractSources('(https://example.com/a.b/c?x=1&y=2).，。').sources).toEqual(['https://example.com/a.b/c?x=1&y=2'])
    expect(extractSources('“https://example.com/v”').sources).toEqual(['https://example.com/v'])
  })

  it('keeps local paths and upload references as they are', () => {
    const lines = [
      'upload:abc123/lecture 1.mp4',
      'C:\\Users\\me\\Videos\\clip 1.mp4',
      'D:/videos/clip.mp4',
      '\\\\nas\\share\\clip.mp4',
      '/home/me/clip.mp4',
    ]
    expect(extractSources(lines.join('\n'))).toEqual({ sources: lines, dropped: 0 })
  })

  it('drops text lines without a link and removes duplicates in order of appearance', () => {
    const text = 'https://a.com/1\n备注\nhttps://b.com/2\nhttps://a.com/1\n\n  https://b.com/2  \nC:\\x.mp4\nC:\\x.mp4'
    expect(extractSources(text)).toEqual({ sources: ['https://a.com/1', 'https://b.com/2', 'C:\\x.mp4'], dropped: 1 })
  })

  it('returns nothing for empty or link-less text', () => {
    expect(extractSources('')).toEqual({ sources: [], dropped: 0 })
    expect(extractSources('\n  \n')).toEqual({ sources: [], dropped: 0 })
    expect(extractSources('只是几个字\nCeoi Wingsam')).toEqual({ sources: [], dropped: 2 })
  })
})

describe('cleanPastedSources', () => {
  it('returns the cleaned sources when the paste carries more than links', () => {
    expect(cleanPastedSources(WECHAT_PASTE)).toEqual({
      sources: ['http://xhslink.com/o/7jNHVIMi1N3', 'http://xhslink.com/o/6gtmNhcgSDT'],
      dropped: 4,
    })
  })

  it('cleans a single line whose link is surrounded by other words', () => {
    expect(cleanPastedSources('【标题】 https://b23.tv/AbC 复制打开')).toEqual({ sources: ['https://b23.tv/AbC'], dropped: 0 })
    expect(cleanPastedSources('https://b23.tv/AbC】')).toEqual({ sources: ['https://b23.tv/AbC'], dropped: 0 })
  })

  it('leaves text without a usable source or text that is already clean to the browser', () => {
    expect(cleanPastedSources('只是几个字')).toBeNull()
    expect(cleanPastedSources('')).toBeNull()
    expect(cleanPastedSources('https://a.com/1')).toBeNull()
    expect(cleanPastedSources('https://a.com/1\n\nhttps://a.com/2\r\n')).toBeNull()
    expect(cleanPastedSources('https://a.com/1\nhttps://a.com/1')).toBeNull()
    expect(cleanPastedSources('C:\\videos\\a.mp4\nupload:xyz')).toBeNull()
  })
})
