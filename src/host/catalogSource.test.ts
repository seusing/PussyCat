import { snapshotCatalogSource, liveCatalogSource } from './catalogSource'

const SNAP = {
  schemaVersion: 1, generatedAt: 1, opencliVersion: 'x', source: 's', listSha256: 'a', manifestSha256: 'b',
  commands: [{ command: 'a/b', site: 'a', name: 'b', description: '', access: 'read', browser: false, args: [] }],
}
const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as Response

test('snapshot source: no-store 拉快照,无 degraded', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(okJson(SNAP))
  const { snapshot, degraded } = await snapshotCatalogSource(fetchImpl as unknown as typeof fetch).load()
  expect(fetchImpl).toHaveBeenCalledWith('/catalog.snapshot.json', expect.objectContaining({ cache: 'no-store' }))
  expect(snapshot.commands).toHaveLength(1)
  expect(degraded).toBeUndefined()
})

test('live source: GET {base}/catalog 成功,无 degraded', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(okJson(SNAP))
  const { snapshot, degraded } = await liveCatalogSource('http://127.0.0.1:9999', fetchImpl as unknown as typeof fetch).load()
  expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:9999/catalog')
  expect(snapshot.schemaVersion).toBe(1)
  expect(degraded).toBeUndefined()
})

test('live 失败 → 降级 snapshot 并带 degraded 原因', async () => {
  const fetchImpl = vi.fn()
    .mockRejectedValueOnce(new Error('ECONNREFUSED'))         // live
    .mockResolvedValueOnce(okJson(SNAP))                      // fallback snapshot
  const { snapshot, degraded } = await liveCatalogSource('http://127.0.0.1:9999', fetchImpl as unknown as typeof fetch).load()
  expect(snapshot.commands).toHaveLength(1)
  expect(degraded).toMatch(/ECONNREFUSED/)
})

test('live 与 snapshot 双败 → 抛错', async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new Error('all down'))
  await expect(liveCatalogSource('http://x', fetchImpl as unknown as typeof fetch).load()).rejects.toThrow()
})
