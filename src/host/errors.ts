// 跨层结构化错误:Host 实现抛它,App 的 normalizeHostError 原样透传 summary/detail
// (复审 F2:此前拼进 Error.message 导致服务端 detail 常显、JS stack 反被当 detail)
export class HostRequestError extends Error {
  readonly summary: string
  readonly detail?: string
  readonly status?: number
  constructor(summary: string, detail?: string, status?: number) {
    // message 恒等于 summary:不得把 detail 拼进 message,否则通用 Error.message 消费者
    // (日志/第三方)会把「按需详情」重新变成常显,正是本类要消除的缺陷(复审 P3)
    super(summary)
    this.name = 'HostRequestError'
    this.summary = summary
    this.detail = detail
    this.status = status
  }
}
