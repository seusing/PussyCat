import { Component, type ErrorInfo, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { EmptyState } from './EmptyState'

const MESSAGE_MAX_LENGTH = 160

type State = { error: Error | null }

/** 包在每个页面外:一个页面渲染出错时只让它自己显示兜底,侧栏和其他页面照常可用。 */
export class ModuleErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ModuleErrorBoundary]', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const message = (error.message || String(error)).split('\n')[0].slice(0, MESSAGE_MAX_LENGTH)
    return (
      <div data-testid="module-error-fallback">
        <EmptyState icon={<TriangleAlert size={22} />} title="这个页面出错了" description={message}>
          <button
            type="button"
            data-testid="module-error-reload"
            onClick={() => this.setState({ error: null })}
            className="mt-2 rounded-lg px-3 py-1.5 text-sm"
            style={{ border: '1px solid var(--color-line)', color: 'var(--color-fg)' }}
          >
            重新加载此页
          </button>
        </EmptyState>
      </div>
    )
  }
}
