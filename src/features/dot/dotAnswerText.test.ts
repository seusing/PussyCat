import { describe, expect, it } from 'vitest'
import { prepareDotMarkdown } from './dotAnswerText'

// 2026-11-25 点点回答里的原样片段(图片块的属性有删节)
const IMAGE = (index: number, noteId: string, nickname: string) => `<div class="ai-msg-image-item" data-index="${index}">
  <img
    src="http://sns-note-i4.xhscdn.com/1040g00831tev4bl7me4g5ng9qh8g9631aqmu8ig?imageView2/2/w/576/format/webp"
    alt="${noteId}"
    data-width="3472"
    data-height="4624"
    data-noteId="${noteId}"
    data-sourceNickname="${nickname}"
    data-link="xhsdiscover://item/${noteId}?sourceId=dqa_answer_v2_page"
  />
</div>`

describe('prepareDotMarkdown', () => {
  it('图片块换成指向原笔记的链接,连着的几张并成一行,外层标签去掉', () => {
    const answer = `<div class="ai-msg-text">\n**肇庆**：高铁约1小时。\n</div>\n\n${IMAGE(1, '69ad4ff6000000002602ff78', '西岁')}\n\n${IMAGE(2, '69ad4ff6000000002602ff79', '小周')}\n\n</div>\n\n下一段`
    const markdown = prepareDotMarkdown(answer)
    expect(markdown).not.toMatch(/<\/?div|<img|data-/)
    expect(markdown).toContain('**肇庆**：高铁约1小时。')
    expect(markdown).toContain('[配图 · 西岁](https://www.xiaohongshu.com/explore/69ad4ff6000000002602ff78)　[配图 · 小周](https://www.xiaohongshu.com/explore/69ad4ff6000000002602ff79)')
    expect(markdown.endsWith('下一段')).toBe(true)
  })

  it('认不出笔记 id 的图片块直接去掉;没有作者名时写「原笔记」', () => {
    expect(prepareDotMarkdown(`前\n${IMAGE(1, 'not-a-note', 'x')}\n后`)).toBe('前\n\n后')
    expect(prepareDotMarkdown(IMAGE(1, '69ad4ff6000000002602ff78', ''))).toBe('[配图 · 原笔记](https://www.xiaohongshu.com/explore/69ad4ff6000000002602ff78)')
  })

  it('流式输出到一半:没收全的图片块和半截标签先不显示', () => {
    expect(prepareDotMarkdown('正文\n\n<div class="ai-msg-image-item" data-index="1">\n  <img\n    src="http://sns')).toBe('正文')
    expect(prepareDotMarkdown('正文<di')).toBe('正文')
  })

  it('普通回答原样保留', () => {
    const plain = '#### 标题\n\n- ​**​画中画​**​：层级关系\n- 关键帧'
    expect(prepareDotMarkdown(plain)).toBe(plain)
  })
})
