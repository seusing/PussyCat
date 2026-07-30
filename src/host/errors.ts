// 跨层结构化错误:Host 实现抛它,App 的 normalizeHostError 原样透传 summary/detail
// (复审 F2:此前拼进 Error.message 导致服务端 detail 常显、JS stack 反被当 detail)
export class HostRequestError extends Error {
  readonly summary: string
  readonly detail?: string
  readonly status?: number
  // wire 上的稳定标识(spec §6.1):前端业务逻辑(409/428 分派)只认它,不认 summary 自然语言文案
  // (server/host-server.mjs 的 catch 分支会把 error.reasonCode 序列化进响应体的 reasonCode 字段)。
  readonly reasonCode?: string
  constructor(summary: string, detail?: string, status?: number, reasonCode?: string) {
    // message 恒等于 summary:不得把 detail 拼进 message,否则通用 Error.message 消费者
    // (日志/第三方)会把「按需详情」重新变成常显,正是本类要消除的缺陷(复审 P3)
    super(summary)
    this.name = 'HostRequestError'
    this.summary = summary
    this.detail = detail
    this.status = status
    this.reasonCode = reasonCode
  }
}
