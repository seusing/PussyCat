import { render, screen } from '@testing-library/react'
import App from '../App'
import type { HostBridge } from '../host/types'
import { useAppStore } from '../store/appStore'

beforeEach(() => useAppStore.setState({ catalogStatus: 'ready' }))

test('三栏 + 顶部健康 pill 显示演示模式', () => {
  render(<App />)
  expect(screen.getByTestId('col-nav')).toBeInTheDocument()
  expect(screen.getByTestId('col-config')).toBeInTheDocument()
  expect(screen.getByTestId('col-runs')).toBeInTheDocument()
  expect(screen.getByTestId('health-pill')).toHaveTextContent('演示模式')
})

test('真实 Host 注入时显示已连接', () => {
  const host: HostBridge = {
    startCommand: async ({ runId }) => ({ runId }),
    cancelCommand: async () => {},
    onOutput: () => () => {},
    onDone: () => () => {},
  }
  render(<App host={host} mode="connected" />)
  expect(screen.getByTestId('health-pill')).toHaveTextContent('已连接')
})
