import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../../App'
import { useAppStore } from '../../store/appStore'
import type { CommandManifest } from '../../data/types'

const cmd: CommandManifest = {
  command: 'x/go', site: 'x', name: 'go', description: '', access: 'read', browser: false, args: [], columns: ['status', 'site'],
}

beforeEach(() => {
  useAppStore.setState({ commands: [cmd], selected: cmd, values: {}, currentRun: undefined })
})

test('端到端：运行一条 mock 命令走到成功终态并出表格', async () => {
  render(<App />)
  await userEvent.click(screen.getByTestId('run-button'))
  await waitFor(() => expect(screen.getByTestId('run-state')).toHaveTextContent('已完成'), { timeout: 2000 })
  await userEvent.click(screen.getByText('表格结果'))
  expect(screen.getByTestId('results-table')).toBeInTheDocument()
})

test('运行中显示取消执行按钮', async () => {
  render(<App />)
  await userEvent.click(screen.getByTestId('run-button'))
  await waitFor(() => expect(screen.getByTestId('cancel-button')).toBeInTheDocument())
})
