import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanPastedSources, extractSources } from './sourceInput'

// 与爪爪的小红书命令、视频引擎共用的真实链接样本。
const { samples } = JSON.parse(
  readFileSync(resolve(process.cwd(), 'opencli-overrides/xiaohongshu/xhs-link-samples.json'), 'utf8'),
) as { samples: Array<{ input: string; link: string | null; kind: string }> }
const linksOfKind = (...kinds: string[]) => samples.filter((sample) => kinds.includes(sample.kind)).map((sample) => sample.link as string)

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
      profiles: 0,
    })
  })

  it('cleans a single line whose link is surrounded by other words', () => {
    expect(cleanPastedSources('【标题】 https://b23.tv/AbC 复制打开')).toEqual({ sources: ['https://b23.tv/AbC'], dropped: 0, profiles: 0 })
    expect(cleanPastedSources('https://b23.tv/AbC】')).toEqual({ sources: ['https://b23.tv/AbC'], dropped: 0, profiles: 0 })
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

describe('cleanPastedSources 去掉小红书作者主页链接', () => {
  const NOTE = 'https://www.xiaohongshu.com/explore/6a6a1379000000001f01c03c?xsec_token=SAMPLE&xsec_source=pc_search'
  const PROFILE = 'https://www.xiaohongshu.com/user/profile/63b98bad0000000026010302?xsec_token=SAMPLE&xsec_source=pc_note'

  it('drops the sample links of kind profile, counts them, and keeps every kind that is not an author page', () => {
    const profiles = linksOfKind('profile')
    expect(profiles).toHaveLength(2)
    for (const profile of profiles) {
      expect(cleanPastedSources(`${NOTE}\n${profile}`)).toEqual({ sources: [NOTE], dropped: 0, profiles: 1 })
    }
    // 短链要展开后才知道是笔记还是主页,前端不判断。
    const kept = linksOfKind('note', 'note-unsigned', 'short-note', 'short-profile', 'short-invalid')
    expect(kept.length).toBeGreaterThan(10)
    for (const link of kept) {
      expect(cleanPastedSources(`${PROFILE}\n${link}`), link).toEqual({ sources: [link], dropped: 0, profiles: 1 })
      expect(cleanPastedSources(link), link).toBeNull()
    }
  })

  it('turns a search-result paste of notes alternating with author pages into the notes only', () => {
    const notes = Array.from({ length: 13 }, (_, index) => `https://www.xiaohongshu.com/explore/6a6a${String(index).padStart(20, '0')}?xsec_token=SAMPLE&xsec_source=pc_search`)
    const authors = notes.map((_, index) => `https://www.xiaohongshu.com/user/profile/63b9${String(index).padStart(20, '0')}?channel_type=web_search_result_notes&parent_page_channel_type=web_profile_board&xsec_token=SAMPLE`)
    const text = notes.flatMap((note, index) => [note, authors[index]]).join('\n')

    expect(cleanPastedSources(text)).toEqual({ sources: notes, dropped: 0, profiles: 13 })
  })

  it('counts the same author page once, like any other duplicate link', () => {
    expect(cleanPastedSources(`${NOTE}\n${PROFILE}\n${PROFILE}`)).toEqual({ sources: [NOTE], dropped: 0, profiles: 1 })
  })

  it('is no longer "already clean" as soon as an author page is removed, even for one link per line', () => {
    expect(cleanPastedSources(`${NOTE}\n${PROFILE}`)).not.toBeNull()
    expect(cleanPastedSources(`${PROFILE}\n${NOTE}`)).toEqual({ sources: [NOTE], dropped: 0, profiles: 1 })
  })

  it('reports dropped lines and author pages together', () => {
    expect(cleanPastedSources(`发布者\n${NOTE}\n${PROFILE}\n备注`)).toEqual({ sources: [NOTE], dropped: 2, profiles: 1 })
  })

  it('leaves a paste that holds nothing but author pages to the browser, so the engine can explain', () => {
    expect(cleanPastedSources(PROFILE)).toBeNull()
    expect(cleanPastedSources(`${PROFILE}\nhttps://www.xiaohongshu.com/user/profile/63b98bad0000000026010302`)).toBeNull()
  })

  it.each([
    ['bare host', 'https://xiaohongshu.com/user/profile/63b98bad0000000026010302'],
    ['www', 'https://www.xiaohongshu.com/user/profile/63b98bad0000000026010302'],
    ['other subdomain', 'http://pgy.xiaohongshu.com/user/profile/63b98bad0000000026010302?x=1'],
    ['trailing slash', 'https://www.xiaohongshu.com/user/profile/63b98bad0000000026010302/'],
    ['trailing slash with query', 'https://www.xiaohongshu.com/user/profile/63b98bad0000000026010302/?xsec_token=SAMPLE'],
    ['upper-case host', 'https://WWW.XiaoHongShu.com/user/profile/63b98bad0000000026010302'],
  ])('treats %s as an author page', (_name, profile) => {
    expect(cleanPastedSources(`${NOTE}\n${profile}`)).toEqual({ sources: [NOTE], dropped: 0, profiles: 1 })
  })

  it.each([
    ['a note under the author', 'https://www.xiaohongshu.com/user/profile/63b98bad0000000026010302/6a6a1379000000001f01c03c?xsec_token=SAMPLE'],
    ['no author id', 'https://www.xiaohongshu.com/user/profile/'],
    ['another path', 'https://www.xiaohongshu.com/user/profile'],
    ['a look-alike host', 'https://evilxiaohongshu.com/user/profile/63b98bad0000000026010302'],
    ['a host that only starts with it', 'https://xiaohongshu.com.evil.com/user/profile/63b98bad0000000026010302'],
    ['another site', 'https://example.com/user/profile/63b98bad0000000026010302'],
    ['the short-link host', 'https://xhslink.cn/m/AtxBJ5E7pvr'],
  ])('keeps %s', (_name, link) => {
    expect(cleanPastedSources(`${NOTE}\n${link}`)).toBeNull()
  })

  it('does not touch what is submitted: extractSources keeps an author page typed by hand', () => {
    expect(extractSources(`${PROFILE}\n${NOTE}`)).toEqual({ sources: [PROFILE, NOTE], dropped: 0 })
    expect(extractSources(PROFILE)).toEqual({ sources: [PROFILE], dropped: 0 })
  })
})
