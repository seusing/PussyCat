// 把 codexradar 的三份原始数据算成界面要的那三张表。**纯函数,不碰网络**。
//
// 为什么要自己算:IQ / 费用 / 耗时这套数字站方**没有**现成的小接口 —— 页面是拉
// 2.9MB 的原始矩阵在浏览器里现算的(/api/intelligence-efficiency)。所以这里照它
// 的算法复现一遍,并且用站方自己发布的 /api/radar-insights 当对照物验过:21 个
// 格子逐项复现(见 radar-derive.test.mjs)。
//
// 算法出处是 codexradar.com 页面里的内联脚本,原文:
//   raw_combined_cost = average_price_usd * Math.pow(average_minutes / 10, W) * 100
//   combined_cost_index = raw_combined_cost / maxRawCost * 100
//   W = Math.log(2.5) / Math.log(1.35)
// IQ 则是 通过任务数 / 总任务数 * 150(用站方 6 个已公布格子反解并核对无误)。

/** 综合成本里耗时的权重指数。**照抄站方**,别自己调 —— 一改,x 轴就跟人家对不上了。 */
export const COMBINED_COST_WEIGHT = Math.log(2.5) / Math.log(1.35)
/** 满分刻度:全部任务都过 = 150。 */
export const IQ_FULL_SCALE = 150

/** 家族显示名与配色,顺序即界面从上到下的顺序(与站方一致)。 */
export const FAMILIES = [
  { model: 'gpt-5.6-sol', name: 'Sol', color: '#e3a008' },
  { model: 'gpt-5.6-terra', name: 'Terra', color: '#4f8cff' },
  { model: 'gpt-5.6-luna', name: 'Luna', color: '#c9d1d9' },
  { model: 'gpt-5.5', name: '5.5', color: '#2dd4bf' },
  { model: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', color: '#a78bfa' },
]

/** 档位从高到低 —— 界面按它对齐成列,同一档位在同一竖排上才好横向比。 */
export const TIERS = ['ultra', 'max', 'xhigh', 'high', 'medium', 'low']

export function familyOf(model) {
  return FAMILIES.find((f) => f.model === model)
    ?? { model, name: model, color: 'var(--color-fg-dim)' }
}

/**
 * 一个格子(某任务 × 某模型档位)取**最新一次评分**的那条运行。
 * 站方的 mode 叫 latest_valid_per_task,就是这个意思。
 */
function latestRun(cell) {
  if (!cell || !Array.isArray(cell.ran_by) || cell.ran_by.length === 0) return null
  let best = null
  for (const run of cell.ran_by) {
    if (!run) continue
    if (!best || String(run.graded_at ?? '') > String(best.graded_at ?? '')) best = run
  }
  return best
}

/**
 * 原始矩阵 + 次数统计 → 21 个格子。
 *
 * @param matrix  /api/intelligence-efficiency 的响应
 * @param metrics /api/intelligence-efficiency-metrics 的响应(只取 24 小时运行次数)
 */
export function deriveModels(matrix, metrics) {
  const tasks = Array.isArray(matrix?.tasks) ? matrix.tasks.map((t) => t?.id).filter(Boolean) : []
  const combos = Array.isArray(matrix?.combos) ? matrix.combos : []
  const cells = matrix?.cells ?? {}
  if (tasks.length === 0 || combos.length === 0) return []

  const runs24 = new Map()
  for (const point of Array.isArray(metrics?.points) ? metrics.points : []) {
    runs24.set(`${point?.model}|${point?.effort}`, Number(point?.runs_24h) || 0)
  }

  const rows = []
  for (const combo of combos) {
    const { model, effort } = combo ?? {}
    if (!model || !effort) continue
    let passed = 0
    let costSum = 0; let costN = 0
    let secSum = 0; let secN = 0
    for (const taskId of tasks) {
      const run = latestRun(cells[`${taskId}|${model}|${effort}`])
      if (!run) continue
      if (run.passed) passed += 1
      if (Number.isFinite(run.actual_cost_usd)) { costSum += run.actual_cost_usd; costN += 1 }
      if (Number.isFinite(run.duration_sec)) { secSum += run.duration_sec; secN += 1 }
    }
    const costUsd = costN > 0 ? costSum / costN : null
    const minutes = secN > 0 ? secSum / secN / 60 : null
    const family = familyOf(model)
    rows.push({
      id: `${model}|${effort}`,
      model,
      effort,
      family: family.name,
      color: family.color,
      label: `${family.name} ${effort}`,
      iq: Math.round((passed / tasks.length) * IQ_FULL_SCALE * 10) / 10,
      passed,
      samples: tasks.length,
      costUsd,
      minutes,
      runs24: runs24.get(`${model}|${effort}`) ?? 0,
      rawCombinedCost: costUsd > 0 && minutes > 0
        ? costUsd * (minutes / 10) ** COMBINED_COST_WEIGHT * 100
        : null,
    })
  }

  // combined_cost_index 是**相对值**:最贵的那个记 100,其余按比例 —— 图表 x 轴用它。
  const maxRaw = rows.reduce((m, r) => Math.max(m, r.rawCombinedCost ?? 0), 0)
  for (const row of rows) {
    row.cci = row.rawCombinedCost != null && maxRaw > 0
      ? (row.rawCombinedCost / maxRaw) * 100
      : null
  }
  return sortRows(rows)
}

function sortRows(rows) {
  const familyRank = new Map(FAMILIES.map((f, i) => [f.model, i]))
  const tierRank = new Map(TIERS.map((t, i) => [t, i]))
  return [...rows].sort((a, b) =>
    (familyRank.get(a.model) ?? 99) - (familyRank.get(b.model) ?? 99)
    || (tierRank.get(a.effort) ?? 99) - (tierRank.get(b.effort) ?? 99))
}

/** /api/radar-insights → 四张推荐卡。站方已经算好了,原样投影,不重算。 */
export function derivePicks(insights) {
  const list = Array.isArray(insights?.recommendations) ? insights.recommendations : []
  return list.map((rec) => ({
    key: String(rec?.key ?? ''),
    title: String(rec?.title ?? ''),
    rule: String(rec?.rule ?? ''),
    items: (Array.isArray(rec?.items) ? rec.items : []).map((item) => {
      const family = familyOf(item?.model)
      return {
        id: `${item?.model}|${item?.effort}`,
        label: `${family.name} ${item?.effort ?? ''}`.trim(),
        color: family.color,
        iq: Number.isFinite(item?.iq) ? item.iq : null,
        costUsd: Number.isFinite(item?.average_cost_usd) ? item.average_cost_usd : null,
        minutes: Number.isFinite(item?.average_duration_minutes) ? item.average_duration_minutes : null,
      }
    }),
  })).filter((rec) => rec.key && rec.items.length > 0)
}
