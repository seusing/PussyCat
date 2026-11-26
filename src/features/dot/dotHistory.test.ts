import { describe, expect, it } from 'vitest'
import { readDotHistory, serializeDotHistory } from './dotHistory'

const NOTE = { noteId: '69bbe9d8000000001a02e786', title: '黄金', author: '某人', noteType: 'video', url: 'https://www.xiaohongshu.com/explore/69bbe9d8000000001a02e786', quote: '摘录' }

describe('readDotHistory', () => {
  it('认不出的条目丢掉,缺的字段补默认值;没有一轮能用的对话丢掉', () => {
    const conversations = readDotHistory({
      version: 1,
      conversations: [
        {
          id: 'c1', remoteId: '', title: '', createdAt: 'x',
          turns: [
            { id: 't1', question: '  第一问  ', answer: '答', state: 'weird', references: [NOTE, { noteId: 'bad' }], steps: ['搜索完成', 3], startedAt: 10, followUps: ['再问'] },
            { id: 't2', question: '' },
            { id: 't3', question: '出错的', state: 'error', startedAt: 20 },
          ],
        },
        { id: 'c1', turns: [{ id: 'dup', question: '重复的 id' }] },
        { id: 'empty', turns: [] },
        'garbage',
      ],
    })
    expect(conversations).toHaveLength(1)
    expect(conversations[0]).toMatchObject({ id: 'c1', remoteId: null, title: '第一问', createdAt: 10, updatedAt: 10 })
    expect(conversations[0].turns).toEqual([
      {
        id: 't1', question: '  第一问  ', answer: '答', steps: ['搜索完成'], references: [NOTE], sourceTotal: '', followUps: ['再问'],
        state: 'done', startedAt: 10, runId: '', busyRetries: 0,
      },
      {
        id: 't3', question: '出错的', answer: '', steps: [], references: [], sourceTotal: '', followUps: [],
        state: 'error', error: '点点这次没有答出来', startedAt: 20, runId: '', busyRetries: 0,
      },
    ])
  })

  it('不是存档格式时返回空数组', () => {
    expect(readDotHistory(null)).toEqual([])
    expect(readDotHistory({ version: 1 })).toEqual([])
  })

  it('存档不带只在本次运行里有意义的字段,读回来一样', () => {
    const [conversation] = readDotHistory({ version: 1, conversations: [{ id: 'c', title: 't', createdAt: 1, updatedAt: 2, turns: [{ id: 't', question: 'q', startedAt: 1, finishedAt: 3 }] }] })
    const file = serializeDotHistory([{ ...conversation, turns: [{ ...conversation.turns[0], runId: 'dot-chat:x', busyRetries: 2 }] }])
    expect(JSON.stringify(file)).not.toMatch(/runId|busyRetries/)
    expect(readDotHistory(file)).toEqual([conversation])
  })
})
