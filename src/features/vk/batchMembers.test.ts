import { describe, expect, it } from 'vitest'
import {
  aggregateBatchStatus,
  batchState,
  collapseAttempts,
  memberInFlight,
  memberSource,
  subtaskNumbers,
} from './batchMembers'

const row = (
  job_id: string,
  submitted_at: string,
  over: { source?: string; parent_job_id?: string | null; status?: string; finished_at?: string | null } = {},
) => ({ job_id, submitted_at, status: 'done', parent_job_id: null, ...over })

describe('aggregateBatchStatus', () => {
  const statuses = (...values: string[]) => values.map((status) => ({ status }))

  it.each([
    [['done', 'done'], 'done'],
    [['failed', 'failed'], 'failed'],
    [['cancelled', 'interrupted'], 'cancelled'],
    [['partial', 'partial'], 'partial'],
    [['done', 'failed'], 'partial_success'],
    [['done', 'partial'], 'partial_success'],
    [['done', 'cancelled'], 'partial_success'],
    [['partial', 'failed'], 'partial_success'],
    [['done', 'done', 'partial', 'failed'], 'partial_success'],
    [['failed', 'cancelled'], 'failed'],
    [['done', 'running'], 'running'],
    [['failed', 'queued'], 'queued'],
    [['done', 'queued', 'running'], 'queued'],
  ])('成员 %j 聚合出 %s', (members, expected) => {
    expect(aggregateBatchStatus(statuses(...members))).toBe(expected)
  })

  it('状态两侧的空白与大小写不影响判断', () => {
    expect(aggregateBatchStatus(statuses(' DONE ', 'Failed'))).toBe('partial_success')
  })
})

describe('batchState', () => {
  it.each([
    ['queued', 'queued'],
    [' Queued ', 'queued'],
    ['running', 'running'],
    ['cancel_requested', 'running'],
    ['retrying', 'running'],
    ['done', 'done'],
    ['partial', 'partial'],
    ['failed', 'failed'],
    ['quarantined', 'failed'],
    ['cancelled', 'interrupted'],
    ['completed_after_cancel_request', 'interrupted'],
  ])('%s 归为 %s', (status, expected) => {
    expect(batchState(status)).toBe(expected)
  })

  it('排队和运行都算还没落定', () => {
    expect(memberInFlight('queued')).toBe(true)
    expect(memberInFlight('running')).toBe(true)
    for (const state of ['done', 'partial', 'failed', 'interrupted'] as const) {
      expect(memberInFlight(state)).toBe(false)
    }
  })
})

describe('memberSource', () => {
  it('列表行的顶层 source 优先,其次是详情里的 request.source,只取第一行', () => {
    expect(memberSource({ source: 'https://a/1\nhttps://a/2', request: { source: 'https://b' } })).toBe('https://a/1')
    expect(memberSource({ request: { source: ' https://b ' } })).toBe('https://b')
    expect(memberSource({})).toBe('')
  })
})

describe('subtaskNumbers', () => {
  it('每个视频一个编号,从 1 开始', () => {
    const numbers = subtaskNumbers([
      row('a', '2026-09-01T00:00:00Z', { source: 'https://v/1' }),
      row('b', '2026-09-01T00:00:01Z', { source: 'https://v/2' }),
      row('c', '2026-09-01T00:00:02Z', { source: 'https://v/3' }),
    ])
    expect([...numbers]).toEqual([['a', 1], ['b', 2], ['c', 3]])
  })

  it('编号按首次提交排序,与传入顺序无关', () => {
    const numbers = subtaskNumbers([
      row('late', '2026-09-01T00:00:09Z', { source: 'https://v/3' }),
      row('first', '2026-09-01T00:00:01Z', { source: 'https://v/1' }),
      row('middle', '2026-09-01T00:00:05Z', { source: 'https://v/2' }),
    ])
    expect(numbers.get('first')).toBe(1)
    expect(numbers.get('middle')).toBe(2)
    expect(numbers.get('late')).toBe(3)
  })

  it('重跑同一个视频,每一次尝试都落在原来的编号上,后面的编号不顺延', () => {
    const numbers = subtaskNumbers([
      row('a', '2026-09-01T00:00:00Z', { source: 'https://v/1', status: 'failed' }),
      row('b', '2026-09-01T00:00:01Z', { source: 'https://v/2' }),
      row('a-retry', '2026-09-01T00:10:00Z', { source: 'https://v/1', parent_job_id: 'a' }),
      // 另开的一条新任务:带批次、不带 parent,凭来源链接仍认得出是同一个视频
      row('a-again', '2026-09-01T00:20:00Z', { source: 'https://v/1' }),
    ])
    expect(numbers.get('a')).toBe(1)
    expect(numbers.get('a-retry')).toBe(1)
    expect(numbers.get('a-again')).toBe(1)
    expect(numbers.get('b')).toBe(2)
    expect(new Set(numbers.values())).toEqual(new Set([1, 2]))
  })

  it('重跑晚于其他视频提交,也不改变被重跑视频的位置', () => {
    const numbers = subtaskNumbers([
      row('x', '2026-09-01T00:00:00Z', { source: 'https://v/x' }),
      row('y', '2026-09-01T00:00:01Z', { source: 'https://v/y' }),
      row('z', '2026-09-01T00:00:02Z', { source: 'https://v/z' }),
      row('x-retry', '2026-09-01T01:00:00Z', { source: 'https://v/x', parent_job_id: 'x' }),
    ])
    expect(['x', 'y', 'z', 'x-retry'].map((id) => numbers.get(id))).toEqual([1, 2, 3, 1])
  })

  it('没有来源时退回重试链', () => {
    const numbers = subtaskNumbers([
      row('root-1', '2026-09-01T00:00:00Z'),
      row('root-2', '2026-09-01T00:00:01Z'),
      row('retry-1', '2026-09-01T00:30:00Z', { parent_job_id: 'root-1' }),
      row('retry-1b', '2026-09-01T00:40:00Z', { parent_job_id: 'retry-1' }),
    ])
    expect(['root-1', 'root-2', 'retry-1', 'retry-1b'].map((id) => numbers.get(id))).toEqual([1, 2, 1, 1])
  })

  it('没有来源且 parent 已不在列表里时,各自成一个小任务', () => {
    const numbers = subtaskNumbers([
      row('orphan', '2026-09-01T00:00:00Z', { parent_job_id: 'gone' }),
      row('other', '2026-09-01T00:00:01Z'),
    ])
    expect([...numbers]).toEqual([['orphan', 1], ['other', 2]])
  })

  it('与 collapseAttempts 的顺序完全一致', () => {
    const rows = [
      row('c', '2026-09-01T00:00:03Z', { source: 'https://v/3' }),
      row('a', '2026-09-01T00:00:01Z', { source: 'https://v/1', status: 'cancelled' }),
      row('b', '2026-09-01T00:00:02Z', { source: 'https://v/2' }),
      row('a-retry', '2026-09-01T00:05:00Z', { source: 'https://v/1', parent_job_id: 'a', status: 'running' }),
    ]
    const numbers = subtaskNumbers(rows)
    const members = collapseAttempts(rows)
    expect(members.map((member) => member.job_id)).toEqual(['a-retry', 'b', 'c'])
    members.forEach((member, index) => expect(numbers.get(member.job_id)).toBe(index + 1))
  })
})

describe('collapseAttempts', () => {
  it('同一个视频折成一行,取最新一次尝试的状态、job_id 与耗时起点', () => {
    const members = collapseAttempts([
      row('a', '2026-09-01T00:00:00Z', { source: 'https://v/1', status: 'cancelled', finished_at: '2026-09-01T00:01:00Z' }),
      row('a-retry', '2026-09-01T00:10:00Z', { source: 'https://v/1', parent_job_id: 'a', status: 'queued' }),
      row('b', '2026-09-01T00:00:01Z', { source: 'https://v/2', status: 'running' }),
    ])
    expect(members).toEqual([
      {
        job_id: 'a-retry', source: 'https://v/1', status: 'queued', state: 'queued',
        submitted_at: '2026-09-01T00:10:00Z', finished_at: null,
      },
      {
        job_id: 'b', source: 'https://v/2', status: 'running', state: 'running',
        submitted_at: '2026-09-01T00:00:01Z', finished_at: null,
      },
    ])
  })
})
