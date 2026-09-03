import { describe, expect, it } from 'vitest'
import type { VkJobRow } from '../../host/vkClient'
import { vkTaskResultGroups } from './taskResults'

function row(jobId: string, overrides: Partial<VkJobRow> = {}): VkJobRow {
  return {
    job_id: jobId, kind: 'run', status: 'done', batch_id: 'batch-one',
    submitted_at: '2026-09-03T00:00:00Z', finished_at: '2026-09-03T00:01:00Z',
    parent_job_id: null, cache_bypass: false, source: `https://example.com/${jobId}`,
    ...overrides,
  }
}

describe('vkTaskResultGroups', () => {
  it('keeps the original ordinal when an earlier batch member has no results', () => {
    const groups = vkTaskResultGroups([
      row('first', { status: 'failed' }),
      row('second', { submitted_at: '2026-09-03T00:00:01Z' }),
    ], 'second')
    expect(groups.map((group) => ({ ordinal: group.ordinal, versions: group.versions.map((version) => version.jobId) })))
      .toEqual([{ ordinal: 1, versions: [] }, { ordinal: 2, versions: ['second'] }])
  })

  it('includes only the selected batch even when another submission has the same source', () => {
    const groups = vkTaskResultGroups([
      row('old', { batch_id: 'other-batch', source: 'https://example.com/same' }),
      row('current', { source: 'https://example.com/same' }),
      row('sibling'),
    ], 'current')
    expect(groups.flatMap((group) => group.versions.map((version) => version.jobId))).toEqual(['current', 'sibling'])
  })

  it.each(['failed', 'cancelled', 'running'])('preserves completed versions when the latest retry is %s', (status) => {
    const groups = vkTaskResultGroups([
      row('original', { batch_id: null }),
      row('retry-one', { batch_id: null, parent_job_id: 'original', status: 'partial', submitted_at: '2026-09-03T00:02:00Z' }),
      row('retry-two', { batch_id: null, parent_job_id: 'retry-one', status, submitted_at: '2026-09-03T00:04:00Z' }),
    ], 'retry-two')
    expect(groups).toHaveLength(1)
    expect(groups[0].versions.map(({ jobId, attempt }) => ({ jobId, attempt }))).toEqual([
      { jobId: 'retry-one', attempt: 2 }, { jobId: 'original', attempt: 1 },
    ])
  })

  it('does not merge independent unbatched submissions of the same source', () => {
    const groups = vkTaskResultGroups([
      row('original', { batch_id: null, source: 'https://example.com/same' }),
      row('separate', { batch_id: null, source: 'https://example.com/same' }),
      row('retry', { batch_id: null, parent_job_id: 'original', status: 'failed', source: 'https://example.com/same' }),
    ], 'retry')
    expect(groups).toHaveLength(1)
    expect(groups[0].versions.map((version) => version.jobId)).toEqual(['original'])
  })
})
