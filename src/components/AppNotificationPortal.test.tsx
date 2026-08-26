import { render, screen, waitFor } from '@testing-library/react'
import { AppNotificationPortal } from './AppNotificationPortal'

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
