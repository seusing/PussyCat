import { postVkAsrPrepare } from '../../host/vkClient'

// 语音模型预加载:每次应用会话只触发一次(模块级标志,面板重进不重复),发出去就不管,失败静默——
// 没预加载成功时,第一条视频照常自己加载模型。
let requested = false

export function requestAsrPrepareOnce(baseUrl?: string): void {
  if (requested) return
  requested = true
  void postVkAsrPrepare(baseUrl).catch(() => {})
}
