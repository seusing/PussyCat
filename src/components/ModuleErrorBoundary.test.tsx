import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModuleErrorBoundary } from './ModuleErrorBoundary'

function Boom({ message }: { message: string }): never {
  throw new Error(message)
}

const flaky = { broken: true }

function Flaky() {
  if (flaky.broken) throw new Error('渲染失败')
  return <div data-testid="flaky-content">恢复了</div>
}

beforeEach(() => {
  flaky.broken = true
  // React 会把被边界接住的错误同样打到 console.error,这里只是让测试输出干净。
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('ModuleErrorBoundary', () => {
  test('子组件抛错时只有这一块显示兜底,同级的另一块照常', () => {
    render(
      <div>
        <ModuleErrorBoundary><Boom message="Cannot read properties of undefined" /></ModuleErrorBoundary>
        <ModuleErrorBoundary><div data-testid="other-panel">另一页</div></ModuleErrorBoundary>
      </div>,
    )

    const fallback = screen.getByTestId('module-error-fallback')
    expect(fallback).toHaveTextContent('这个页面出错了')
    expect(fallback).toHaveTextContent('Cannot read properties of undefined')
    expect(screen.getByRole('button', { name: '重新加载此页' })).toBeInTheDocument()
    expect(screen.getByTestId('other-panel')).toHaveTextContent('另一页')
  })

  test('错误信息只取第一行并截短', () => {
    render(<ModuleErrorBoundary><Boom message={`${'x'.repeat(300)}\nsecond line`} /></ModuleErrorBoundary>)

    const text = screen.getByTestId('module-error-fallback').textContent ?? ''
    expect(text).toContain('x'.repeat(160))
    expect(text).not.toContain('x'.repeat(161))
    expect(text).not.toContain('second line')
  })

  test('点「重新加载此页」会重置边界并重新渲染这一页', async () => {
    render(<ModuleErrorBoundary><Flaky /></ModuleErrorBoundary>)
    expect(screen.getByTestId('module-error-fallback')).toBeInTheDocument()

    flaky.broken = false
    await userEvent.click(screen.getByTestId('module-error-reload'))

    expect(screen.getByTestId('flaky-content')).toHaveTextContent('恢复了')
    expect(screen.queryByTestId('module-error-fallback')).not.toBeInTheDocument()
  })

  test('重新渲染仍然出错时回到兜底,不会白屏', async () => {
    render(<ModuleErrorBoundary><Flaky /></ModuleErrorBoundary>)

    await userEvent.click(screen.getByTestId('module-error-reload'))

    expect(screen.getByTestId('module-error-fallback')).toBeInTheDocument()
  })

  test('没有错误时原样渲染子内容,且保留子组件的状态', async () => {
    function Counter() {
      const [count, setCount] = useState(0)
      return <button type="button" onClick={() => setCount((value) => value + 1)}>计数 {count}</button>
    }
    render(<ModuleErrorBoundary><Counter /></ModuleErrorBoundary>)

    await userEvent.click(screen.getByRole('button', { name: '计数 0' }))

    expect(screen.getByRole('button', { name: '计数 1' })).toBeInTheDocument()
  })
})
