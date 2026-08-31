import { describe, expect, it } from 'vitest'
import type { VkJobRow } from '../../host/vkClient'
import { taskNumberKey } from './VkPanel'

function row(over: Partial<VkJobRow>): VkJobRow {
  return {
    job_id: 'j-1',
    kind: 'run',
    status: 'done',
    submitted_at: '2026-08-31T20:19:02+08:00',
    finished_at: null,
    parent_job_id: null,
    cache_bypass: false,
    ...over,
  }
}

describe('任务编号的身份', () => {
  it('中断后重跑落回同一个编号 —— 那是重跑,不是新任务', () => {
    // 后端的 retry 保留原 batch_id、并把 parent_job_id 指回被重试的那条,数据层面
    // 本来就是"在原任务上跑"。编号原先按「job_id + 提交时间」算,于是同一批的重跑
    // 在列表里又多出一条记录 —— 用户看到的和实际发生的对不上。
    const original = row({ job_id: 'a', batch_id: 'b-9', submitted_at: '2026-08-31T20:19:02+08:00' })
    const rerun = row({
      job_id: 'a-retry', parent_job_id: 'a', batch_id: 'b-9',
      submitted_at: '2026-08-31T20:22:54+08:00',
    })

    expect(taskNumberKey(rerun)).toBe(taskNumberKey(original))
  })

  it('同一批的不同视频共用一个编号', () => {
    expect(taskNumberKey(row({ job_id: 'a', batch_id: 'b-9' })))
      .toBe(taskNumberKey(row({ job_id: 'b', batch_id: 'b-9' })))
  })

  it('不同批次互不串号', () => {
    expect(taskNumberKey(row({ job_id: 'a', batch_id: 'b-9' })))
      .not.toBe(taskNumberKey(row({ job_id: 'a', batch_id: 'b-10' })))
  })

  it('没有批次的单条任务仍按 job_id + 提交时间算', () => {
    // 单条任务没有 batch_id,不能因为拿不到批次就让它们全挤进同一个编号。
    expect(taskNumberKey(row({ job_id: 'solo-1' })))
      .not.toBe(taskNumberKey(row({ job_id: 'solo-2' })))
  })
})
