import { renderCellValue } from './renderCellValue'
import { findRowUrl } from '../vk/findRowUrl'

export function ResultsTable({ columns, rows, onSendToVk }: {
  columns: string[]
  rows: Record<string, unknown>[]
  /** 存在时,含 URL 的行尾追加「送去视频解析」。只传规范化 URL,不携带行数据。 */
  onSendToVk?: (url: string) => void
}) {
  return (
    <table data-testid="results-table" className="w-full text-left text-xs">
      <thead><tr>
        {columns.map((c) => <th key={c} className="border-b px-2 py-1" style={{ borderColor: 'var(--color-line)', color: 'var(--color-fg-dim)' }}>{c}</th>)}
        {onSendToVk && <th className="border-b px-2 py-1" style={{ borderColor: 'var(--color-line)', color: 'var(--color-fg-dim)' }}>操作</th>}
      </tr></thead>
      <tbody>
        {rows.map((row, i) => {
          const found = onSendToVk ? findRowUrl(row) : null
          return (
            <tr key={i}>
              {columns.map((c) => <td key={c} className="px-2 py-1">{renderCellValue(row[c])}</td>)}
              {onSendToVk && (
                <td className="px-2 py-1">
                  {found && (
                    <button
                      type="button"
                      data-testid={`send-to-vk-${i}`}
                      onClick={() => onSendToVk(found.url)}
                      className="shrink-0 rounded px-2 py-1 text-xs"
                      style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
                    >
                      送去视频解析
                    </button>
                  )}
                </td>
              )}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
