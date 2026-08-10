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

// P1 Task7:liveCatalogSource 改打 /catalog/effective,envelope 为 {revision, snapshot, policy:{decisions}}
// (snapshot 与判决共享同一 revision 下发,I-P4)——不再是拍平的 CatalogSnapshot。
test('live source: GET {base}/catalog/effective 成功,无 degraded,decisions 透传', async () => {
  const decisions = [{ commandKey: 'a/b', state: 'ready', decisionSource: 'legacy-baseline' }]
  const fetchImpl = vi.fn().mockResolvedValue(okJson({
    revision: 'r1', snapshot: SNAP, policy: { schemaVersion: 1, generatedAt: 1, decisions },
  }))
  const { snapshot, degraded, decisions: gotDecisions } =
    await liveCatalogSource('http://127.0.0.1:9999', fetchImpl as unknown as typeof fetch).load()
  expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:9999/catalog/effective')
  expect(snapshot.schemaVersion).toBe(1)
  expect(degraded).toBeUndefined()
  expect(gotDecisions).toEqual(decisions)
})

test('live source: 用户刷新时显式请求 refresh=1', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(okJson({
    revision: 'r1', snapshot: SNAP, policy: { schemaVersion: 1, generatedAt: 1, decisions: [] },
  }))
  await liveCatalogSource('http://127.0.0.1:9999', fetchImpl as unknown as typeof fetch).load({ refresh: true })
  expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:9999/catalog/effective?refresh=1')
})

test('live 失败 → 降级 snapshot 并带 degraded 原因,且不下发 decisions(不得编造判决,I-P1)', async () => {
  const fetchImpl = vi.fn()
    .mockRejectedValueOnce(new Error('ECONNREFUSED'))         // live
    .mockResolvedValueOnce(okJson(SNAP))                      // fallback snapshot
  const { snapshot, degraded, decisions } = await liveCatalogSource('http://127.0.0.1:9999', fetchImpl as unknown as typeof fetch).load()
  expect(snapshot.commands).toHaveLength(1)
  expect(degraded).toMatch(/ECONNREFUSED/)
  expect(decisions).toBeUndefined()
})

// envelope 校验:policy.decisions 不是数组时按整体失败处理,走降级(不得部分信任畸形 envelope)
test('live 返回 decisions 非数组 → 视为失败,降级 snapshot', async () => {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(okJson({ revision: 'r1', snapshot: SNAP, policy: { schemaVersion: 1, generatedAt: 1, decisions: 'not-an-array' } }))
    .mockResolvedValueOnce(okJson(SNAP))                      // fallback snapshot
  const { snapshot, degraded, decisions } = await liveCatalogSource('http://127.0.0.1:9999', fetchImpl as unknown as typeof fetch).load()
  expect(snapshot.commands).toHaveLength(1)
  expect(degraded).toBeDefined()
  expect(decisions).toBeUndefined()
})

test('live 与 snapshot 双败 → 抛错', async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new Error('all down'))
  await expect(liveCatalogSource('http://x', fetchImpl as unknown as typeof fetch).load()).rejects.toThrow()
})
