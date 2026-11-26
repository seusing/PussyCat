// 从点点的回答里找出值得画成小图的数字,生成「数据洞察」卡片的数据。
// 只认确定能比较的几种写法,认不准就不出卡片:
// - 表格:有一列(或几列)是数字 → 条形对比;第一列是时间 → 折线;
// - 变化:「从 1.8% 上调至 2%」这样的说法出现两处以上 → 前后对比;
// - 占比:同一句或同一个列表里的几个百分比加起来约等于 100% → 分段条;
// - 列表:同一个列表里三条以上带同一类单位的数字(人均 80 元、高铁约 1 小时)→ 条形对比。

export type InsightPoint = { label: string; value: number; display: string }
/** family:单位类别(minutes、cny、score、count:个……),决定说「最长」还是「最高」 */
export type InsightMetric = { name: string; family: string; points: InsightPoint[] }
export type InsightChange = { label: string; from: number; to: number; fromText: string; toText: string; percent: boolean }
export type InsightSegment = { label: string; pct: number }

export type DotInsight =
  | { kind: 'series'; layout: 'bars' | 'line'; subject: string; metrics: InsightMetric[] }
  | { kind: 'change'; changes: InsightChange[] }
  | { kind: 'share'; segments: InsightSegment[] }

const MAX_INSIGHTS = 4
const MAX_POINTS = 12
const LABEL_MAX = 20

// —— 数字和单位 ——

type Unit = { family: string; factor: number }

// 长的写在前面,先匹配「万元」再匹配「万」、先「分钟」再「分」
const UNITS: Array<[string, Unit]> = [
  ['个百分点', { family: 'pp', factor: 1 }],
  ['%', { family: 'percent', factor: 1 }],
  ['％', { family: 'percent', factor: 1 }],
  ['亿元', { family: 'cny', factor: 1e8 }],
  ['万元', { family: 'cny', factor: 1e4 }],
  ['美元', { family: 'usd', factor: 1 }],
  ['港元', { family: 'hkd', factor: 1 }],
  ['元', { family: 'cny', factor: 1 }],
  ['块钱', { family: 'cny', factor: 1 }],
  ['块', { family: 'cny', factor: 1 }],
  ['个小时', { family: 'minutes', factor: 60 }],
  ['小时', { family: 'minutes', factor: 60 }],
  ['分钟', { family: 'minutes', factor: 1 }],
  ['天', { family: 'minutes', factor: 1440 }],
  ['公里', { family: 'meters', factor: 1000 }],
  ['km', { family: 'meters', factor: 1000 }],
  ['米', { family: 'meters', factor: 1 }],
  ['公斤', { family: 'grams', factor: 1000 }],
  ['kg', { family: 'grams', factor: 1000 }],
  ['斤', { family: 'grams', factor: 500 }],
  ['克', { family: 'grams', factor: 1 }],
  ['℃', { family: 'celsius', factor: 1 }],
  ['分', { family: 'score', factor: 1 }],
  ['星', { family: 'score', factor: 1 }],
  ['亿', { family: 'number', factor: 1e8 }],
  ['万', { family: 'number', factor: 1e4 }],
  ['w', { family: 'number', factor: 1e4 }],
  ['W', { family: 'number', factor: 1e4 }],
  ['k', { family: 'number', factor: 1e3 }],
  ['K', { family: 'number', factor: 1e3 }],
  ...['个', '次', '条', '篇', '人', '家', '件', '款', '张', '份', '杯', '碗', '套', '台', '只', '本', '部', '集', '首'].map(
    (unit): [string, Unit] => [unit, { family: `count:${unit}`, factor: 1 }],
  ),
]

const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`
const UNIT_PATTERN = UNITS.map(([unit]) => unit).join('|')
const CURRENCY_PREFIX = String.raw`[¥￥$]`
// 一个带单位的数:可带货币符号、可以是区间(100-150 元)
// 负号只认紧贴在数前、前面不是字母数字的(-1.4%);「广州-肇庆」「100-150」里的横线不算
const QUANTITY = new RegExp(
  String.raw`(?:(?<![\dA-Za-z.])([-−－]))?(${CURRENCY_PREFIX})?\s*(${NUMBER})(?:\s*(?:-|~|～|–|—|到|至)\s*(${NUMBER}))?\s*(${UNIT_PATTERN})?`,
  'gu',
)

/** value 已按单位换算(小时→分钟、万→×10000);unit 是原文里的单位,没有为空 */
export type Quantity = { value: number; family: string; factor: number; unit: string; text: string; index: number }

const toNumber = (text: string) => Number(text.replace(/,/g, ''))

/** 找出一段文字里的数;没有单位的归到 number 一类(列表里不用,表格里按列认)。 */
export function findQuantities(text: string): Quantity[] {
  const found: Quantity[] = []
  for (const match of text.matchAll(QUANTITY)) {
    const [whole, sign, currency, low, high, unitText] = match
    const index = match.index ?? 0
    // 紧跟在字母或数字后面的不算(型号 iPhone16、A17 芯片)
    const before = text[index - 1] ?? ''
    if (/[A-Za-z0-9.]/.test(before)) continue
    // 「分」后面跟「钟」「之」的不是分数
    if (unitText === '分' && /^[钟之]/.test(text.slice(index + whole.length))) continue
    const unit = unitText ? UNITS.find(([name]) => name === unitText)?.[1] : undefined
    const family = currency ? (currency === '$' ? 'usd' : 'cny') : unit?.family ?? 'number'
    // 货币符号 + 万(¥3万)按万算;货币符号 + 其他单位不再换算
    const factor = unit && (!currency || unit.family === 'number') ? unit.factor : 1
    const value = (high ? (toNumber(low) + toNumber(high)) / 2 : toNumber(low)) * factor * (sign ? -1 : 1)
    if (!Number.isFinite(value)) continue
    found.push({ value, family, factor, unit: unitText ?? '', text: whole.trim(), index })
  }
  return found
}

// —— 文本整理 ——

/** 去掉粗体、斜体、代码、链接等记号和零宽字符,只留文字。 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\p{Cf}/gu, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

const cleanLabel = (text: string) => plainText(text).replace(/^[\s:：,，、;；\-–—]+|[\s:：,，、;；\-–—]+$/g, '')

// —— 表格 ——

type Table = { header: string[]; rows: string[][] }

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim())
}

const DELIMITER_ROW = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function findTables(markdown: string): Table[] {
  const lines = markdown.split('\n')
  const tables: Table[] = []
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (!lines[index].includes('|') || !DELIMITER_ROW.test(lines[index + 1].trim())) continue
    const header = splitRow(lines[index]).map(plainText)
    const rows: string[][] = []
    let cursor = index + 2
    while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim()) {
      rows.push(splitRow(lines[cursor]).map(plainText))
      cursor += 1
    }
    if (header.length >= 2 && rows.length >= 2) tables.push({ header, rows })
    index = cursor - 1
  }
  return tables
}

// 日期里的点不当分隔符:1.2 万、4.8% 是小数
const TIME_LABEL = /^(\d{4}\s*(年|[-/])|\d{1,2}\s*月|Q[1-4]|第?\s*[一二三四1-4]\s*季度|第?\s*\d+\s*周|\d{1,2}[/-]\d{1,2}(?=$|\s|日|号)|(周|星期)[一二三四五六日天]|\d{1,2}\s*日)/

function tableInsight(table: Table): DotInsight | null {
  const width = table.header.length
  const rows = table.rows.slice(0, MAX_POINTS).filter((row) => row.length >= 2)
  // 标签列:第一列里大多不是数字的那一列(一般就是第一列)
  const labelColumn = table.header.findIndex((_, column) => rows.filter((row) => findQuantities(row[column] ?? '').length === 0
    || TIME_LABEL.test(row[column] ?? '')).length >= rows.length * 0.6)
  if (labelColumn < 0) return null
  const metrics: InsightMetric[] = []
  for (let column = 0; column < width; column += 1) {
    if (column === labelColumn) continue
    const points: InsightPoint[] = []
    const families = new Set<string>()
    for (const row of rows) {
      const cell = row[column] ?? ''
      const label = cleanLabel(row[labelColumn] ?? '').slice(0, LABEL_MAX)
      if (TIME_LABEL.test(cell)) continue
      const [quantity] = findQuantities(cell)
      // 一格里只有这个数(加单位、约、+、上下浮动这类小字)才算;一句话里夹着的数不算
      if (!quantity || !label || plainText(cell).length > quantity.text.length + 6) continue
      families.add(quantity.family)
      points.push({ label, value: quantity.value, display: quantity.text })
    }
    if (points.length >= 2 && points.length >= rows.length * 0.6 && families.size === 1) {
      metrics.push({ name: cleanLabel(table.header[column]) || '数值', family: [...families][0], points })
    }
  }
  if (metrics.length === 0) return null
  const timeSeries = rows.length >= 3 && rows.every((row) => TIME_LABEL.test(row[labelColumn] ?? ''))
  return { kind: 'series', layout: timeSeries ? 'line' : 'bars', subject: cleanLabel(table.header[labelColumn]), metrics }
}

// —— 列表 ——

type ListItem = { label: string; body: string }

function findLists(markdown: string): ListItem[][] {
  const lists: ListItem[][] = []
  let current: ListItem[] = []
  const close = () => {
    if (current.length > 0) lists.push(current)
    current = []
  }
  for (const line of markdown.split('\n')) {
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      const text = item[1]
      const bold = /^\p{Cf}*\*\*\p{Cf}*(.+?)\p{Cf}*\*\*\p{Cf}*[:：]?\s*(.*)$/u.exec(text)
      const colon = /^([^:：。，,]{1,20})[:：]\s*(.+)$/.exec(plainText(text))
      if (bold) current.push({ label: cleanLabel(bold[1]), body: plainText(bold[2]) })
      else if (colon) current.push({ label: cleanLabel(colon[1]), body: colon[2] })
      else current.push({ label: '', body: plainText(text) })
    } else if (/^\s+\S/.test(line) && current.length > 0) {
      current[current.length - 1].body += ` ${plainText(line)}`
    } else if (line.trim()) {
      close()
    }
  }
  close()
  return lists
}

function listInsight(items: ListItem[]): DotInsight | null {
  const byFamily = new Map<string, InsightPoint[]>()
  for (const item of items) {
    // 讲变化的条目(从 A 到 B)归变化卡,不拿它的第一个数来比
    if (!item.label || item.label.length > LABEL_MAX || new RegExp(CHANGE.source, 'u').test(item.body)) continue
    const quantity = findQuantities(item.body).find((entry) => entry.family !== 'number' && entry.family !== 'pp')
    if (!quantity) continue
    const points = byFamily.get(quantity.family) ?? []
    points.push({ label: item.label, value: quantity.value, display: quantity.text })
    byFamily.set(quantity.family, points)
  }
  const best = [...byFamily.entries()].sort((a, b) => b[1].length - a[1].length)[0]
  if (!best || best[1].length < 3) return null
  // 加起来约 100% 的是占比,归占比卡
  const total = best[1].reduce((sum, point) => sum + point.value, 0)
  if (best[0] === 'percent' && total >= 95 && total <= 105) return null
  return { kind: 'series', layout: 'bars', subject: '', metrics: [{ name: '', family: best[0], points: best[1].slice(0, MAX_POINTS) }] }
}

// —— 占比 ——

const PERCENT = /(\d+(?:\.\d+)?)\s*[%％]/gu

// 百分比前面那一小段就是它的名字:从上一个分隔处算起,去掉「占」「约」这类连接词,「面料是棉」只取「棉」
function shareLabel(before: string): string {
  const segment = before.split(/[、，,；;：:（(]|以及|和|与|及/).pop() ?? ''
  return (segment.replace(/(占比|占|约|为|是|达|有)+\s*$/u, '').split(/是|为/).pop() ?? '')
    .replace(/^(其中|还有|而|另外)+/u, '')
    .trim()
}

function shareOf(pairs: InsightSegment[]): DotInsight | null {
  if (pairs.length < 2) return null
  const total = pairs.reduce((sum, item) => sum + item.pct, 0)
  if (total < 95 || total > 105) return null
  if (new Set(pairs.map((item) => item.label)).size !== pairs.length) return null
  return { kind: 'share', segments: pairs }
}

function shareInsights(markdown: string, lists: ListItem[][]): DotInsight[] {
  const found: DotInsight[] = []
  for (const sentence of plainText(markdown.replace(/\n/g, '。')).split(/[。；;!！?？]/)) {
    const pairs: InsightSegment[] = []
    let previousEnd = 0
    for (const match of sentence.matchAll(PERCENT)) {
      const index = match.index ?? 0
      const label = shareLabel(sentence.slice(previousEnd, index))
      previousEnd = index + match[0].length
      if (label && label.length <= 10 && !/\d/.test(label)) pairs.push({ label, pct: Number(match[1]) })
    }
    const insight = shareOf(pairs)
    if (insight) found.push(insight)
  }
  for (const items of lists) {
    const pairs = items.flatMap((item) => {
      const percents = findQuantities(item.body).filter((entry) => entry.family === 'percent')
      return item.label && percents.length === 1 ? [{ label: item.label, pct: percents[0].value }] : []
    })
    if (pairs.length === items.length) {
      const insight = shareOf(pairs)
      if (insight) found.push(insight)
    }
  }
  return found
}

// —— 变化 ——

const CHANGE = new RegExp(
  String.raw`从\s*(?:约|近)?\s*((?:${CURRENCY_PREFIX})?\s*(?:${NUMBER})\s*(?:${UNIT_PATTERN})?)\s*[^，。；,;\n]{0,6}?(?:到|至|为|成)\s*(?:约|近)?\s*((?:${CURRENCY_PREFIX})?\s*(?:${NUMBER})\s*(?:${UNIT_PATTERN})?)`,
  'gu',
)
const SUBJECT_NOISE = /^(将|把|让|使|由|并|且|也|都|已|被|其|则)+/u

function changeInsight(markdown: string, lists: ListItem[][]): DotInsight | null {
  const labelsByBody = new Map(lists.flat().map((item) => [item.body, item.label]))
  const changes: InsightChange[] = []
  const blocks = [...labelsByBody.keys(), ...plainText(markdown.replace(/^(?:[-*+]|\d+[.)])\s+.*$/gm, '').replace(/\n/g, '。')).split('。')]
  for (const block of blocks) {
    for (const match of block.matchAll(CHANGE)) {
      const [from] = findQuantities(match[1])
      const [to] = findQuantities(match[2])
      if (!from || !to) continue
      const family = to.family !== 'number' ? to.family : from.family
      if (family === 'number' || (from.family !== 'number' && to.family !== 'number' && from.family !== to.family)) continue
      const clause = block.slice(0, match.index).split(/[，。；：:,;、]/).pop() ?? ''
      const subject = cleanLabel(clause).replace(SUBJECT_NOISE, '').slice(-12).trim() || labelsByBody.get(block) || ''
      if (!subject) continue
      // 「从 299 降到 199 元」:前一个数借后一个的单位
      const borrowsUnit = !from.unit && !!to.unit
      changes.push({
        label: subject,
        from: borrowsUnit ? from.value * to.factor : from.value,
        to: to.value,
        // 借来的单位照后一个数的写法空格(199 元 → 299 元)
        fromText: borrowsUnit ? `${from.text}${to.text.endsWith(` ${to.unit}`) ? ' ' : ''}${to.unit}` : from.text,
        toText: to.text,
        percent: family === 'percent',
      })
    }
  }
  return changes.length >= 2 ? { kind: 'change', changes: changes.slice(0, MAX_POINTS) } : null
}

/** 一条回答里的数据洞察(最多 4 张);没有值得画的就是空数组。 */
export function extractDotInsights(markdown: string): DotInsight[] {
  if (!/\d/.test(markdown)) return []
  const insights: DotInsight[] = []
  for (const table of findTables(markdown)) {
    const insight = tableInsight(table)
    if (insight) insights.push(insight)
  }
  // 表格以外的部分
  const prose = markdown.split('\n').filter((line) => !line.trim().startsWith('|')).join('\n')
  const lists = findLists(prose)
  const change = changeInsight(prose, lists)
  if (change) insights.push(change)
  insights.push(...shareInsights(prose, lists))
  for (const items of lists) {
    const insight = listInsight(items)
    if (insight) insights.push(insight)
  }
  return insights.slice(0, MAX_INSIGHTS)
}
