import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listNoteFigureNames } from './NoteFigure'
import { splitScreenshotBlocks } from './screenshotBlocks'

describe('listNoteFigureNames', () => {
  it('配图引用按出现顺序、去重', () => {
    expect(listNoteFigureNames('![甲](figures/aaaaaaaaaaaa.jpg)\n\n![乙](figures/bbbbbbbbbbbb.jpg)\n\n![甲](figures/aaaaaaaaaaaa.jpg)'))
      .toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb'])
  })

  it('也收进 ::screenshot 块里的 src,和普通配图混排时保持笔记里的先后', () => {
    const markdown = [
      '![前](figures/aaaaaaaaaaaa.jpg)',
      '',
      '::screenshot{src="figures/bbbbbbbbbbbb.jpg" alt="图3" viewport="1080x1440"}',
      ':::annotation{x=1 y=1 w=1 h=1}',
      '批注',
      ':::',
      '::',
      '',
      '![后](figures/cccccccccccc.jpg)',
      '',
      '::screenshot{alt="图4" src="figures/aaaaaaaaaaaa.jpg"}',
      '::',
    ].join('\n')
    expect(listNoteFigureNames(markdown)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'])
  })

  it('不是 figures/<12 位十六进制>.jpg 的 src 和批注行里的 src 不收', () => {
    const markdown = '::screenshot{src="https://example.com/a.jpg"}\n:::annotation{src="figures/aaaaaaaaaaaa.jpg"}\n::\n::screenshot{src="figures/short.jpg"}\n::\n'
    expect(listNoteFigureNames(markdown)).toEqual([])
  })

  it('样例笔记里的配图和批注原图都进图集', () => {
    const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'annotated-note.md'), 'utf8')
    expect(listNoteFigureNames(fixture)).toEqual(['0123456789ab', '3fa9c1d2e4b5', 'a1b2c3d4e5f6'])
    expect(splitScreenshotBlocks(fixture).filter((segment) => segment.kind === 'screenshot')).toHaveLength(2)
  })
})
