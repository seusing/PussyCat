import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../store/appStore'
import { describeVkFailure, type VkFailureKind } from './vkFailure'

const initialState = useAppStore.getState()
beforeEach(() => useAppStore.setState(initialState, true))

const TAIL = '（阶段 chapter，角色 basic，路由 channel-a:default，模型 gpt-5.6-luna，接口 /v1/responses，已尝试 1 次；同角色未配置备用通道；不会跨角色自动切换）'
const NO_BILLING_RETRY = '；上游可能仍在运行和计费；为避免重复消费不自动重试'
const NO_FALLBACK_HINT = '这个角色现在没有备用通道'

// 真实任务里的失败原文(中转站地址与通道名已脱敏)。
const EXPIRED_TOKEN = "channel-a:default HTTP 401: {'error': {'code': '401', 'message': '令牌已过期或验证不正确'}}"
const BARE_502 = 'channel-a:default HTTP 502'
const ROUTED_502 = 'channel-a:default HTTP 502（阶段 chapter，角色 basic，路由 channel-a:default，模型 gpt-5.6-luna，接口 /v1/responses，已尝试 4 次；同角色未配置备用通道；不会跨角色自动切换）'
const DOWNLOAD_FAILED = 'media_acquisition_failed: download attempt failed (DownloadError)'
const TOS_REFUSED = 'channel-a:default HTTP 403: {"error":{"message":"The request is prohibited due to a violation of provider Terms Of Service.","code":403,"metadata":{"provider_name":null,"previous_errors":[{"code":403,"message":"The request is prohibited due to a violation of provider Terms Of Service."},{"code":403,"message":"The request is prohibited due to a violation of provider Terms Of Service."}]}},"user_id":"user_redacted"}'
const SHARED_DEADLINE = 'gateway shared deadline exceeded'
const READ_TIMEOUT_WITH_SECONDS = "HTTPSConnectionPool(host='relay.example.com', port=443): Read timed out. (read timeout=120.0)（阶段 chapter，角色 basic，路由 channel-a:default，模型 gpt-5.6-terra，接口 /v1/responses，已尝试 2 次；同角色未配置备用通道；不会跨角色自动切换）"
const READ_TIMEOUT_NO_SECONDS = `HTTPSConnectionPool(host='relay.example.com', port=443): Read timed out.${TAIL}${NO_BILLING_RETRY}`
const ROUTED_429 = 'channel-a:default HTTP 429（阶段 chapter，角色 basic，路由 channel-a:default，模型 gpt-5.6-luna，接口 /v1/responses，已尝试 2 次；同角色未配置备用通道；不会跨角色自动切换）'
const STREAM_TOTAL_TIMEOUT = `stream total timeout${TAIL}${NO_BILLING_RETRY}`
const STREAM_TIMEOUT_HIGH_EFFORT = `stream total timeout（上游持续推流但始终没有正文：已收 177 个事件，最后事件 response.reasoning_summary_text.delta，首个推理事件在 4625ms；通常是推理档过高，降低 reasoning effort 可解）${TAIL}${NO_BILLING_RETRY}`
const STREAM_CEILING = `stream ceiling exceeded${TAIL}${NO_BILLING_RETRY}`
const NOT_A_LINK = '本地源不存在: <非链接文本>'

const REAL_SAMPLES: Array<[string, string, VkFailureKind]> = [
  ['令牌过期', EXPIRED_TOKEN, 'auth'],
  ['502 无上下文', BARE_502, 'relay-error'],
  ['502 带路由信息', ROUTED_502, 'relay-error'],
  ['下载失败', DOWNLOAD_FAILED, 'download'],
  ['内容被拒', TOS_REFUSED, 'refused'],
  ['共享截止时间', SHARED_DEADLINE, 'timeout'],
  ['读超时(带秒数)', READ_TIMEOUT_WITH_SECONDS, 'timeout'],
  ['读超时(不带秒数)', READ_TIMEOUT_NO_SECONDS, 'timeout'],
  ['限流', ROUTED_429, 'rate-limit'],
  ['流式总超时', STREAM_TOTAL_TIMEOUT, 'timeout'],
  ['流式总超时(推理档过高)', STREAM_TIMEOUT_HIGH_EFFORT, 'timeout'],
  ['思考超限', STREAM_CEILING, 'ceiling'],
  ['不是链接', NOT_A_LINK, 'bad-source'],
]

// 引擎源码里的固定文案(acquisition/coordinator.py、models/gateway.py)。
const XHS_LOGIN_REQUIRED = 'media_acquisition_failed: 小红书需要登录才能读取这条笔记：请打开已登录小红书的 Chrome（爪爪浏览器扩展需已连接）后重试'
const EMPTY_NO_TOKENS = '模型在 2.0 分钟后返回了空内容（阶段 chapter，角色 basic，路由 channel-a:default，模型 gpt-5.6-luna，接口 /v1/responses，已尝试 1 次；同角色未配置备用通道；不会跨角色自动切换）'
const EMPTY_AFTER_REASONING = '模型在 3.5 分钟后没有返回可见内容（已消耗 4096 个输出 token）（阶段 note，角色 deep_analysis，路由 channel-b:default，模型 gpt-6-sol，接口 /v1/responses，已尝试 1 次；将继续尝试同角色的备用通道）。当前推理强度为 high，基础处理类步骤（章节划分、快速理解等）建议在「模型配置」里调低到 medium'

describe('describeVkFailure 归类', () => {
  it.each(REAL_SAMPLES)('真实样本:%s', (_name, raw, kind) => {
    expect(describeVkFailure(raw).kind).toBe(kind)
  })

  it('小红书需登录的提示不会被当成普通下载失败', () => {
    const failure = describeVkFailure(XHS_LOGIN_REQUIRED)
    expect(failure.kind).toBe('login-required')
    expect(failure.headline).toBe('需要登录小红书才能读取这条笔记')
    expect(failure.advice).toBe('打开已登录小红书的 Chrome（扩展需已连接）后重试')
    expect(failure.action).toBeUndefined()
  })

  it.each([
    ['无 token 消耗', EMPTY_NO_TOKENS],
    ['推理耗尽无正文', EMPTY_AFTER_REASONING],
  ])('空回复:%s', (_name, raw) => {
    const failure = describeVkFailure(raw)
    expect(failure).toEqual({
      kind: 'empty',
      headline: '模型返回了空内容',
      advice: '重试；反复出现就换模型或调低推理强度',
    })
  })

  it('认不出的原文走兜底,空串也不抛', () => {
    const expected = { kind: 'unknown', headline: '解析失败', advice: '可以查看原始信息或重试' }
    expect(describeVkFailure('pipeline blew up in stage note')).toEqual(expected)
    expect(describeVkFailure('')).toEqual(expected)
  })
})

describe('describeVkFailure 文案与动作', () => {
  it('认证失败:提示更新 key,带去模型配置', () => {
    const failure = describeVkFailure(EXPIRED_TOKEN)
    expect(failure.headline).toBe('模型服务的 API key 无效或已过期')
    expect(failure.advice).toBe('去模型配置更新这个通道的 key')
    expect(failure.action?.label).toBe('去模型配置')
    expect(describeVkFailure('upstream said: Invalid API key provided').kind).toBe('auth')
  })

  it('403 只有含 Terms Of Service 或 prohibited 才算内容被拒', () => {
    expect(describeVkFailure('channel-a:default HTTP 403: content prohibited by policy').kind).toBe('refused')
    expect(describeVkFailure('channel-a:default HTTP 403: forbidden').kind).toBe('unknown')
    const refused = describeVkFailure(TOS_REFUSED)
    expect(refused.headline).toBe('模型服务拒绝处理这段内容')
    expect(refused.advice).toBe('换一个模型或通道后重试')
    expect(refused.action?.label).toBe('去模型配置')
  })

  it('限流与中转站故障:原文没有备用通道信息时只给通用建议,不带动作', () => {
    expect(describeVkFailure('channel-a:default HTTP 429')).toEqual({
      kind: 'rate-limit',
      headline: '模型服务限流了',
      advice: '稍后重试，或给这个角色配一个备用通道',
    })
    expect(describeVkFailure(BARE_502)).toEqual({
      kind: 'relay-error',
      headline: '模型服务（中转站）暂时故障',
      advice: '稍后重试，或配一个备用通道，主通道失败时会自动切换',
    })
  })

  it('同角色未配置备用通道:限流、中转站故障、超时追加配置备用通道的建议并带入口', () => {
    for (const raw of [ROUTED_429, ROUTED_502, READ_TIMEOUT_WITH_SECONDS, STREAM_TOTAL_TIMEOUT]) {
      const failure = describeVkFailure(raw)
      expect(failure.advice).toContain(NO_FALLBACK_HINT)
      expect(failure.action?.label).toBe('去模型配置')
    }
  })

  it('其他类别即使原文带「同角色未配置备用通道」也不追加', () => {
    expect(describeVkFailure(EMPTY_NO_TOKENS).advice).not.toContain(NO_FALLBACK_HINT)
    expect(describeVkFailure(STREAM_CEILING).advice).toBe('把推理强度调低后重试')
  })

  it('原文说明还有备用通道时,不追加配置建议', () => {
    const raw = 'channel-a:default HTTP 429（阶段 chapter，角色 basic，路由 channel-a:default，已尝试 2 次；将继续尝试同角色的备用通道）'
    const failure = describeVkFailure(raw)
    expect(failure.kind).toBe('rate-limit')
    expect(failure.advice).not.toContain(NO_FALLBACK_HINT)
    expect(failure.action).toBeUndefined()
  })

  it('超时:默认建议调低推理强度或配备用通道;原文含「推理档过高」时优先调低推理强度', () => {
    const plain = describeVkFailure(SHARED_DEADLINE)
    expect(plain.headline).toBe('模型服务响应太慢，超时了')
    expect(plain.advice).toBe('把推理强度调低（一般用 medium），或配一个备用通道后重试')
    expect(plain.action?.label).toBe('去模型配置')

    const high = describeVkFailure(STREAM_TIMEOUT_HIGH_EFFORT)
    expect(high.advice.startsWith('先在模型配置里把推理强度调低')).toBe(true)
    expect(high.advice).toContain('仍然超时，再配一个备用通道')
  })

  it('引擎附带的推理强度提示同样优先建议调低推理强度', () => {
    const raw = 'Read timed out。当前推理强度为 xhigh，基础处理类步骤（章节划分、快速理解等）建议在「模型配置」里调低到 medium'
    expect(describeVkFailure(raw).advice.startsWith('先在模型配置里把推理强度调低')).toBe(true)
  })

  it('思考超限:建议调低推理强度', () => {
    const failure = describeVkFailure(STREAM_CEILING)
    expect(failure.headline).toBe('模型思考时间太长，超过上限')
    expect(failure.advice).toBe('把推理强度调低后重试')
  })

  it('下载失败与无效来源没有动作按钮', () => {
    expect(describeVkFailure(DOWNLOAD_FAILED)).toEqual({
      kind: 'download',
      headline: '视频下载失败',
      advice: '先确认链接能在浏览器里打开；小红书笔记可能需要已登录的浏览器',
    })
    expect(describeVkFailure(NOT_A_LINK)).toEqual({
      kind: 'bad-source',
      headline: '这一行不是有效的视频链接或文件',
      advice: '检查输入内容',
    })
  })

  it('「去模型配置」把应用切到模型配置模块', () => {
    useAppStore.getState().setActiveModule('vk')
    describeVkFailure(EXPIRED_TOKEN).action!.run()
    expect(useAppStore.getState().activeModule).toBe('providers')
  })
})
