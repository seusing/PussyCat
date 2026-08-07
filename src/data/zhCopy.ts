// 命令与参数说明的中文覆盖表。
//
// **范围有意收窄到试点八条。** 目录里 1278 条命令的 description 与 arg.help 来自 opencli 的
// manifest,绝大多数是英文;逐条翻译既不可能、也不该由本仓假装完成——机翻的错译会比英文原文
// 更误导人(参数说明直接决定用户填什么值)。因此:**表里有就用中文,表里没有就如实回落英文原文**,
// 不做任何自动翻译、不留半截译文。
//
// 文案原则:一句话说清「读什么、给谁看」,不复述实现细节。
// 例:timeline 的 top-by-engagement 原文列了完整加权公式(likes×1 + retweets×3 + …),
// 那是实现说明不是使用说明——用户要知道的是「按互动量重排、取前 N 条」,公式留给文档。

type CommandCopy = { description: string; args?: Record<string, string> }

const ZH: Record<string, CommandCopy> = {
  'xiaohongshu/whoami': {
    description: '查看当前登录的小红书账号（昵称、粉丝数）',
  },
  'xiaohongshu/feed': {
    description: '读取小红书首页推荐流',
    args: { limit: '返回条数' },
  },
  'bilibili/whoami': {
    description: '查看当前登录的 B 站账号（UID、昵称、等级）',
  },
  'bilibili/hot': {
    description: '读取 B 站热门视频榜',
    args: { limit: '返回条数' },
  },
  'twitter/whoami': {
    description: '查看当前登录的 X 账号',
  },
  'twitter/timeline': {
    description: '读取你的 X 首页时间线',
    args: {
      type: '推荐流（for-you）或关注流（following，按时间倒序）',
      limit: '返回条数，默认 20',
      'top-by-engagement': '填 N>0 时按互动量重排并取前 N 条；默认 0 保持 X 原始排序',
    },
  },
  'youtube/whoami': {
    description: '查看当前登录的 YouTube 账号',
  },
  'youtube/subscriptions': {
    description: '列出你订阅的 YouTube 频道',
    args: { limit: '返回条数，默认 50' },
  },
}

// 站点显示名。**同样只覆盖试点四站**,其余站点直接用 manifest 里的 site key。
// 目录里有 175 个站点,给每个起中文名既没依据(manifest 不带中文名)也没必要——
// site key 本身("bilibili"、"github")在绝大多数情况下就是最好认的写法。
const SITE_ZH: Record<string, string> = {
  'wechat-channels': '微信视频号',
  weixin: '微信公众号',
  xiaohongshu: '小红书',
  bilibili: 'B站',
  twitter: 'X',
  youtube: 'YouTube',
}

/** 站点显示名:试点四站用中文,其余原样返回 site key。 */
export function siteLabel(site: string): string {
  return SITE_ZH[site] ?? site
}

/** 命令说明:有中文用中文,没有回落 manifest 原文。 */
export function commandDescription(commandKey: string, fallback?: string): string {
  return ZH[commandKey]?.description ?? fallback ?? ''
}

/** 参数说明:同上。**逐参数回落**——一条命令译了 description 不代表每个参数都译了。 */
export function argHelp(commandKey: string, argName: string, fallback?: string): string {
  return ZH[commandKey]?.args?.[argName] ?? fallback ?? ''
}

/** 该命令是否有中文说明。仅供测试与文案盘点使用,不参与渲染判断。 */
export function hasZhCopy(commandKey: string): boolean {
  return commandKey in ZH
}
