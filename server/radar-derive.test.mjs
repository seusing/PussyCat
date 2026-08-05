// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  COMBINED_COST_WEIGHT, FAMILIES, IQ_FULL_SCALE, TIERS,
  deriveModels, derivePicks, familyOf,
} from './radar-derive.mjs'

/** 造一个可控的矩阵:tasks 条任务,按 pass 数组决定每个格子过没过。 */
function matrix({ tasks = 4, combos = [{ model: 'gpt-5.6-sol', effort: 'xhigh' }], cell = () => ({}) } = {}) {
  const taskList = Array.from({ length: tasks }, (_, i) => ({ id: `t${i}` }))
  const cells = {}
  for (const combo of combos) {
    for (let i = 0; i < tasks; i += 1) {
      const made = cell(combo, i)
      if (made) cells[`t${i}|${combo.model}|${combo.effort}`] = made
    }
  }
  return { tasks: taskList, combos, cells }
}

const run = (over = {}) => ({
  passed: true, graded_at: '2026-08-01T00:00:00+00:00',
  actual_cost_usd: 1, duration_sec: 600, ...over,
})

describe('IQ', () => {
  it('全过 = 满分 150 —— 刻度是"通过任务数 / 总任务数 × 150"', () => {
    const [model] = deriveModels(matrix({ tasks: 4, cell: () => ({ ran_by: [run()] }) }), null)
    expect(model.iq).toBe(IQ_FULL_SCALE)
    expect(model.passed).toBe(4)
    expect(model.samples).toBe(4)
  })

  it('过一半 = 75', () => {
    const [model] = deriveModels(
      matrix({ tasks: 4, cell: (_c, i) => ({ ran_by: [run({ passed: i < 2 })] }) }), null,
    )
    expect(model.iq).toBe(75)
  })

  it('分母是全部任务,不是跑过的任务 —— 没跑的算没过,否则少跑几题就能刷高分', () => {
    const [model] = deriveModels(
      matrix({ tasks: 4, cell: (_c, i) => (i < 2 ? { ran_by: [run()] } : null) }), null,
    )
    expect(model.samples).toBe(4)
    expect(model.iq).toBe(75)
  })
})

describe('latest_valid_per_task', () => {
  it('同一格多次运行只认最新那次的结果', () => {
    const [model] = deriveModels(matrix({
      tasks: 1,
      cell: () => ({ ran_by: [
        run({ passed: true, graded_at: '2026-08-01T00:00:00+00:00', actual_cost_usd: 9, duration_sec: 60 }),
        run({ passed: false, graded_at: '2026-08-03T00:00:00+00:00', actual_cost_usd: 2, duration_sec: 120 }),
      ] }),
    }), null)
    expect(model.passed).toBe(0)
    expect(model.costUsd).toBe(2)
    expect(model.minutes).toBe(2)
  })

  it('费用/耗时是各任务最新那次的平均', () => {
    const [model] = deriveModels(matrix({
      tasks: 2,
      cell: (_c, i) => ({ ran_by: [run({ actual_cost_usd: i === 0 ? 1 : 3, duration_sec: i === 0 ? 600 : 1800 })] }),
    }), null)
    expect(model.costUsd).toBe(2)
    expect(model.minutes).toBe(20)
  })

  it('缺费用或耗时的运行不拉低平均,而是不计入', () => {
    const [model] = deriveModels(matrix({
      tasks: 2,
      cell: (_c, i) => ({ ran_by: [run(i === 0 ? {} : { actual_cost_usd: null, duration_sec: null })] }),
    }), null)
    expect(model.costUsd).toBe(1)
    expect(model.minutes).toBe(10)
  })
})

describe('combined cost index', () => {
  it('权重指数照抄站方,不许自己调 —— 一改 x 轴就跟人家对不上', () => {
    expect(COMBINED_COST_WEIGHT).toBeCloseTo(Math.log(2.5) / Math.log(1.35), 12)
    expect(COMBINED_COST_WEIGHT).toBeCloseTo(3.0532, 3)
  })

  it('对得上站方自己公布的数 —— 这是唯一的非自证核对', () => {
    // /api/radar-insights 里 sol xhigh 那条:cost 6.461142 / 25.58 分钟 /
    // combined_cost_index 11370.55(站方公布的未归一化原值)。
    const raw = 6.461142 * (25.58 / 10) ** COMBINED_COST_WEIGHT * 100
    expect(raw / 11370.55).toBeCloseTo(1, 2)   // 站方的分钟数只给到两位小数
  })

  it('归一化成相对值:最贵的记 100', () => {
    const models = deriveModels(matrix({
      tasks: 1,
      combos: [
        { model: 'gpt-5.6-sol', effort: 'ultra' },
        { model: 'gpt-5.6-luna', effort: 'low' },
      ],
      cell: (combo) => ({ ran_by: [run(combo.effort === 'ultra'
        ? { actual_cost_usd: 20, duration_sec: 3000 }
        : { actual_cost_usd: 0.03, duration_sec: 300 })] }),
    }), null)
    const [sol, luna] = models
    expect(sol.cci).toBe(100)
    expect(luna.cci).toBeLessThan(1)
    expect(luna.cci).toBeGreaterThan(0)
  })

  it('费用或耗时缺失时不硬凑一个 0,而是留空', () => {
    const [model] = deriveModels(matrix({
      tasks: 1, cell: () => ({ ran_by: [run({ actual_cost_usd: null })] }),
    }), null)
    expect(model.costUsd).toBeNull()
    expect(model.cci).toBeNull()
  })
})

describe('分组与排序', () => {
  it('按家族、再按档位从高到低 —— 同档位才能横向比', () => {
    const combos = [
      { model: 'gpt-5.6-luna', effort: 'low' },
      { model: 'gpt-5.6-sol', effort: 'medium' },
      { model: 'gpt-5.6-sol', effort: 'ultra' },
    ]
    const models = deriveModels(matrix({ tasks: 1, combos, cell: () => ({ ran_by: [run()] }) }), null)
    expect(models.map((m) => m.label)).toEqual(['Sol ultra', 'Sol medium', 'Luna low'])
  })

  it('家族名与配色来自固定表,认不出的原样透出而不是丢掉', () => {
    expect(familyOf('gpt-5.6-sol').name).toBe('Sol')
    expect(familyOf('deepseek-v4-flash').name).toBe('DeepSeek V4 Flash')
    expect(familyOf('brand-new-model').name).toBe('brand-new-model')
    expect(FAMILIES).toHaveLength(5)
    expect(TIERS[0]).toBe('ultra')
  })

  it('24 小时运行次数来自 metrics 接口,对不上就是 0,不瞎猜', () => {
    const metrics = { points: [{ model: 'gpt-5.6-sol', effort: 'xhigh', runs_24h: 13 }] }
    const [model] = deriveModels(matrix({ tasks: 1, cell: () => ({ ran_by: [run()] }) }), metrics)
    expect(model.runs24).toBe(13)
    const [none] = deriveModels(matrix({ tasks: 1, cell: () => ({ ran_by: [run()] }) }), null)
    expect(none.runs24).toBe(0)
  })
})

describe('上游给的形状不对时', () => {
  it('空矩阵给空表,不抛', () => {
    expect(deriveModels(null, null)).toEqual([])
    expect(deriveModels({ tasks: [], combos: [] }, null)).toEqual([])
  })

  it('格子里没有运行记录时算没过,但仍占一个分母', () => {
    const [model] = deriveModels(matrix({ tasks: 2, cell: () => ({ ran_by: [] }) }), null)
    expect(model.iq).toBe(0)
    expect(model.samples).toBe(2)
  })
})

describe('derivePicks', () => {
  const insights = {
    recommendations: [{
      key: 'daily_development', title: '日常开发', rule: '原始 IQ ≥90…',
      items: [
        { model: 'gpt-5.6-sol', effort: 'xhigh', iq: 107.14, average_cost_usd: 6.461142, average_duration_minutes: 25.58 },
        { model: 'gpt-5.6-luna', effort: 'max', iq: 96.43, average_cost_usd: 0.4641, average_duration_minutes: 31.26 },
      ],
    }],
  }

  it('站方已经算好的推荐原样投影,不重算', () => {
    const [pick] = derivePicks(insights)
    expect(pick.title).toBe('日常开发')
    expect(pick.items[0]).toMatchObject({ label: 'Sol xhigh', iq: 107.14, costUsd: 6.461142, minutes: 25.58 })
    expect(pick.items[1].label).toBe('Luna max')
  })

  it('没有条目的推荐不占位置', () => {
    expect(derivePicks({ recommendations: [{ key: 'x', title: 'X', items: [] }] })).toEqual([])
    expect(derivePicks(null)).toEqual([])
  })
})
