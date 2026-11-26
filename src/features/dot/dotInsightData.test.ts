import { describe, expect, it } from 'vitest'
import { extractDotInsights, findQuantities, plainText } from './dotInsightData'

// 2026-11-24 点点对一条财经视频笔记的真实回答(节选)
const GOLD = `这条视频笔记主要分析了**黄金连续两天暴跌的原因**，并对后续趋势进行了展望。

#### 美联储议息会议的三大超预期点
- **上调经济预期**：将长期潜在增速从 1.8% 上调至 2%，显示美联储对经济韧性偏乐观。
- **上调通胀预期**：核心 PCE 预期从 2.5% 大幅上调至 2.7%，能源冲击预期贯穿全年。
- **鹰派态度统一**：点阵图显示对维持利率不变的反对者仅有一位，且加息可能重回讨论，压制了宽松预期。`

describe('findQuantities', () => {
  it('认单位并换算,区间取中间,型号里的数字不算', () => {
    expect(findQuantities('高铁约1.5小时').map((item) => [item.value, item.family, item.text])).toEqual([[90, 'minutes', '1.5小时']])
    expect(findQuantities('人均 100-150 元')[0]).toMatchObject({ value: 125, family: 'cny', text: '100-150 元' })
    expect(findQuantities('热度 1.2万')[0]).toMatchObject({ value: 12000, family: 'number' })
    expect(findQuantities('¥3,299')[0]).toMatchObject({ value: 3299, family: 'cny' })
    expect(findQuantities('评分 4.8分,步行 10 分钟')[1]).toMatchObject({ value: 10, family: 'minutes' })
    expect(findQuantities('iPhone16 的 A17 芯片')).toEqual([])
    expect(findQuantities('-1.4%')[0]).toMatchObject({ value: -1.4, family: 'percent', text: '-1.4%' })
    expect(findQuantities('广州-肇庆 2-3小时')[0]).toMatchObject({ value: 150, text: '2-3小时' })
  })

  it('plainText 去掉粗体记号、零宽字符和链接', () => {
    expect(plainText('​**​肇庆​**​：[配图 · 西岁](https://x)')).toBe('肇庆：配图 · 西岁')
  })
})

describe('extractDotInsights', () => {
  it('「从 A 调到 B」出现两处:前后对比卡,主语取「从」前面那段', () => {
    expect(extractDotInsights(GOLD)).toEqual([{
      kind: 'change',
      changes: [
        { label: '长期潜在增速', from: 1.8, to: 2, fromText: '1.8%', toText: '2%', percent: true },
        { label: '核心 PCE 预期', from: 2.5, to: 2.7, fromText: '2.5%', toText: '2.7%', percent: true },
      ],
    }])
  })

  it('表格里的数字列:条形对比,非数字列不画', () => {
    const answer = `| 推荐路线 | 城市景点 | 推荐理由 | 热度 |
| --- | --- | --- | --- |
| 广州-肇庆 | 七星岩、鼎湖山 | 山水 | 1.2万 |
| 广州-清远 | 古龙峡 | 漂流 | 8600 |
| 广州-顺德 | 清晖园 | 美食 | 2.3万 |`
    expect(extractDotInsights(answer)).toEqual([{
      kind: 'series', layout: 'bars', subject: '推荐路线',
      metrics: [{ name: '热度', family: 'number', points: [
        { label: '广州-肇庆', value: 12000, display: '1.2万' },
        { label: '广州-清远', value: 8600, display: '8600' },
        { label: '广州-顺德', value: 23000, display: '2.3万' },
      ] }],
    }])
  })

  it('第一列是时间的表格画折线;几列数字各算一个指标', () => {
    const answer = `| 月份 | 金价（元/克） | 涨幅 |
|:--|--:|--:|
| 1月 | 620 | 2% |
| 2月 | 650 | 4.8% |
| 3月 | 700 | 7.7% |
| 4月 | 690 | -1.4% |`
    const [insight] = extractDotInsights(answer)
    expect(insight).toMatchObject({ kind: 'series', layout: 'line', subject: '月份' })
    expect(insight.kind === 'series' && insight.metrics.map((metric) => [metric.name, metric.points.map((point) => point.value)]))
      .toEqual([['金价（元/克）', [620, 650, 700, 690]], ['涨幅', [2, 4.8, 7.7, -1.4]]])
  })

  it('列表里三条以上同类单位:按换算后的值比较,显示原文', () => {
    const answer = `周末从广州出发可以去这几个地方：
- ​**​肇庆​**​：高铁约1小时，适合看山水。
- ​**​清远​**​：自驾约1.5小时，漂流很爽。
- ​**​顺德​**​：地铁约40分钟，主打美食。`
    expect(extractDotInsights(answer)).toEqual([{
      kind: 'series', layout: 'bars', subject: '',
      metrics: [{ name: '', family: 'minutes', points: [
        { label: '肇庆', value: 60, display: '1小时' },
        { label: '清远', value: 90, display: '1.5小时' },
        { label: '顺德', value: 40, display: '40分钟' },
      ] }],
    }])
  })

  it('加起来约 100% 的几个百分比:占比卡(一句话里或一个列表里)', () => {
    expect(extractDotInsights('这件卫衣的面料是棉 60%、涤纶 35%、氨纶 5%，比较亲肤。')).toEqual([{
      kind: 'share', segments: [{ label: '棉', pct: 60 }, { label: '涤纶', pct: 35 }, { label: '氨纶', pct: 5 }],
    }])
    expect(extractDotInsights('其中女性用户占 70%，男性用户占 30%。')).toEqual([{
      kind: 'share', segments: [{ label: '女性用户', pct: 70 }, { label: '男性用户', pct: 30 }],
    }])
    expect(extractDotInsights('- **视频**：45%\n- **图文**：55%')).toEqual([{
      kind: 'share', segments: [{ label: '视频', pct: 45 }, { label: '图文', pct: 55 }],
    }])
  })

  it('加起来不到 100% 的百分比列表按条形比', () => {
    const [insight] = extractDotInsights('- A 店：同比增长 5%\n- B 店：同比增长 8%\n- C 店：同比增长 3%')
    expect(insight).toMatchObject({ kind: 'series', layout: 'bars' })
  })

  it('没有可比的数字就不出卡片', () => {
    expect(extractDotInsights('推荐这三条笔记：第1条讲画中画，第2条讲关键帧，第3条讲蒙版。')).toEqual([])
    expect(extractDotInsights('从 5 月到 8 月都适合去，旺季是 7 月。')).toEqual([])
    expect(extractDotInsights('价格从 299 降到 199 元。')).toEqual([])
    expect(extractDotInsights('- **肇庆**：高铁约1小时\n- **清远**：自驾约1.5小时')).toEqual([])
    expect(extractDotInsights('上涨 5%，利润率 30%。')).toEqual([])
    expect(extractDotInsights('没有数字的回答')).toEqual([])
  })
})
