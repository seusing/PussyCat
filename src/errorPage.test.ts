// @vitest-environment node
//
// 启动失败引导页(src-tauri/error.html)的**执行**测试。
//
// 为什么必须真跑:此前这一页只有 Rust 侧的子串断言(`ERROR_PAGE_HTML.contains("'node-missing':")`),
// 那守的是"源码里有这个字面量",守不住"渲染出来是对的"。而这六条路径在真机上一条都没被走过
// (T9 的 Node 缺失引导页仍待补),等于整块失败展示从没被执行过。
// 这里用 jsdom 以 runScripts 真执行页面脚本,补上 DOM 那一半;剩下的一半(自定义 scheme 通道
// 在打包形态下是否接得上)只能靠真机验证,不在本文件射程内。
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

const html = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src-tauri/error.html'),
  'utf8',
)

function render(query: Record<string, string>) {
  const search = new URLSearchParams(query).toString()
  const dom = new JSDOM(html, {
    url: `https://localhost/index.html?${search}`,
    runScripts: 'dangerously',
  })
  const doc = dom.window.document
  const text = (id: string) => doc.getElementById(id)?.textContent ?? null
  return {
    doc,
    kind: text('kind'),
    title: text('title'),
    summary: text('summary'),
    hint: text('hint'),
    detail: text('detail'),
    logDir: text('log-dir'),
    detailHidden: (doc.getElementById('detail') as HTMLElement | null)?.hidden,
    logLineHidden: (doc.getElementById('log-line') as HTMLElement | null)?.hidden,
    documentTitle: doc.title,
  }
}

// 与 Rust 侧 HostStartError::kind() 一一对应。少一条 = 那条失败路径白屏。
const KINDS: Array<[string, string]> = [
  ['node-missing', '未找到可用的 Node 运行时'],
  ['node-too-old', 'Node 版本过低'],
  ['host-reported-failure', 'Host 报告启动失败'],
  ['readiness-timeout', 'Host 启动超时'],
  ['process-failed', 'Host 异常退出'],
  ['supervision-unavailable', '无法安全托管 Host，已拒绝启动'],
]

describe('启动失败引导页', () => {
  it.each(KINDS)('%s 渲染出对应标题与非空指引', (kind, expectedTitle) => {
    const view = render({ kind, summary: 'S' })
    expect(view.title).toBe(expectedTitle)
    expect(view.kind).toBe(kind)
    expect(view.summary).toBe('S')
    // 指引是这页存在的理由:只有标题没有指引,用户照样不知道该干什么。
    expect((view.hint ?? '').length).toBeGreaterThan(20)
    expect(view.documentTitle).toContain(expectedTitle)
  })

  it('未登记的分类走兜底视图,而不是白屏', () => {
    const view = render({ kind: 'something-new', summary: 'S' })
    expect(view.title).toBe('启动失败')
    // 兜底时仍要把原始分类显示出来,否则用户反馈不上来是哪一类。
    expect(view.kind).toBe('something-new')
    expect((view.hint ?? '').length).toBeGreaterThan(20)
  })

  it('完全没有 kind 参数时也有页面可看', () => {
    const view = render({})
    expect(view.title).toBe('启动失败')
    expect(view.kind).toBe('(未提供分类)')
  })

  it('原型链上的键不会翻出假视图', () => {
    // VIEWS['constructor'] 在没有 hasOwnProperty 守卫时会取到 Object 构造函数,
    // 于是 view.title 变成 undefined —— 页面显示空标题。
    for (const evil of ['constructor', '__proto__', 'toString']) {
      const view = render({ kind: evil })
      expect(view.title).toBe('启动失败')
    }
  })

  it('detail 与 logDir 缺省时保持隐藏,给了才显示', () => {
    const bare = render({ kind: 'process-failed', summary: 'S' })
    expect(bare.detailHidden).toBe(true)
    expect(bare.logLineHidden).toBe(true)

    const full = render({
      kind: 'process-failed',
      summary: 'S',
      detail: 'stderr 尾巴',
      logDir: 'C:\\logs',
    })
    expect(full.detailHidden).toBe(false)
    expect(full.logLineHidden).toBe(false)
    expect(full.detail).toBe('stderr 尾巴')
    expect(full.logDir).toBe('C:\\logs')
  })

  it('summary/detail 按文本写入,不当 HTML 解释', () => {
    // 这些字段来自 Host 的 stderr —— 内容不受我们控制,必须走 textContent。
    const payload = '<img src=x onerror="globalThis.__pwned = 1">'
    const view = render({ kind: 'process-failed', summary: payload, detail: payload })
    expect(view.summary).toBe(payload)
    expect(view.doc.querySelector('img')).toBeNull()
  })
})
