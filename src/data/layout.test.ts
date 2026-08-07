import {
  defaultLayout, normalizeLayout, loadLayout, saveLayout, clamp, clampColumnWidth,
  LAYOUT_KEY, NAV_MIN, NAV_MAX, NAV_DEFAULT, RUNS_MIN, RUNS_MAX, RUNS_DEFAULT, CONFIG_MIN,
  MODULE_SIDEBAR_DEFAULT, DETAILS_DEFAULT,
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

const expectedLayout = (overrides: Partial<ReturnType<typeof defaultLayout>> = {}) => ({
  navWidth: NAV_DEFAULT,
  runsWidth: RUNS_DEFAULT,
  moduleSidebarWidth: MODULE_SIDEBAR_DEFAULT,
  moduleSidebarHidden: false,
  detailsWidth: DETAILS_DEFAULT,
  navHidden: false,
  runsHidden: false,
  autoLoginRefresh: false,
  autoLoginRefreshMinutes: 30,
  ...overrides,
})

test('defaultLayout 结构正确', () => {
  expect(defaultLayout()).toEqual(expectedLayout())
})

test('save→load 往返等值', () => {
  const s = fakeStorage()
  const layout = { ...defaultLayout(), navWidth: 300, runsWidth: 400 }
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
    expect(normalizeLayout({ navWidth: -50, runsWidth: -50 })).toEqual(expectedLayout({ navWidth: NAV_MIN, runsWidth: RUNS_MIN }))
  })

  it('超界(过大)→夹到 MAX', () => {
    expect(normalizeLayout({ navWidth: 99999, runsWidth: 99999 })).toEqual(expectedLayout({ navWidth: NAV_MAX, runsWidth: RUNS_MAX }))
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
    expect(normalizeLayout({ navWidth: 320 })).toEqual(expectedLayout({ navWidth: 320 }))
  })

  it('loadLayout 端到端:存储里混入非法项也不抛且落在合法区间', () => {
    const s = fakeStorage()
    s.setItem(LAYOUT_KEY, JSON.stringify({ navWidth: -999, runsWidth: 'huge' }))
    expect(loadLayout(s)).toEqual(expectedLayout({ navWidth: NAV_MIN }))
  })

  // —— navHidden/runsHidden:与 navWidth/runsWidth 同款"非法即回退默认值"策略,但判据是
  // typeof === 'boolean'而非数值区间 ——
  it('非布尔(字符串/数字)→回退默认值 false', () => {
    expect(normalizeLayout({ navWidth: 300, runsWidth: 400, navHidden: 'yes', runsHidden: 1 }))
      .toEqual(expectedLayout({ navWidth: 300, runsWidth: 400 }))
  })

  it('合法布尔值→原样透传(包括 true)', () => {
    expect(normalizeLayout({ navWidth: 300, runsWidth: 400, navHidden: true, runsHidden: true, autoLoginRefresh: false, autoLoginRefreshMinutes: 30 }))
      .toEqual(expectedLayout({ navWidth: 300, runsWidth: 400, navHidden: true, runsHidden: true }))
  })

  // 向后兼容:老数据只有 navWidth/runsWidth 两个字段(折叠开关上线前写入的 JSON),读出来
  // 不能抛也不能整份回退——两个新字段各自独立缺省为 false,宽度字段仍按原值生效。
  it('老数据(无 navHidden/runsHidden 字段)→两个新字段缺省 false,宽度字段不受影响', () => {
    const s = fakeStorage()
    s.setItem(LAYOUT_KEY, JSON.stringify({ navWidth: 300, runsWidth: 400 }))
    expect(loadLayout(s)).toEqual(expectedLayout({ navWidth: 300, runsWidth: 400 }))
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

describe('自动刷新配置(登录状态)', () => {
  test('**默认关** —— 这是会反复动用登录态的功能,默认不能是开的', () => {
    expect(defaultLayout().autoLoginRefresh).toBe(false)
  })

  test('老数据(没有这两个字段)读出时取默认值,宽度字段不受影响', () => {
    const s = fakeStorage()
    s.setItem('opencli-app:layout:v1', JSON.stringify({ navWidth: 300, runsWidth: 400 }))
    const l = loadLayout(s)
    expect(l.autoLoginRefresh).toBe(false)
    expect(l.autoLoginRefreshMinutes).toBe(30)
    expect(l.navWidth).toBe(300)
    expect(l.runsWidth).toBe(400)
  })

  test('开关非布尔 → 回退 false(不得被字符串"true"打开)', () => {
    expect(normalizeLayout({ autoLoginRefresh: 'true' }).autoLoginRefresh).toBe(false)
    expect(normalizeLayout({ autoLoginRefresh: 1 }).autoLoginRefresh).toBe(false)
  })

  test('间隔越界夹回区间、非法退默认', () => {
    expect(normalizeLayout({ autoLoginRefreshMinutes: 1 }).autoLoginRefreshMinutes).toBe(5)
    expect(normalizeLayout({ autoLoginRefreshMinutes: 99999 }).autoLoginRefreshMinutes).toBe(240)
    expect(normalizeLayout({ autoLoginRefreshMinutes: 'x' }).autoLoginRefreshMinutes).toBe(30)
  })
})
