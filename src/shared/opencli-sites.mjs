// 随爪爪运行的 OpenCLI 保留哪些站点。更新 OpenCLI 时,清单之外的站点命令连同适配器目录一并裁掉。
// 产品站点的 key 按界面里的站点 id 分组(src/data/supportedSites.ts 引用这里),引擎站点只给视频引擎用。

export const PRODUCT_SITE_KEYS = {
  wechat: ['wechat-channels', 'weixin'],
  x: ['twitter'],
  xiaohongshu: ['xiaohongshu'],
  youtube: ['youtube'],
  bilibili: ['bilibili'],
}

export const ENGINE_SITE_KEYS = ['eastmoney', 'binance']

// 爪爪自己的站点 key(opencli-overrides 里新建的,上游没有):xiaohongshu-dot 是点点对话,
// 单独成站是为了让它有自己的浏览器标签(会话名 site:<站点>)
export const NATIVE_SITE_KEYS = ['xiaohongshu-dot']

export const RETAINED_SITE_KEYS = [...Object.values(PRODUCT_SITE_KEYS).flat(), ...ENGINE_SITE_KEYS, ...NATIVE_SITE_KEYS]
