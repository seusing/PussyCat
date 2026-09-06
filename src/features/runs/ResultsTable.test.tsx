import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ResultsTable } from './ResultsTable'

describe('ResultsTable 送去视频解析', () => {
  it('adds the action only for rows carrying a URL and passes the normalized URL', async () => {
    const user = userEvent.setup()
    const onSendToVk = vi.fn()
    render(
      <ResultsTable
        columns={['title', 'url']}
        rows={[
          { title: '有链接', url: ' https://example.com/v1 ' },
          { title: '无链接', url: 42 },
        ]}
        onSendToVk={onSendToVk}
      />,
    )
    expect(screen.getByTestId('send-to-vk-0')).toBeInTheDocument()
    expect(screen.queryByTestId('send-to-vk-1')).toBeNull()
    await user.click(screen.getByTestId('send-to-vk-0'))
    expect(onSendToVk).toHaveBeenCalledWith('https://example.com/v1')
  })

  it('renders no action column at all without the callback', () => {
    render(<ResultsTable columns={['url']} rows={[{ url: 'https://example.com' }]} />)
    expect(screen.queryByText('操作')).toBeNull()
    expect(screen.queryByTestId('send-to-vk-0')).toBeNull()
  })

  it('renders a fixed-size icon action when requested', () => {
    render(
      <ResultsTable
        columns={['title', 'url']}
        rows={[{ title: '示例视频', url: 'https://example.com/video' }]}
        onSendToVk={() => undefined}
        sendIconOnly
      />,
    )

    const button = screen.getByRole('button', { name: '送去视频解析' })
    expect(button).toHaveAttribute('title', '送去视频解析')
    expect(button).toHaveStyle({ width: '36px', height: '36px', padding: '0px' })
    expect(button.querySelector('.lucide-send')).toBeInTheDocument()
  })
})
