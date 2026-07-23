export function ResultsTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  return (
    <table data-testid="results-table" className="w-full text-left text-xs">
      <thead><tr>{columns.map((c) => <th key={c} className="border-b px-2 py-1" style={{ borderColor: 'var(--color-line)', color: 'var(--color-fg-dim)' }}>{c}</th>)}</tr></thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>{columns.map((c) => <td key={c} className="px-2 py-1">{String(row[c] ?? '')}</td>)}</tr>
        ))}
      </tbody>
    </table>
  )
}
