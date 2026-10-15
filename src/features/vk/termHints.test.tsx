import { render } from '@testing-library/react'
import Markdown from 'react-markdown'
import { fetchVkJob, fetchVkOutputText, type VkJobView } from '../../host/vkClient'
import { loadVkTermHints, normalizeTerm, rehypeTermHints, termHintsFromArtifact, type VkTermHint } from './termHints'

vi.mock('../../host/vkClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../host/vkClient')>()),
  fetchVkJob: vi.fn(),
  fetchVkOutputText: vi.fn(),
}))

const hint = (term: string, over: Partial<VkTermHint> = {}): VkTermHint => ({
  term, explanation: `${term}的解释`, in_video: `${term}在视频里的含义`, ...over,
})

function marked(
  markdown: string,
  terms: VkTermHint[],
  { known = [], limit }: { known?: string[]; limit?: number } = {},
) {
  const { container } = render(
    <Markdown rehypePlugins={[[rehypeTermHints, { terms, known: new Set(known.map(normalizeTerm)), limit }]]}>{markdown}</Markdown>,
  )
  return [...container.querySelectorAll('.vk-term')].map((element) => [element.textContent, element.getAttribute('data-term-id')])
}

describe('rehypeTermHints', () => {
  it('标出术语并带上它在 terms 里的下标,每个术语只标第一次出现', () => {
    const result = marked('减载很重要。后面再说一次减载。\n\n渐进式超负荷是核心,渐进式超负荷要坚持。', [hint('渐进式超负荷'), hint('减载')])
    expect(result).toEqual([['减载', '1'], ['渐进式超负荷', '0']])
  })

  it('保留术语前后的原文', () => {
    const { container } = render(<Markdown rehypePlugins={[[rehypeTermHints, { terms: [hint('减载')], known: new Set() }]]}>{'每四周做一次减载,恢复状态。'}</Markdown>)
    expect(container.querySelector('p')).toHaveTextContent('每四周做一次减载,恢复状态。')
    expect(container.querySelector('p')?.childNodes).toHaveLength(3)
  })

  it('跳过代码块、行内代码、链接和标题里的文字,正文里的出现才算第一次', () => {
    const result = marked([
      '# 减载入门',
      '',
      '`减载` 是行内代码,[减载](https://example.com) 是链接。',
      '',
      '```',
      '减载 在代码块里',
      '```',
      '',
      '#### 小节减载',
      '',
      '真正的正文里讲减载。',
    ].join('\n'), [hint('减载')])
    expect(result).toEqual([['减载', '0']])
    const { container } = render(<Markdown rehypePlugins={[[rehypeTermHints, { terms: [hint('减载')], known: new Set() }]]}>{'# 减载\n\n[减载](https://a.b)'}</Markdown>)
    expect(container.querySelector('.vk-term')).toBeNull()
  })

  it('术语在加粗、列表这类行内结构里也能标', () => {
    expect(marked('- 先学 **减载** 再学别的', [hint('减载')])).toEqual([['减载', '0']])
  })

  it('最多标 limit 个(默认 5),按 terms 的优先级而不是出现顺序取', () => {
    const terms = ['甲术语', '乙术语', '丙术语', '丁术语', '戊术语', '己术语', '庚术语'].map((term) => hint(term))
    const note = [...terms].reverse().map((item) => item.term).join('、')
    expect(marked(note, terms).map(([, id]) => id).sort()).toEqual(['0', '1', '2', '3', '4'])
    expect(marked(note, terms, { limit: 2 }).map(([, id]) => id).sort()).toEqual(['0', '1'])
  })

  it('笔记里没出现的术语不占名额', () => {
    const terms = [hint('不存在一'), hint('不存在二'), hint('减载'), hint('RPE')]
    expect(marked('只讲减载和 RPE', terms, { limit: 2 })).toEqual([['减载', '2'], ['RPE', '3']])
  })

  it('已了解的术语不标,名额让给后面的', () => {
    const terms = [hint('减载'), hint('RPE'), hint('超负荷')]
    expect(marked('减载、rpe、超负荷都提到了', terms, { known: ['RPE', '减载'] })).toEqual([['超负荷', '2']])
    expect(marked('减载、rpe、超负荷都提到了', terms, { known: ['减载'], limit: 1 })).toEqual([['rpe', '1']])
  })

  it('最长匹配优先:渐进式超负荷里的超负荷不单独标', () => {
    const terms = [hint('超负荷'), hint('渐进式超负荷')]
    expect(marked('渐进式超负荷是原则。', terms)).toEqual([['渐进式超负荷', '1']])
    expect(marked('渐进式超负荷是原则。训练里的超负荷要循序。', terms)).toEqual([['渐进式超负荷', '1'], ['超负荷', '0']])
  })

  it('长短术语只在短的出现于别处时才占名额', () => {
    const terms = [hint('超负荷'), hint('渐进式超负荷'), hint('减载')]
    expect(marked('渐进式超负荷之外还要减载', terms, { limit: 2 })).toEqual([['渐进式超负荷', '1'], ['减载', '2']])
  })

  it('拉丁字母忽略大小写,标记保留笔记里的写法', () => {
    expect(marked('先看 rpe 再看 RPE。', [hint('RPE')])).toEqual([['rpe', '0']])
    expect(marked('Progressive Overload 就是逐步加量', [hint('progressive overload')])).toEqual([['Progressive Overload', '0']])
  })

  it('英文缩写不从别的单词里切出来,紧贴汉字则照常标', () => {
    expect(marked('Sharpen your skills', [hint('RPE')])).toEqual([])
    expect(marked('用RPE衡量强度', [hint('RPE')])).toEqual([['RPE', '0']])
    expect(marked('RPEs 和 RPE', [hint('RPE')])).toEqual([['RPE', '0']])
  })

  it('术语里的正则符号按字面匹配', () => {
    expect(marked('一组 8*8 (含热身) 做满', [hint('8*8'), hint('(含热身)')])).toEqual([['8*8', '0'], ['(含热身)', '1']])
  })

  it('空术语、重复术语和 terms 为空都不出错', () => {
    expect(marked('减载', [hint(' '), hint('减载'), hint('Ｒ'), hint('减载 ')])).toEqual([['减载', '1']])
    expect(marked('减载', [])).toEqual([])
    expect(marked('减载', [hint('减载')], { limit: 0 })).toEqual([])
  })
})

describe('termHintsFromArtifact', () => {
  const artifact = {
    schema_name: 'quick_summary_artifact',
    schema_version: '1.4.0',
    terms: [
      { term: '渐进式超负荷', explanation: '逐步增加训练负荷，让身体持续适应变强', in_video: '这里指八乘八做满后每次加 2.5 公斤', start_ms: 12000, end_ms: 18000, score: 0.83 },
      { term: '减载', explanation: '主动降低一周训练量来恢复', in_video: '每四周安排一次', start_ms: 40000, end_ms: 45000, score: null },
    ],
    term_selection: { method: 'jev', reason: null },
  }

  it('读出 1.4.0 产物里的术语,score 为 null 时不带 score', () => {
    expect(termHintsFromArtifact(artifact)).toEqual({
      terms: [
        { term: '渐进式超负荷', explanation: '逐步增加训练负荷，让身体持续适应变强', in_video: '这里指八乘八做满后每次加 2.5 公斤', score: 0.83 },
        { term: '减载', explanation: '主动降低一周训练量来恢复', in_video: '每四周安排一次' },
      ],
      note: null,
    })
  })

  it('旧版本产物没有 terms 字段,不标任何术语', () => {
    expect(termHintsFromArtifact({ schema_name: 'quick_summary_artifact', schema_version: '1.3.0', summary: '…' })).toEqual({ terms: [], note: null })
  })

  it.each([
    ['null', null],
    ['字符串', '术语'],
    ['数组', []],
    ['terms 不是数组', { terms: '减载' }],
    ['terms 是对象', { terms: { term: '减载' } }],
  ])('坏数据(%s)返回空', (_name, json) => {
    expect(termHintsFromArtifact(json)).toEqual({ terms: [], note: null })
  })

  it('丢弃形状不对的条目,保留其余', () => {
    const result = termHintsFromArtifact({
      terms: [null, 'x', { term: '' , explanation: '空术语' }, { term: '无解释' }, { term: 3, explanation: '数字术语' },
        { term: '减载', explanation: '降低训练量', in_video: 5, score: 'high' }],
    })
    expect(result.terms).toEqual([{ term: '减载', explanation: '降低训练量', in_video: '' }])
  })

  it('Jev 不可用退回模型自选时带上原因', () => {
    const fallback = { ...artifact, term_selection: { method: 'fallback', reason: 'HTTP 451：Typesafe is not available in your region.' } }
    expect(termHintsFromArtifact(fallback).note).toBe('未经 Jev 筛选：HTTP 451：Typesafe is not available in your region.')
    expect(termHintsFromArtifact(fallback).terms).toHaveLength(2)
  })

  it('fallback 没给原因时只说明未经 Jev 筛选', () => {
    expect(termHintsFromArtifact({ ...artifact, term_selection: { method: 'fallback', reason: null } }).note).toBe('未经 Jev 筛选')
    expect(termHintsFromArtifact({ ...artifact, term_selection: 'fallback' }).note).toBeNull()
  })
})

describe('loadVkTermHints', () => {
  const quick = { preset: 'quick', schema_name: 'quick_summary_artifact', sha256: 'x', json: 'quick.json', markdown: 'quick.md' }
  const other = { preset: 'other', schema_name: 'other_artifact', sha256: 'y', json: 'other.json', markdown: 'other.md' }
  const job = (artifacts: unknown[]) => ({ outputs: { product_artifacts: artifacts } }) as VkJobView

  beforeEach(() => {
    vi.mocked(fetchVkJob).mockReset()
    vi.mocked(fetchVkOutputText).mockReset()
  })

  it('找到快速摘要产物,用它的 json 输出 id 读取并解析', async () => {
    vi.mocked(fetchVkJob).mockResolvedValue(job([other, quick]))
    vi.mocked(fetchVkOutputText).mockResolvedValue(JSON.stringify({ terms: [{ term: '减载', explanation: '降低训练量', in_video: '每四周一次' }] }))
    await expect(loadVkTermHints('job-1', 'http://host')).resolves.toEqual({
      terms: [{ term: '减载', explanation: '降低训练量', in_video: '每四周一次' }],
      note: null,
    })
    expect(fetchVkJob).toHaveBeenCalledWith('job-1', 'http://host')
    expect(fetchVkOutputText).toHaveBeenCalledTimes(1)
    expect(fetchVkOutputText).toHaveBeenCalledWith('quick.json', 'http://host')
  })

  it('没有快速摘要产物是确定的「没有术语」,不再请求产物文件', async () => {
    vi.mocked(fetchVkJob).mockResolvedValueOnce(job([other])).mockResolvedValueOnce({ outputs: { note_path: 'a.md' } } as VkJobView)
    await expect(loadVkTermHints('job-1', 'http://host')).resolves.toEqual({ terms: [], note: null })
    await expect(loadVkTermHints('job-2', 'http://host')).resolves.toEqual({ terms: [], note: null })
    expect(fetchVkOutputText).not.toHaveBeenCalled()
  })

  it.each([
    ['任务详情请求失败', () => { vi.mocked(fetchVkJob).mockRejectedValue(new Error('down')) }],
    ['产物请求失败', () => {
      vi.mocked(fetchVkJob).mockResolvedValue(job([quick]))
      vi.mocked(fetchVkOutputText).mockRejectedValue(new Error('404'))
    }],
    ['产物不是合法 JSON', () => {
      vi.mocked(fetchVkJob).mockResolvedValue(job([quick]))
      vi.mocked(fetchVkOutputText).mockResolvedValue('{坏')
    }],
  ])('%s时返回 null', async (_name, arrange) => {
    arrange()
    await expect(loadVkTermHints('job-1', 'http://host')).resolves.toBeNull()
  })
})

describe('normalizeTerm', () => {
  it('与 knownTerms 共用同一种写法', () => {
    expect(normalizeTerm(' ＲＰＥ ')).toBe('rpe')
  })
})
