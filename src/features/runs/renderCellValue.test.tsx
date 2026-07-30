import { render, screen } from '@testing-library/react'
import { renderCellValue } from './renderCellValue'
import { ResultsTable } from './ResultsTable'

function renderCell(value: unknown) {
  return render(<div data-testid="cell">{renderCellValue(value)}</div>)
}

describe('renderCellValue - 标量', () => {
  test('字符串原样展示', () => {
    renderCell('hello')
    expect(screen.getByTestId('cell').textContent).toBe('hello')
  })

  test('数字原样展示', () => {
    renderCell(42)
    expect(screen.getByTestId('cell').textContent).toBe('42')
  })

  test('布尔值原样展示', () => {
    renderCell(true)
    expect(screen.getByTestId('cell').textContent).toBe('true')
  })

  test('null 渲染为空串', () => {
    renderCell(null)
    expect(screen.getByTestId('cell').textContent).toBe('')
  })

  test('undefined 渲染为空串', () => {
    renderCell(undefined)
    expect(screen.getByTestId('cell').textContent).toBe('')
  })

  test('NaN 如实展示（不吞成空串）', () => {
    renderCell(NaN)
    expect(screen.getByTestId('cell').textContent).toBe('NaN')
  })

  test('Infinity 如实展示', () => {
    renderCell(Infinity)
    expect(screen.getByTestId('cell').textContent).toBe('Infinity')
  })
})

describe('renderCellValue - URL 字符串', () => {
  test('http(s) 字符串渲染为可点击链接，href/target/rel 精确', () => {
    const url = 'https://pbs.twimg.com/media/a.jpg'
    renderCell(url)
    const link = screen.getByTestId('cell').querySelector('a')
    expect(link).not.toBeNull()
    expect(link!.textContent).toBe(url)
    expect(link).toHaveAttribute('href', url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })
})

describe('renderCellValue - twitter/timeline 真实形状夹具', () => {
  test('media_urls 字符串数组 → 每个 URL 各自渲染为独立链接', () => {
    const urls = ['https://pbs.twimg.com/media/a.jpg', 'https://pbs.twimg.com/media/b.jpg']
    renderCell(urls)
    const links = screen.getByTestId('cell').querySelectorAll('a')
    expect(links).toHaveLength(2)
    expect(links[0]).toHaveAttribute('href', urls[0])
    expect(links[1]).toHaveAttribute('href', urls[1])
  })

  test('media_posters 同 media_urls 形状 → 同样各自成链接', () => {
    const urls = ['https://pbs.twimg.com/poster/a.jpg', 'https://pbs.twimg.com/poster/b.jpg']
    renderCell(urls)
    const links = screen.getByTestId('cell').querySelectorAll('a')
    expect(links).toHaveLength(2)
    expect(links[0]!.textContent).toBe(urls[0])
    expect(links[1]!.textContent).toBe(urls[1])
  })

  test('quoted_tweet 嵌套对象 → 紧凑 JSON 文本，含 author 与 x，绝不是 [object Object]', () => {
    renderCell({ author: 'x', text: 'y' })
    const text = screen.getByTestId('cell').textContent
    expect(text).toBe('{"author":"x","text":"y"}')
    expect(text).toContain('author')
    expect(text).toContain('x')
    expect(text).not.toContain('[object Object]')
  })

  test('card 为 null → 空串', () => {
    renderCell(null)
    expect(screen.getByTestId('cell').textContent).toBe('')
  })

  test('空数组 → 空串', () => {
    renderCell([])
    expect(screen.getByTestId('cell').textContent).toBe('')
  })
})

describe('ResultsTable 集成', () => {
  test('整表渲染混合行（含 URL / 数组 / 嵌套对象 / null），不出现 [object Object]', () => {
    const columns = ['id', 'url', 'media_urls', 'quoted_tweet', 'card']
    const rows = [
      {
        id: '1',
        url: 'https://x.com/status/1',
        media_urls: ['https://pbs.twimg.com/media/a.jpg', 'https://pbs.twimg.com/media/b.jpg'],
        quoted_tweet: { author: 'x', text: 'y' },
        card: null,
      },
    ]
    render(<ResultsTable columns={columns} rows={rows} />)
    const table = screen.getByTestId('results-table')
    expect(table.textContent).not.toContain('[object Object]')
    expect(table.querySelectorAll('a')).toHaveLength(3) // url + 2 张 media_urls
  })
})
