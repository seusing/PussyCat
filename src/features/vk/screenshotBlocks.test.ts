import { foldScreenshotBlocks, readScreenshotBlock, SCREENSHOT_FIGURE_SRC, splitScreenshotBlocks } from './screenshotBlocks'

const BLOCK_A = [
  '::screenshot{src="figures/3fa9c1d2e4b5.jpg" alt="图3" viewport="1080x1440"}',
  ':::annotation{x=6.5 y=20.5 w=72.2 h=5.3 mark="underline" color="red"}',
  '投入 18 万 → 24.6 万，浮盈约 37%',
  ':::',
  ':::annotation{x=6.5 y=30.9 w=73.1 h=5.4 mark="circle" color="red" side="right"}',
  '年化 10.2% 含分红再投入',
  ':::',
  '::',
  '',
].join('\n')
const BLOCK_B = '::screenshot{src="figures/a1b2c3d4e5f6.jpg" alt="图4"}\n:::annotation{x=1 y=1 w=1 h=1}\n短句\n:::\n::\n'

describe('splitScreenshotBlocks', () => {
  it('一个块前后各有普通段:按顺序切成三段,块内的 :::annotation 原样保留', () => {
    const markdown = `# 标题\n\n正文\n\n${BLOCK_A}\n结尾\n`
    const segments = splitScreenshotBlocks(markdown)
    expect(segments).toEqual([
      { kind: 'markdown', text: '# 标题\n\n正文\n\n' },
      { kind: 'screenshot', text: BLOCK_A },
      { kind: 'markdown', text: '\n结尾\n' },
    ])
    expect(segments[1].text).toContain(':::annotation{x=6.5 y=20.5 w=72.2 h=5.3 mark="underline" color="red"}\n投入 18 万 → 24.6 万，浮盈约 37%\n:::')
    expect(segments.map((segment) => segment.text).join('')).toBe(markdown)
  })

  it('多个块和普通段交错时顺序不变,首尾是块也不产生空段', () => {
    const markdown = `${BLOCK_A}第二节\n\n${BLOCK_B}- 列表\n${BLOCK_A}`
    const segments = splitScreenshotBlocks(markdown)
    expect(segments.map((segment) => segment.kind)).toEqual(['screenshot', 'markdown', 'screenshot', 'markdown', 'screenshot'])
    expect(segments[1].text).toBe('第二节\n\n')
    expect(segments[2].text).toBe(BLOCK_B)
    expect(segments[3].text).toBe('- 列表\n')
    expect(segments.map((segment) => segment.text).join('')).toBe(markdown)
  })

  it('没有块的文档原样返回一个普通段', () => {
    const markdown = '# 标题\n\n![图1](figures/0123456789ab.jpg)\n\n:::annotation{x=1 y=1 w=1 h=1}\n孤立的批注\n:::\n'
    expect(splitScreenshotBlocks(markdown)).toEqual([{ kind: 'markdown', text: markdown }])
    expect(splitScreenshotBlocks('')).toEqual([{ kind: 'markdown', text: '' }])
  })

  it('没有收尾的块当普通文本', () => {
    const markdown = '前文\n::screenshot{src="figures/3fa9c1d2e4b5.jpg" alt="图3"}\n:::annotation{x=1 y=1 w=1 h=1}\n没写完\n:::\n'
    expect(splitScreenshotBlocks(markdown)).toEqual([{ kind: 'markdown', text: markdown }])
  })

  it('前一个块没收尾、后一个块完整:只认后一个', () => {
    const open = '::screenshot{src="figures/3fa9c1d2e4b5.jpg" alt="图3"}\n:::annotation{x=1 y=1 w=1 h=1}\n没写完\n:::\n'
    const segments = splitScreenshotBlocks(`${open}${BLOCK_B}`)
    expect(segments).toEqual([
      { kind: 'markdown', text: open },
      { kind: 'screenshot', text: BLOCK_B },
    ])
  })

  it('代码块里的块当普通文本,代码块之后的块照常识别', () => {
    const fenced = `\`\`\`md\n${BLOCK_B}\`\`\`\n`
    const tilde = `~~~\n${BLOCK_B}~~~\n`
    const longer = `\`\`\`\`\n\`\`\`\n${BLOCK_B}\`\`\`\`\n`
    for (const code of [fenced, tilde, longer]) {
      expect(splitScreenshotBlocks(code)).toEqual([{ kind: 'markdown', text: code }])
      expect(splitScreenshotBlocks(`${code}${BLOCK_A}`)).toEqual([
        { kind: 'markdown', text: code },
        { kind: 'screenshot', text: BLOCK_A },
      ])
    }
  })

  it('没有闭合的代码块吞掉后面所有内容', () => {
    const markdown = `\`\`\`\n${BLOCK_B}`
    expect(splitScreenshotBlocks(markdown)).toEqual([{ kind: 'markdown', text: markdown }])
  })

  it('文末没有换行时最后一行也能收尾', () => {
    const markdown = '::screenshot{src="figures/3fa9c1d2e4b5.jpg" alt="图3"}\n:::annotation{x=1 y=1 w=1 h=1}\n短\n:::\n::'
    expect(splitScreenshotBlocks(markdown)).toEqual([{ kind: 'screenshot', text: markdown }])
  })

  it('不独占一行的 :: 和缩进的块开头不算', () => {
    const markdown = '::screenshot{src="figures/3fa9c1d2e4b5.jpg" alt="图3"}\n短\n:: 还有字\n'
    expect(splitScreenshotBlocks(markdown)).toEqual([{ kind: 'markdown', text: markdown }])
    const indented = `  ${BLOCK_B}`
    expect(splitScreenshotBlocks(indented)).toEqual([{ kind: 'markdown', text: indented }])
  })
})

describe('foldScreenshotBlocks', () => {
  it('每个块换成带下标的占位围栏,其余原样', () => {
    const { markdown, blocks } = foldScreenshotBlocks(`# 标题\n\n${BLOCK_A}中间\n\n${BLOCK_B}`)
    expect(blocks).toEqual([BLOCK_A, BLOCK_B])
    expect(markdown).toBe('# 标题\n\n```vk-screenshot\n0\n```\n中间\n\n```vk-screenshot\n1\n```\n')
  })

  it('没有块时原文不动', () => {
    const text = '# 标题\n\n正文\n'
    expect(foldScreenshotBlocks(text)).toEqual({ markdown: text, blocks: [] })
  })
})

describe('readScreenshotBlock', () => {
  it('读出 src、alt 和 viewport', () => {
    expect(readScreenshotBlock(BLOCK_A)).toEqual({
      src: 'figures/3fa9c1d2e4b5.jpg',
      alt: '图3',
      viewport: { width: 1080, height: 1440 },
    })
  })

  it('缺属性或 viewport 不合法时给空值', () => {
    expect(readScreenshotBlock('::screenshot{src="figures/3fa9c1d2e4b5.jpg"}\n::\n')).toEqual({
      src: 'figures/3fa9c1d2e4b5.jpg', alt: '', viewport: null,
    })
    expect(readScreenshotBlock('::screenshot{src="a" viewport="0x10"}\n::\n').viewport).toBeNull()
    expect(readScreenshotBlock('::screenshot{data-src="x" src="y"}\n::\n').src).toBe('y')
  })

  it('批注行里的同名属性不影响开头行', () => {
    expect(readScreenshotBlock('::screenshot{alt="图"}\n:::annotation{src="no" x=1}\n::\n').src).toBe('')
  })
})

describe('SCREENSHOT_FIGURE_SRC', () => {
  it('只认开头行里 figures/<12 位十六进制>.jpg 的 src,捕获前后以便替换', () => {
    const text = `${BLOCK_A}::screenshot{alt="x" src="figures/ffffffffffff.jpg"}\n::\n::screenshot{src="data:image/jpeg;base64,AAAA"}\n::\n::screenshot{src="figures/short.jpg"}\n::\n`
    const matches = [...text.matchAll(SCREENSHOT_FIGURE_SRC)].map((match) => match[2])
    expect(matches).toEqual(['3fa9c1d2e4b5', 'ffffffffffff'])
  })
})
