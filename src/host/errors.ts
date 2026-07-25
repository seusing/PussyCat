// 跨层结构化错误:Host 实现抛它,App 的 normalizeHostError 原样透传 summary/detail
// (复审 F2:此前拼进 Error.message 导致服务端 detail 常显、JS stack 反被当 detail)
export class HostRequestError extends Error {
  readonly summary: string
  readonly detail?: string
  readonly status?: number
  constructor(summary: string, detail?: string, status?: number) {
    super(detail ? `${summary}: ${detail}` : summary)   // message 仅为调试可读,消费方读 summary/detail
    this.name = 'HostRequestError'
    this.summary = summary
    this.detail = detail
    this.status = status
  }
}
