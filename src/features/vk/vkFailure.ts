// 把引擎存下来的失败原文(任务 error、阶段 metric.error)翻成「一句人话 + 怎么办」。
// 识别依据都是引擎真实输出的固定片段;认不出的归为兜底,原文始终由界面收在「原始信息」里。
import { useAppStore } from '../../store/appStore'

export type VkFailureKind =
  | 'auth'
  | 'refused'
  | 'rate-limit'
  | 'relay-error'
  | 'timeout'
  | 'ceiling'
  | 'empty'
  | 'download'
  | 'login-required'
  | 'bad-source'
  | 'unknown'

export type VkFailure = {
  kind: VkFailureKind
  headline: string
  advice: string
  action?: { label: string; run: () => void }
}

const NO_FALLBACK_MARK = '同角色未配置备用通道'
const NO_FALLBACK_ADVICE = '这个角色现在没有备用通道，去模型配置添加后启用「备用通道」即可自动切换'
const HIGH_EFFORT_MARK = /推理档过高|当前推理强度为/

function goToProviders(): NonNullable<VkFailure['action']> {
  return { label: '去模型配置', run: () => useAppStore.getState().setActiveModule('providers') }
}

/** 限流、中转站故障、超时:原文说明该角色没有备用通道时,追加配置备用通道的建议与入口。 */
function withFallbackAdvice(raw: string, failure: Omit<VkFailure, 'action'>): VkFailure {
  if (!raw.includes(NO_FALLBACK_MARK)) return failure
  return { ...failure, advice: `${failure.advice}。${NO_FALLBACK_ADVICE}`, action: goToProviders() }
}

export function describeVkFailure(raw: string): VkFailure {
  if (/需要登录才能读取/.test(raw)) {
    return {
      kind: 'login-required',
      headline: '需要登录小红书才能读取这条笔记',
      advice: '打开已登录小红书的 Chrome（扩展需已连接）后重试',
    }
  }
  if (/本地源不存在/.test(raw)) {
    return {
      kind: 'bad-source',
      headline: '这一行不是有效的视频链接或文件',
      advice: '检查输入内容',
    }
  }
  if (/\bHTTP 401\b|令牌已过期|invalid[_ ]api[_ ]key/i.test(raw)) {
    return {
      kind: 'auth',
      headline: '模型服务的 API key 无效或已过期',
      advice: '去模型配置更新这个通道的 key',
      action: goToProviders(),
    }
  }
  if (/\bHTTP 403\b/.test(raw) && /terms of service|prohibited/i.test(raw)) {
    return {
      kind: 'refused',
      headline: '模型服务拒绝处理这段内容',
      advice: '换一个模型或通道后重试',
      action: goToProviders(),
    }
  }
  if (/\bHTTP 429\b/.test(raw)) {
    return withFallbackAdvice(raw, {
      kind: 'rate-limit',
      headline: '模型服务限流了',
      advice: '稍后重试，或给这个角色配一个备用通道',
    })
  }
  if (/\bHTTP 5\d\d\b/.test(raw)) {
    return withFallbackAdvice(raw, {
      kind: 'relay-error',
      headline: '模型服务（中转站）暂时故障',
      advice: '稍后重试，或配一个备用通道，主通道失败时会自动切换',
    })
  }
  if (/stream ceiling exceeded/i.test(raw)) {
    return {
      kind: 'ceiling',
      headline: '模型思考时间太长，超过上限',
      advice: '把推理强度调低后重试',
      action: goToProviders(),
    }
  }
  if (/Read timed out|stream total timeout|gateway shared deadline exceeded/i.test(raw)) {
    const advice = HIGH_EFFORT_MARK.test(raw)
      ? '先在模型配置里把推理强度调低（一般用 medium）再重试；仍然超时，再配一个备用通道'
      : '把推理强度调低（一般用 medium），或配一个备用通道后重试'
    // 调推理强度也在模型配置里,超时一律给入口。
    return { ...withFallbackAdvice(raw, { kind: 'timeout', headline: '模型服务响应太慢，超时了', advice }), action: goToProviders() }
  }
  if (/返回了空内容|没有返回可见内容/.test(raw)) {
    return {
      kind: 'empty',
      headline: '模型返回了空内容',
      advice: '重试；反复出现就换模型或调低推理强度',
    }
  }
  if (/media_acquisition_failed|DownloadError/.test(raw)) {
    return {
      kind: 'download',
      headline: '视频下载失败',
      advice: '先确认链接能在浏览器里打开；小红书笔记可能需要已登录的浏览器',
    }
  }
  return {
    kind: 'unknown',
    headline: '解析失败',
    advice: '可以查看原始信息或重试',
  }
}
