import type { VkRuntimeCandidate } from '../../host/vkClient'

/**
 * 「哪个解析环境更强」的判定 —— 用来替用户自动选,而不是把两个环境摆出来让他挑。
 *
 * 用户看到过两个都标着 api 1.4.0 / schema 1.1.0 的环境,合理地以为"都能用、
 * 那为什么还要我选"。事实是它们**不等价**:爪爪自带的基础版刻意不装重依赖,
 * 于是 visual_evidence 是 missing_dependency;开发机上的 venv 装了 rapidocr,
 * 所以能做烧录字幕识别。差别真实存在,但那是机器该自己判断的事。
 *
 * 判定只看一件事:**有多少能力真的 ready**。不比版本号 —— 兼容性已经由
 * `compatible` 表达过了,再按版本排序等于把同一个维度算两遍。
 */

/** 一个候选环境里真正可用的能力数。 */
export function readyCount(candidate: VkRuntimeCandidate): number {
  return candidate.capabilities.filter((cap) => cap.runtime === 'ready').length
}

/**
 * 选出该用哪个。返回 null 表示没有可用候选(调用方据此保持现状,而不是乱换)。
 *
 * 平局时**留在当前环境**:能力一样就没有换的理由,而每次切换都要重启 sidecar。
 * 这条不只是省事——没有它,两个等强的环境会在每次检测后来回翻,状态永远不稳。
 * 仍然平局(且当前那个不在候选里)则偏向 app-owned:那是爪爪能自己重建的环境,
 * 出问题时用户有得救。
 */
export function pickBestRuntime(candidates: readonly VkRuntimeCandidate[]): VkRuntimeCandidate | null {
  const usable = candidates.filter((candidate) => candidate.compatible)
  if (usable.length === 0) return null

  let best = usable[0]
  for (const candidate of usable.slice(1)) {
    const delta = readyCount(candidate) - readyCount(best)
    if (delta > 0) { best = candidate; continue }
    if (delta < 0) continue
    // —— 以下都是平局拆解,顺序即优先级 ——
    if (candidate.active && !best.active) { best = candidate; continue }
    if (best.active) continue
    if (candidate.source === 'app-owned' && best.source !== 'app-owned') best = candidate
  }
  return best
}

/**
 * 需要切换吗?已经在最强的那个上就返回 null —— 调用方据此**什么都不做**,
 * 不产生一次无谓的 adopt(每次 adopt 都会重启 sidecar)。
 */
export function runtimeToAdopt(candidates: readonly VkRuntimeCandidate[]): VkRuntimeCandidate | null {
  const best = pickBestRuntime(candidates)
  if (!best || best.active) return null
  return best
}

/**
 * 给用户看的一句话。**只在有话可说时才说** —— 一切正常就返回 null,由调用方
 * 渲染成单行「就绪」,不拿"你什么都不用管"的信息占据版面。
 */
export function missingCapabilityNote(candidate: VkRuntimeCandidate | null): string | null {
  if (!candidate) return null
  const missing = candidate.capabilities.filter((cap) => cap.runtime !== 'ready')
  if (missing.length === 0) return null
  const names: Record<string, string> = {
    word_timestamps: '逐词时间轴',
    speaker_diarization: '说话人分离',
    visual_evidence: '画面文字识别',
    search_document: '文档检索',
    query_ready: '问答',
  }
  return `暂不支持：${missing.map((cap) => names[cap.capability] ?? cap.capability).join('、')}`
}
