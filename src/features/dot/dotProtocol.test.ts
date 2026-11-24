import { describe, expect, it } from 'vitest'
import { dotChatRunId, dotStopRunId, isDotRunId, isDotStopRunId, parseDotLine } from './dotProtocol'

const line = (event: Record<string, unknown>) => `@@zz-dot ${JSON.stringify(event)}`

describe('parseDotLine', () => {
  it('解析各类事件', () => {
    expect(parseDotLine(line({ type: 'start', conversationId: 'c1', messageId: 'm1', region: 'rednote' })))
      .toEqual({ type: 'start', conversationId: 'c1', messageId: 'm1' })
    expect(parseDotLine(line({ type: 'status', text: '正在搜索相关笔记' }))).toEqual({ type: 'status', text: '正在搜索相关笔记' })
    expect(parseDotLine(line({ type: 'delta', text: '你好' }))).toEqual({ type: 'delta', text: '你好' })
    expect(parseDotLine(line({ type: 'replace', text: '' }))).toEqual({ type: 'replace', text: '' })
    expect(parseDotLine(line({ type: 'done', sourceTotal: 'ai为你回答', interrupted: false })))
      .toEqual({ type: 'done', sourceTotal: 'ai为你回答', interrupted: false })
    expect(parseDotLine(line({ type: 'error', message: '' }))).toEqual({ type: 'error', message: '点点这次没有答出来' })
  })

  it('opencli 自己的警告、坏 JSON、未知类型一律忽略', () => {
    expect(parseDotLine('  Extension update available: v1.0.26 → v1.0.27')).toBeNull()
    expect(parseDotLine('@@zz-dot {not json')).toBeNull()
    expect(parseDotLine(line({ type: 'mystery' }))).toBeNull()
    expect(parseDotLine(line({ type: 'delta', text: '' }))).toBeNull()
    expect(parseDotLine('@@zz-dot [1,2]')).toBeNull()
  })

  it('行尾的 \\r 不影响解析', () => {
    expect(parseDotLine(`${line({ type: 'delta', text: 'a' })}\r`)).toEqual({ type: 'delta', text: 'a' })
  })

  it('引用只收带笔记 id 和 https 链接的条目', () => {
    const good = { noteId: '69bbe9d8000000001a02e786', title: '黄金', author: '某人', noteType: 'video', url: 'https://www.xiaohongshu.com/explore/69bbe9d8000000001a02e786', quote: '摘录' }
    const parsed = parseDotLine(line({
      type: 'references',
      items: [good, { ...good, noteId: 'bad' }, { ...good, url: 'javascript:alert(1)' }, null, { ...good, noteType: 'weird' }],
    }))
    expect(parsed).toEqual({ type: 'references', items: [good, { ...good, noteType: '' }] })
  })
})

describe('运行 id', () => {
  it('提问和停止都归点点通道,停止可单独认出', () => {
    expect(isDotRunId(dotChatRunId('a'))).toBe(true)
    expect(isDotRunId(dotStopRunId('a'))).toBe(true)
    expect(isDotStopRunId(dotStopRunId('a'))).toBe(true)
    expect(isDotStopRunId(dotChatRunId('a'))).toBe(false)
    expect(isDotRunId('login-check:xiaohongshu:1')).toBe(false)
  })
})
