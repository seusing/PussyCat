// 把带 ::screenshot 批注的 Markdown 渲染成净化后的 HTML(comark-annotate)。
// 渲染器只在第一次用到时构造;comark 这一整套随本模块一起按需加载。
import { createHtmlRenderer } from '@comark/html'
import security from 'comark/plugins/security'
import annotate, { components } from 'comark-annotate/html'
import DOMPurify from 'dompurify'

// 批注文字来自模型输出:Comark 的 security 先去掉危险标签和事件属性,DOMPurify 再过一遍最终 HTML。
// comark-annotate 输出里的标签(div/span/figure/ol/img/svg/path 等)、属性(class、style、role、
// aria-*、data-n、viewBox、d、vector-effect 等)都在 html + svg 档案里;它输出里自带的 style 和复制按钮
// (按钮要靠被净化掉的脚本才显示)用不上,连同表单控件一起去掉。
const BLOCKED_TAGS = ['script', 'style', 'iframe', 'object', 'embed']
const SANITIZE = {
  USE_PROFILES: { html: true, svg: true },
  FORBID_TAGS: ['style', 'button', 'form', 'input', 'textarea', 'select'],
}

// comark-annotate 没有独立的 CSS 文件,样式随每份 HTML 输出内联成 <style>(内容固定,与笔记无关)。
// 净化会去掉这些 <style>,所以用一份固定的样张取出样式,整个应用只注入一次。
const SAMPLE = '::screenshot{src="figures/000000000000.jpg" alt="" viewport="1x1"}\n:::annotation{x=0 y=0 w=1 h=1}\n.\n:::\n::\n'
const STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/g

async function createRenderer(): Promise<(markdown: string) => Promise<string>> {
  const render = createHtmlRenderer({
    plugins: [annotate({ size: false }), security({ blockedTags: BLOCKED_TAGS })],
    components,
  })
  const style = document.createElement('style')
  style.dataset.vkAnnotate = ''
  style.textContent = [...(await render(SAMPLE)).matchAll(STYLE_BLOCK)].map((match) => match[1]).join('\n')
  document.head.append(style)
  return async (markdown) => {
    const fragment = DOMPurify.sanitize(await render(markdown), { ...SANITIZE, RETURN_DOM_FRAGMENT: true })
    // DOMPurify 去掉 <button> 时保留其内容:复制按钮里的图标 svg 会留在 .ca-frame 里成为块级元素,
    // 把框撑高,而批注按框的百分比定位,于是整体下移错位。按钮的残件一并删掉。
    fragment.querySelectorAll(COPY_BUTTON_PARTS).forEach((node) => node.remove())
    const holder = document.createElement('div')
    holder.append(fragment)
    return holder.innerHTML
  }
}

const COPY_BUTTON_PARTS = '[class*="ca-copy"]'

let renderer: ReturnType<typeof createRenderer> | null = null

/** 渲染一个 ::screenshot 块,返回可直接插入页面的 HTML。src 要先换成 data URL(应用 CSP 不放行其他图片来源)。 */
export function renderAnnotated(markdown: string): Promise<string> {
  renderer ??= createRenderer()
  return renderer.then((render) => render(markdown))
}
