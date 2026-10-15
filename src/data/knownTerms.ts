// 笔记术语提示里「我已了解」的术语集合。独立 key 的纯 UI 偏好,与 preferences.ts(执行确认/收藏,
// 受 I-P7 不落盘约束管辖)无关,也不进 LayoutSnapshot。
export const KNOWN_TERMS_KEY = 'opencli-app:known-terms:v1'
export const KNOWN_TERMS_MAX = 500

/** 术语比对用的统一写法:NFKC 规范化、去首尾空白、拉丁字母转小写。 */
export function normalizeTerm(term: string): string {
  return term.normalize('NFKC').trim().toLowerCase()
}

function resolveStorage(storage?: Storage): Storage | undefined {
  if (storage) return storage
  try {
    // 浏览器封锁存储时,访问 localStorage 属性本身会抛 SecurityError(同 layout.ts 的既有处理)
    return typeof localStorage !== 'undefined' ? localStorage : undefined
  } catch {
    return undefined
  }
}

function readTerms(storage: Storage | undefined): string[] {
  const raw = storage?.getItem(KNOWN_TERMS_KEY)
  if (!raw) return []
  const parsed: unknown = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
}

export function loadKnownTerms(storage?: Storage): Set<string> {
  try {
    return new Set(readTerms(resolveStorage(storage)))
  } catch {
    return new Set()
  }
}

/** 记下一个「已了解」的术语,只保留最新的 KNOWN_TERMS_MAX 个。返回是否写入成功。 */
export function addKnownTerm(term: string, storage?: Storage): boolean {
  const s = resolveStorage(storage)
  const normalized = normalizeTerm(term)
  if (!s || !normalized) return false
  try {
    const terms = readTerms(s).filter((item) => item !== normalized)
    terms.push(normalized)
    s.setItem(KNOWN_TERMS_KEY, JSON.stringify(terms.slice(-KNOWN_TERMS_MAX)))
    return true
  } catch {
    return false   // 配额满 / 隐私模式:本次会话内存态仍有效
  }
}
