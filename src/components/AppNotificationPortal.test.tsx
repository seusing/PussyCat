import { useContext } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { AppNotificationPortal } from './AppNotificationPortal'
import { NotificationLayerContext } from './notificationContext'

test('通知挂到共享悬浮层', async () => {
  render(
    <>
      <div data-testid="app-notification-layer" />
      <AppNotificationPortal><div data-testid="portal-child">通知</div></AppNotificationPortal>
    </>,
  )

  await waitFor(() => expect(screen.getByTestId('app-notification-layer'))
    .toContainElement(screen.getByTestId('portal-child')))
})

test('共享悬浮层不存在时原位渲染', () => {
  const { container } = render(
    <AppNotificationPortal><div data-testid="portal-fallback">通知</div></AppNotificationPortal>,
  )

  expect(container).toContainElement(screen.getByTestId('portal-fallback'))
})

test('挂到悬浮层的内容读得到「在悬浮层里」的上下文,原位渲染的读不到', async () => {
  const Probe = ({ id }: { id: string }) => <span data-testid={id}>{String(useContext(NotificationLayerContext))}</span>
  const first = render(
    <>
      <div data-testid="app-notification-layer" />
      <AppNotificationPortal><Probe id="portal-probe" /></AppNotificationPortal>
    </>,
  )
  await waitFor(() => expect(screen.getByTestId('app-notification-layer')).toContainElement(screen.getByTestId('portal-probe')))
  expect(screen.getByTestId('portal-probe')).toHaveTextContent('true')

  first.unmount()
  render(<AppNotificationPortal><Probe id="inline-probe" /></AppNotificationPortal>)
  expect(screen.getByTestId('inline-probe')).toHaveTextContent('false')
})
