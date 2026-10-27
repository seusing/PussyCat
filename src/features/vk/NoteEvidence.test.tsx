import { render, screen, within } from '@testing-library/react'
import { TermHintMarkdown } from './TermHint'

const renderNote = (markdown: string) => render(
  <TermHintMarkdown terms={[]} note={null}>{markdown}</TermHintMarkdown>,
)
const card = () => screen.getByRole('note', { name: '来源核对' })

describe('来源核对卡片', () => {
  it('一致:绿色徽标,列出原报道的链接和「媒体 · 日期」,链接走外链', () => {
    renderNote('- 关键点\n  > 来源核对 · 一致：[贵州茅台Q1营收、净利双增](https://example.com/a) · 华尔街见闻 · 2026-04-24')
    const badge = within(card()).getByText('一致')
    expect(badge).toHaveClass('vk-source-badge', 'is-consistent')
    const link = within(card()).getByRole('link', { name: '贵州茅台Q1营收、净利双增' })
    expect(link).toHaveAttribute('href', 'https://example.com/a')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(within(card()).getByText('华尔街见闻 · 2026-04-24')).toBeInTheDocument()
    expect(document.querySelector('blockquote')).toBeNull()
  })

  it('有出入:橙色徽标,两条来源按「；」分开,各带各的媒体和日期', () => {
    renderNote('> 来源核对 · 有出入：[标题甲](https://example.com/a) · 媒体甲 · 2026-04-24；[标题乙](https://example.com/b) · 媒体乙 · 2026-04-23')
    expect(within(card()).getByText('有出入')).toHaveClass('is-conflict')
    const items = within(card()).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(within(items[0]).getByRole('link', { name: '标题甲' })).toHaveAttribute('href', 'https://example.com/a')
    expect(items[0]).toHaveTextContent('媒体甲 · 2026-04-24')
    expect(items[0]).not.toHaveTextContent('媒体乙')
    expect(within(items[1]).getByRole('link', { name: '标题乙' })).toHaveAttribute('href', 'https://example.com/b')
    expect(items[1]).toHaveTextContent('媒体乙 · 2026-04-23')
  })

  it('未找到出处:灰色徽标,没有来源列表', () => {
    renderNote('> 来源核对 · 未找到出处')
    expect(within(card()).getByText('未找到出处')).toHaveClass('is-missing')
    expect(within(card()).queryByRole('list')).not.toBeInTheDocument()
    expect(within(card()).queryByRole('link')).not.toBeInTheDocument()
  })

  it('核对行紧挨着配图和行情图引用时,关键点文本、图和卡片各归各位', () => {
    const { container } = renderNote([
      '- 关键点文本',
      '  ![画面](figures/abc123def456.jpg)',
      '  > 来源核对 · 一致：[标题](https://example.com/a) · 媒体 · 2026-04-24',
    ].join('\n'))
    const item = container.querySelector('li')!
    expect(item).toHaveTextContent('关键点文本')
    expect(within(item).getByRole('note', { name: '来源核对' })).toBeInTheDocument()
    expect(card().parentElement).toBe(item)
    expect(item.querySelector('blockquote')).toBeNull()
  })

  it('和原话引用在同一个引用块里时,引用保留,核对卡片在引用里面', () => {
    const { container } = renderNote([
      '- 关键点',
      '  > 原话：茅台一季度营收增长超过百分之十（00:12）',
      '  >',
      '  > 来源核对 · 有出入：[标题甲](https://example.com/a) · 媒体甲 · 2026-04-24',
    ].join('\n'))
    const quote = container.querySelector('blockquote')!
    expect(quote).toHaveTextContent('茅台一季度营收增长超过百分之十')
    expect(within(quote).getByRole('note', { name: '来源核对' })).toBeInTheDocument()
    expect(within(quote).getByText('有出入')).toHaveClass('is-conflict')
  })

  it('链接地址不是 http(s) 时只显示标题,不生成链接', () => {
    renderNote('> 来源核对 · 一致：[脚本](javascript:alert(1)) · 媒体 · 2026-04-24')
    expect(within(card()).queryByRole('link')).not.toBeInTheDocument()
    expect(within(card()).getByText('脚本')).toBeInTheDocument()
  })

  it('结论不在三种之内、或不是以「来源核对 ·」开头时,按普通引用输出', () => {
    const { container } = renderNote('> 来源核对 · 待定：[标题](https://example.com/a)\n\n> 核对一下来源核对 · 一致\n\n> 普通引用')
    expect(screen.queryByRole('note', { name: '来源核对' })).not.toBeInTheDocument()
    expect(container.querySelectorAll('blockquote')).toHaveLength(3)
    expect(container.querySelector('blockquote a')).toHaveAttribute('href', 'https://example.com/a')
  })
})

describe('博主观点标签', () => {
  it('单独成行的「博主观点」渲染成小标签,不再是引用块', () => {
    const { container } = renderNote('- 关键点文本\n  > 博主观点')
    const tag = screen.getByText('博主观点')
    expect(tag).toHaveClass('vk-opinion-tag')
    expect(container.querySelector('blockquote')).toBeNull()
  })

  it('和核对行写在同一个引用块里时,卡片和标签都在', () => {
    renderNote('> 来源核对 · 一致：[标题](https://example.com/a) · 媒体 · 2026-04-24\n> 博主观点')
    expect(within(card()).getByText('一致')).toHaveClass('is-consistent')
    expect(within(card()).getByText('媒体 · 2026-04-24')).toBeInTheDocument()
    expect(within(card()).queryByText('博主观点')).not.toBeInTheDocument()
    expect(screen.getByText('博主观点')).toHaveClass('vk-opinion-tag')
  })

  it('正文里提到「博主观点」的普通引用不受影响', () => {
    const { container } = renderNote('> 这只是博主观点之一')
    expect(container.querySelector('blockquote')).toHaveTextContent('这只是博主观点之一')
    expect(container.querySelector('.vk-opinion-tag')).toBeNull()
  })
})

describe('预测核验卡片', () => {
  const forecastCard = () => screen.getByRole('note', { name: '预测核验' })
  const BODY = '看涨（由原话推断），期限至 2027-01-28。至今 -2.6%（平常波动的 0.3 倍，不明显）；期间最高 +14.5%（2026-08-25），最低 -3.2%（2026-10-26）。'

  it.each([
    ['应验', 'is-hit'],
    ['未应验', 'is-miss'],
    ['尚未到期', 'is-pending'],
    ['不明显', 'is-neutral'],
    ['未给期限', 'is-neutral'],
    ['暂不核验', 'is-neutral'],
  ])('%s:卡片头部是「预测核验」加徽标(%s),正文逐字出现', (status, tone) => {
    const { container } = renderNote(`- 关键点\n  >\n  > 预测核验 · ${status}：${BODY}`)
    expect(within(forecastCard()).getByText(status)).toHaveClass('vk-source-badge', tone)
    expect(within(forecastCard()).getByText('预测核验')).toBeInTheDocument()
    expect(within(forecastCard()).getByText(BODY)).toBeInTheDocument()
    expect(container.querySelector('blockquote')).toBeNull()
  })

  it('速览笔记:关键点、图和卡片各归各位,没有多余的引用外壳', () => {
    const { container } = renderNote([
      '- 关键点文字',
      '  ![图注](charts/abcdef012345.json)',
      '  >',
      `  > 预测核验 · 尚未到期：${BODY}`,
    ].join('\n'))
    const item = container.querySelector('li')!
    expect(item).toHaveTextContent('关键点文字')
    expect(item.querySelector('img')).toHaveAttribute('alt', '图注')
    expect(within(item).getByRole('note', { name: '预测核验' })).toBeInTheDocument()
    expect(forecastCard().parentElement).toBe(item)
    expect(within(forecastCard()).getByText('尚未到期')).toHaveClass('is-pending')
    expect(item.querySelector('blockquote')).toBeNull()
  })

  it('证据笔记:原话引用保留,卡片在引用里面', () => {
    const { container } = renderNote([
      '- 关键点文字 `[01:23]` <!-- claim_id: c1 -->',
      '  > “原话”',
      '  ![图注](charts/abcdef012345.json)',
      '  >',
      `  > 预测核验 · 未应验：${BODY}`,
    ].join('\n'))
    const quote = container.querySelector('blockquote')!
    expect(quote).toHaveTextContent('“原话”')
    expect(quote.querySelector('img')).toHaveAttribute('alt', '图注')
    expect(within(quote).getByRole('note', { name: '预测核验' })).toBeInTheDocument()
    expect(within(quote).getByText('未应验')).toHaveClass('is-miss')
    expect(within(quote).getByText(BODY)).toBeInTheDocument()
  })

  it('和来源核对行在同一个引用块里时,两张卡片都在', () => {
    const { container } = renderNote([
      '> 来源核对 · 一致：[标题](https://example.com/a) · 媒体 · 2026-04-24',
      '>',
      `> 预测核验 · 应验：${BODY}`,
    ].join('\n'))
    expect(within(card()).getByText('一致')).toHaveClass('is-consistent')
    expect(within(forecastCard()).getByText('应验')).toHaveClass('is-hit')
    expect(container.querySelector('blockquote')).toBeNull()
  })

  it('状态不在六种之内、没有全角冒号、或「预测核验」不在段首时,按普通引用输出', () => {
    const { container } = renderNote([
      '> 预测核验 · 待定：看涨',
      '> 预测核验 · 应验:看涨',
      '> 预测核验 · 应验',
      '> 预测核验：应验：看涨',
      '> 这条提到预测核验 · 应验：看涨',
    ].join('\n\n'))
    expect(screen.queryByRole('note', { name: '预测核验' })).not.toBeInTheDocument()
    expect(container.querySelectorAll('blockquote')).toHaveLength(5)
    expect(container.querySelector('.vk-source-badge')).toBeNull()
  })
})
