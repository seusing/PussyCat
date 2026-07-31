import {
  defaultLayout, normalizeLayout, loadLayout, saveLayout, clamp, clampColumnWidth,
  LAYOUT_KEY, NAV_MIN, NAV_MAX, NAV_DEFAULT, RUNS_MIN, RUNS_MAX, RUNS_DEFAULT, CONFIG_MIN,
} from './layout'

// 内存假 Storage:纯函数可注入,不依赖 jsdom 全局(与 preferences.test.ts 同款写法)
function fakeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  }
}

test('defaultLayout 结构正确', () => {
  expect(defaultLayout()).toEqual({ navWidth: NAV_DEFAULT, runsWidth: RUNS_DEFAULT })
})

test('save→load 往返等值', () => {
  const s = fakeStorage()
  const layout = { navWidth: 300, runsWidth: 400 }
  saveLayout(layout, s)
  expect(loadLayout(s)).toEqual(layout)
})

test('loadLayout:空存储→default', () => {
  expect(loadLayout(fakeStorage())).toEqual(defaultLayout())
})

test('loadLayout:坏 JSON→default 不抛', () => {
  const s = fakeStorage(); s.setItem(LAYOUT_KEY, '{not json')
  expect(loadLayout(s)).toEqual(defaultLayout())
})

test('localStorage 属性访问抛 SecurityError → load/save 降级不抛', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError: denied') } })
  try {
    expect(loadLayout()).toEqual(defaultLayout())
    expect(() => saveLayout(defaultLayout())).not.toThrow()
    expect(saveLayout(defaultLayout())).toBe(false)
  } finally {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  }
})

test('storage 写入抛错(配额满)→ saveLayout 返回 false 不抛', () => {
  const failing = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {} } as unknown as Storage
  expect(() => saveLayout(defaultLayout(), failing)).not.toThrow()
  expect(saveLayout(defaultLayout(), failing)).toBe(false)
})

// —— normalizeLayout:非法值(负数/字符串/NaN/超界)一律夹回合法区间 ——
describe('normalizeLayout 守卫', () => {
  it('负数→夹到 MIN', () => {
    expect(normalizeLayout({ navWidth: -50, runsWidth: -50 })).toEqual({ navWidth: NAV_MIN, runsWidth: RUNS_MIN })
  })

  it('超界(过大)→夹到 MAX', () => {
    expect(normalizeLayout({ navWidth: 99999, runsWidth: 99999 })).toEqual({ navWidth: NAV_MAX, runsWidth: RUNS_MAX })
  })

  it('字符串→回退默认值', () => {
    expect(normalizeLayout({ navWidth: 'wide', runsWidth: 'narrow' })).toEqual(defaultLayout())
  })

  it('真 NaN→回退默认值(JSON 文本无法编码 NaN,只能在这一层直接验证)', () => {
    expect(normalizeLayout({ navWidth: NaN, runsWidth: NaN })).toEqual(defaultLayout())
  })

  it('非对象/null/undefined→整份回退默认值', () => {
    expect(normalizeLayout(null)).toEqual(defaultLayout())
    expect(normalizeLayout(undefined)).toEqual(defaultLayout())
    expect(normalizeLayout('nope')).toEqual(defaultLayout())
    expect(normalizeLayout(42)).toEqual(defaultLayout())
  })

  it('缺字段→该字段回退默认值,另一字段仍生效', () => {
    expect(normalizeLayout({ navWidth: 320 })).toEqual({ navWidth: 320, runsWidth: RUNS_DEFAULT })
  })

  it('loadLayout 端到端:存储里混入非法项也不抛且落在合法区间', () => {
    const s = fakeStorage()
    s.setItem(LAYOUT_KEY, JSON.stringify({ navWidth: -999, runsWidth: 'huge' }))
    expect(loadLayout(s)).toEqual({ navWidth: NAV_MIN, runsWidth: RUNS_DEFAULT })
  })
})

// —— clamp:纯算术夹取 ——
test('clamp 三态:低于下限/在区间内/高于上限', () => {
  expect(clamp(-10, 0, 100)).toBe(0)
  expect(clamp(50, 0, 100)).toBe(50)
  expect(clamp(200, 0, 100)).toBe(100)
})

// —— clampColumnWidth:拖拽时的容器感知夹取 ——
describe('clampColumnWidth', () => {
  it('容器宽度未知(0/非有限数)→退化为只受自身 min/max 约束', () => {
    expect(clampColumnWidth(999, NAV_MIN, NAV_MAX, RUNS_DEFAULT, 0)).toBe(NAV_MAX)
    expect(clampColumnWidth(-999, NAV_MIN, NAV_MAX, RUNS_DEFAULT, 0)).toBe(NAV_MIN)
    expect(clampColumnWidth(300, NAV_MIN, NAV_MAX, RUNS_DEFAULT, NaN)).toBe(300)
    expect(clampColumnWidth(300, NAV_MIN, NAV_MAX, RUNS_DEFAULT, -100)).toBe(300)
  })

  it('容器宽度已知且会挤压中栏→提议值被夹到"剩余空间"而非自身绝对上限', () => {
    // containerWidth=1200, otherFixedWidth(runs)=360, CONFIG_MIN=400 → 留给 nav 的余量 = 1200-360-400=440,
    // 小于 nav 自身上限 480,所以拖到 470 应被夹到 440,而不是放行到 470。
    const containerWidth = 1200
    expect(CONFIG_MIN).toBe(400)
    expect(clampColumnWidth(470, NAV_MIN, NAV_MAX, RUNS_DEFAULT, containerWidth)).toBe(containerWidth - RUNS_DEFAULT - CONFIG_MIN)
    expect(clampColumnWidth(470, NAV_MIN, NAV_MAX, RUNS_DEFAULT, containerWidth)).toBe(440)
  })

  it('容器极端窄(余量小于自身下限)→防御性回落到自身 min,而不是产出更小的坏值', () => {
    // containerWidth=900, otherFixedWidth(runs)=360, CONFIG_MIN=400 → 余量=140,小于 NAV_MIN(200)
    expect(clampColumnWidth(999, NAV_MIN, NAV_MAX, 360, 900)).toBe(NAV_MIN)
  })

  it('提议值本身就在收紧后的区间内→原样放行(不误夹健康值)', () => {
    const containerWidth = 1200
    expect(clampColumnWidth(300, NAV_MIN, NAV_MAX, RUNS_DEFAULT, containerWidth)).toBe(300)
  })
})
