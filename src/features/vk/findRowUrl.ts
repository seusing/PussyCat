// 采集结果行的 URL 嗅探:目录列名不统一(url/item_url/link/play_url/…),
// 无 schema——按优先级键列表找,再兜底扫描任意 string 值。
const PRIORITY_KEYS = [
  'url',
  'item_url',
  'link',
  'open_link',
  'original_url',
  'media_url',
  'play_url',
  'threadUrl',
  'profileUrl',
  'Url',
  'm3u8_url',
]

function normalized(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^https?:\/\//.test(trimmed) ? trimmed : null
}

export function findRowUrl(row: Record<string, unknown>): { url: string; column: string } | null {
  for (const key of PRIORITY_KEYS) {
    const url = normalized(row[key])
    if (url) return { url, column: key }
  }
  for (const [key, value] of Object.entries(row)) {
    const url = normalized(value)
    if (url) return { url, column: key }
  }
  return null
}
