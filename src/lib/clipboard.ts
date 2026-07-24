// 降级次序:navigator.clipboard.writeText 缺失或 reject 后才走 textarea+execCommand;两路皆败返 false
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* writeText reject → 落 fallback */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    try {
      ta.select()
      return document.execCommand('copy')
    } finally {
      ta.remove()   // select/execCommand 抛错也必须清掉含敏感内容的节点(三轮复审 F3)
    }
  } catch {
    return false
  }
}
