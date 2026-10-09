import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import type { VkJobRow, VkStorylineRow } from '../../host/vkClient'
import {
  appInBackground,
  detectJobSettlements,
  detectStorylineSettlements,
  jobSettlementNotice,
  notifyDesktop,
  snapshotJobStatuses,
  snapshotStorylineStatuses,
  storylineNotice,
} from './jobNotifications'

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}))

const row = (job_id: string, status: string, over: Partial<VkJobRow> = {}): VkJobRow => ({
  job_id, kind: 'request', status, submitted_at: '2026-10-01T00:00:00Z', finished_at: null,
  parent_job_id: null, cache_bypass: false, taskNumber: 7, ...over,
})

/** 与 VkPanel 折叠后的批量行同形:带成员,状态是聚合出来的。 */
const batch = (status: string, members: Array<[string, string]>): VkJobRow => row(members[0][0], status, {
  logicalTaskId: members[0][0],
  batchMembers: members.map(([id, memberStatus]) => row(id, memberStatus)),
})

const before = (...rows: VkJobRow[]) => snapshotJobStatuses(rows)

describe('detectJobSettlements', () => {
  it('首次加载(没有上一次快照)不通知,历史任务也不通知', () => {
    expect(detectJobSettlements(null, [row('a', 'done'), row('b', 'failed')])).toEqual([])
    expect(detectJobSettlements(before(row('a', 'done'), row('b', 'failed')), [row('a', 'done'), row('b', 'failed')])).toEqual([])
  })

  it('单个任务从进行中变成完成、失败、部分完成才通知', () => {
    const previous = before(row('a', 'running'), row('b', 'queued'), row('c', 'processing'))
    const settled = detectJobSettlements(previous, [row('a', 'done'), row('b', 'failed'), row('c', 'partial')])
    expect(settled.map((item) => [item.jobId, item.outcome])).toEqual([['a', 'done'], ['b', 'failed'], ['c', 'partial']])
    expect(settled[1]).toMatchObject({ total: 1, succeeded: 0, failed: 1, failedJobIds: ['b'] })
  })

  it('仍在进行、只是换了进行态、本次运行没见过的任务都不通知', () => {
    const previous = before(row('a', 'running'))
    expect(detectJobSettlements(previous, [row('a', 'cancel_requested'), row('fresh', 'done')])).toEqual([])
  })

  it('用户自己中断的不通知', () => {
    const previous = before(row('a', 'running'), row('b', 'running'))
    expect(detectJobSettlements(previous, [
      row('a', 'cancelled'), row('b', 'completed_after_cancel_request'),
    ])).toEqual([])
  })

  it('批次整批落定才通知一次,成功与失败的数量来自成员', () => {
    const previous = before(batch('running', [['m1', 'done'], ['m2', 'running'], ['m3', 'failed']]))
    expect(detectJobSettlements(previous, [batch('running', [['m1', 'done'], ['m2', 'running'], ['m3', 'failed']])])).toEqual([])

    const settled = detectJobSettlements(previous, [
      batch('partial_success', [['m1', 'done'], ['m2', 'done'], ['m3', 'failed']]),
    ])
    expect(settled).toEqual([{
      jobId: 'm1', taskNumber: 7, outcome: 'partial', total: 3, succeeded: 2, failed: 1, interrupted: 0, failedJobIds: ['m3'],
    }])
  })

  it('重试沿用同一个逻辑任务:失败后重跑再完成会通知', () => {
    const failedRow = row('retry-1', 'failed', { logicalTaskId: 'root' })
    const retrying = row('retry-2', 'running', { logicalTaskId: 'root' })
    const finished = row('retry-2', 'done', { logicalTaskId: 'root' })
    expect(detectJobSettlements(before(failedRow), [retrying])).toEqual([])
    expect(detectJobSettlements(before(retrying), [finished]).map((item) => item.outcome)).toEqual(['done'])
  })
})

describe('jobSettlementNotice', () => {
  const settlement = (over = {}) => detectJobSettlements(
    before(row('a', 'running')), [row('a', 'done')],
  ).map((item) => ({ ...item, ...over }))[0]

  it('单个视频', () => {
    expect(jobSettlementNotice(settlement())).toEqual({ title: '解析完成', body: '任务 7' })
    expect(jobSettlementNotice(settlement({ outcome: 'partial' })).title).toBe('部分完成')
  })

  it('单个视频失败时附失败原因,取不到原因就不写', () => {
    const failed = settlement({ outcome: 'failed', succeeded: 0, failed: 1, failedJobIds: ['a'] })
    expect(jobSettlementNotice(failed, '模型服务限流了')).toEqual({ title: '解析失败', body: '任务 7：模型服务限流了' })
    expect(jobSettlementNotice(failed).body).toBe('任务 7')
  })

  it('批次写数量,失败时括号附第 1 项失败的原因', () => {
    const mixed = detectJobSettlements(
      before(batch('running', [['m1', 'done'], ['m2', 'running'], ['m3', 'running']])),
      [batch('partial_success', [['m1', 'done'], ['m2', 'done'], ['m3', 'failed']])],
    )[0]
    expect(jobSettlementNotice(mixed, '模型服务限流了')).toEqual({
      title: '部分完成', body: '3 个视频：2 成功、1 失败（模型服务限流了）',
    })
    expect(jobSettlementNotice(mixed).body).toBe('3 个视频：2 成功、1 失败')
  })

  it('批次全部成功或全部失败', () => {
    const run = (members: Array<[string, string]>) => detectJobSettlements(
      before(batch('running', members.map(([id]) => [id, 'running'] as [string, string]))),
      [batch(members[0][1], members)],
    )[0]
    expect(jobSettlementNotice(run([['m1', 'done'], ['m2', 'done']]))).toEqual({ title: '解析完成', body: '2 个视频：2 成功' })
    expect(jobSettlementNotice(run([['m1', 'failed'], ['m2', 'failed']]), '视频下载失败')).toEqual({
      title: '解析失败', body: '2 个视频：2 失败（视频下载失败）',
    })
  })

  it('批次里混有中断的成员会写出来', () => {
    const settled = detectJobSettlements(
      before(batch('running', [['m1', 'running'], ['m2', 'running']])),
      [batch('partial_success', [['m1', 'done'], ['m2', 'cancelled']])],
    )[0]
    expect(settled.outcome).toBe('partial')
    expect(jobSettlementNotice(settled).body).toBe('2 个视频：1 成功、1 中断')
  })
})

describe('串联通知', () => {
  const storyline = (storyline_id: string, status: VkStorylineRow['status'], over: Partial<VkStorylineRow> = {}): VkStorylineRow => ({
    storyline_id, batch_id: 'batch-1', status, trigger: 'auto', requested_at: '2026-10-01T00:00:00Z',
    started_at: null, finished_at: null, error: null, reason: null, storyline_count: 2, standalone_count: 1,
    cost_cny: null, ...over,
  })

  it('只对本次运行里从进行中变为完成、部分完成、失败的串联通知', () => {
    const previous = snapshotStorylineStatuses([
      storyline('s1', 'waiting'), storyline('s2', 'running'), storyline('s3', 'queued'),
      storyline('s4', 'running'), storyline('s5', 'done'),
    ])
    const settled = detectStorylineSettlements(previous, [
      storyline('s1', 'done'), storyline('s2', 'partial'), storyline('s3', 'failed', { error: 'channel-a:default HTTP 429' }),
      storyline('s4', 'skipped'), storyline('s5', 'done'), storyline('fresh', 'done'),
    ])
    expect(settled.map((item) => item.storyline_id)).toEqual(['s1', 's2', 's3'])
    expect(detectStorylineSettlements(null, [storyline('s1', 'done')])).toEqual([])
  })

  it('文案', () => {
    expect(storylineNotice(storyline('s1', 'done'))).toEqual({
      title: '串联完成', body: '已串成 2 条故事线，1 个视频未归入',
    })
    expect(storylineNotice(storyline('s1', 'failed'), '模型服务限流了')).toEqual({ title: '串联失败', body: '模型服务限流了' })
    expect(storylineNotice(storyline('s1', 'failed')).body).toBe('串联失败')
  })
})

describe('notifyDesktop', () => {
  beforeEach(() => {
    vi.mocked(isPermissionGranted).mockReset().mockResolvedValue(true)
    vi.mocked(requestPermission).mockReset().mockResolvedValue('granted')
    vi.mocked(sendNotification).mockReset()
  })
  afterEach(() => { delete window.__OPENCLI_BOOT__ })

  const notice = { title: '解析完成', body: '任务 7' }

  it('浏览器开发模式(没有 Tauri 壳)不发通知,也不去问权限', async () => {
    await notifyDesktop(notice)
    expect(isPermissionGranted).not.toHaveBeenCalled()
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('已有权限直接发送', async () => {
    window.__OPENCLI_BOOT__ = { baseUrl: 'http://127.0.0.1:43117' }
    await notifyDesktop(notice)
    expect(requestPermission).not.toHaveBeenCalled()
    expect(sendNotification).toHaveBeenCalledWith(notice)
  })

  it('首次需要时申请权限,允许后发送', async () => {
    window.__OPENCLI_BOOT__ = { baseUrl: 'http://127.0.0.1:43117' }
    vi.mocked(isPermissionGranted).mockResolvedValue(false)
    await notifyDesktop(notice)
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(sendNotification).toHaveBeenCalledWith(notice)
  })

  it('用户拒绝就安静跳过', async () => {
    window.__OPENCLI_BOOT__ = { baseUrl: 'http://127.0.0.1:43117' }
    vi.mocked(isPermissionGranted).mockResolvedValue(false)
    vi.mocked(requestPermission).mockResolvedValue('denied')
    await expect(notifyDesktop(notice)).resolves.toBeUndefined()
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('插件调用出错也不抛', async () => {
    window.__OPENCLI_BOOT__ = { baseUrl: 'http://127.0.0.1:43117' }
    vi.mocked(sendNotification).mockImplementation(() => { throw new Error('plugin missing') })
    await expect(notifyDesktop(notice)).resolves.toBeUndefined()
  })
})

describe('appInBackground', () => {
  afterEach(() => vi.restoreAllMocks())

  it('页面隐藏或没有焦点算不在前台', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    expect(appInBackground()).toBe(false)
    hasFocus.mockReturnValue(false)
    expect(appInBackground()).toBe(true)
    hasFocus.mockReturnValue(true)
    hidden.mockReturnValue(true)
    expect(appInBackground()).toBe(true)
  })
})
