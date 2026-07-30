import type { ReactNode } from 'react'

const URL_PATTERN = /^https?:\/\//

function renderString(value: string): ReactNode {
  if (URL_PATTERN.test(value)) {
    return (
      <a href={value} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)' }}>
        {value}
      </a>
    )
  }
  return value
}

/** 单元格渲染规则：null/undefined 空串；URL 字符串转链接；标量原样；数组逐元素递归+逗号分隔；其余对象紧凑 JSON。 */
export function renderCellValue(value: unknown): ReactNode {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return renderString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return ''
    return value.map((item, i) => (
      <span key={i}>
        {i > 0 ? ', ' : ''}
        {renderCellValue(item)}
      </span>
    ))
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
