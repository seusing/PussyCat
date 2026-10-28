import { SUPPORTED_SITES } from '../data/supportedSites'
import { ENGINE_SITE_KEYS, PRODUCT_SITE_KEYS, RETAINED_SITE_KEYS } from './opencli-sites.mjs'

test('保留清单 = 产品站点 + 引擎站点,没有重复', () => {
  expect([...RETAINED_SITE_KEYS].sort()).toEqual(
    ['binance', 'bilibili', 'eastmoney', 'twitter', 'weixin', 'wechat-channels', 'xiaohongshu', 'youtube'].sort(),
  )
  expect(new Set(RETAINED_SITE_KEYS).size).toBe(RETAINED_SITE_KEYS.length)
  expect(ENGINE_SITE_KEYS).toEqual(['eastmoney', 'binance'])
})

test('界面上的产品站点 key 全部来自这份清单', () => {
  expect(SUPPORTED_SITES.map((site) => site.id).sort()).toEqual(Object.keys(PRODUCT_SITE_KEYS).sort())
  for (const site of SUPPORTED_SITES) {
    expect(site.keys).toEqual(PRODUCT_SITE_KEYS[site.id as keyof typeof PRODUCT_SITE_KEYS])
  }
  expect(SUPPORTED_SITES.flatMap((site) => site.keys).sort()).toEqual(
    ['bilibili', 'twitter', 'weixin', 'wechat-channels', 'xiaohongshu', 'youtube'].sort(),
  )
})
