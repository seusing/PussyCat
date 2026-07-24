import { createHostSelection } from './index'

test('defaults to demo mock host', () => {
  const selected = createHostSelection({ search: '', env: {} })
  expect(selected.mode).toBe('demo')
  expect(selected.host).toBeDefined()
})

test('environment and query select connected node host', () => {
  const fromEnv = createHostSelection({ search: '', env: { VITE_HOST_MODE: 'node', VITE_NODE_HOST_URL: 'http://node' } })
  expect(fromEnv.mode).toBe('connected')
  const fromQuery = createHostSelection({ search: '?host=node', env: { VITE_HOST_MODE: 'mock' } })
  expect(fromQuery.mode).toBe('connected')
})

