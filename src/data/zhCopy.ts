// 命令与参数说明的中文覆盖表。
//
// **范围有意收窄到界面里能看到的四个站点(小红书、X、YouTube、B站)。** 目录里的 description 与
// arg.help 来自 opencli 的 manifest,绝大多数是英文;逐条翻译既不可能、也不该由本仓假装完成——
// 机翻的错译会比英文原文更误导人(参数说明直接决定用户填什么值)。因此:**表里有就用中文,表里没有
// 就如实回落英文原文**,不做任何自动翻译、不留半截译文。
//
// 文案原则:一句话说清「读什么、给谁看」,不复述实现细节。
// 例:timeline 的 top-by-engagement 原文列了完整加权公式(likes×1 + retweets×3 + …),
// 那是实现说明不是使用说明——用户要知道的是「按互动量重排、取前 N 条」,公式留给文档。
//
// title 是列表和详情页用的中文短名(4–8 个字),英文命令名作为次要信息另行显示;
// 译文依据是 node_modules/@jackwener/opencli/clis/<站点>/ 下适配器自己的描述和参数。

// choices:下拉选项值 → 中文标签。选项值本身保持英文(opencli 要求 choices 是纯字符串)。
type CommandCopy = {
  title?: string
  description: string
  args?: Record<string, string>
  choices?: Record<string, Record<string, string>>
}

const ZH: Record<string, CommandCopy> = {
  // ——— 小红书 ———
  'xiaohongshu/ask': {
    title: '问小红书点点',
    description: '向小红书「点点」提问，返回回答和引用来源',
  },
  'xiaohongshu/comments': {
    title: '笔记评论',
    description: '读取小红书笔记的评论，可选包含楼中楼回复',
  },
  'xiaohongshu/creator-note-detail': {
    title: '单篇笔记数据',
    description: '读取创作者中心里单篇笔记的详细数据：笔记信息、核心与互动数据、观看来源、观众画像和趋势',
  },
  'xiaohongshu/creator-notes': {
    title: '创作者笔记数据',
    description: '读取创作者中心的笔记列表，以及每篇的标题、日期、观看、点赞、收藏、评论数据',
  },
  'xiaohongshu/creator-notes-summary': {
    title: '近期笔记汇总',
    description: '批量汇总最近几篇笔记的关键数据：笔记列表加每篇的核心数据',
  },
  'xiaohongshu/creator-profile': {
    title: '创作者账号信息',
    description: '读取创作者账号信息：粉丝、关注、获赞、成长等级',
  },
  'xiaohongshu/creator-stats': {
    title: '创作者数据总览',
    description: '读取创作者数据总览：观看、点赞、收藏、评论、分享、涨粉，含每日趋势；可选近 7 天或近 30 天',
  },
  'xiaohongshu/delete-note': {
    title: '删除笔记',
    description: '删除已发布的笔记（创作者中心操作）；默认只核对目标，打开 execute 选项才会真正删除',
  },
  'xiaohongshu/download': {
    title: '下载笔记素材',
    description: '下载小红书笔记中的图片和视频',
  },
  'xiaohongshu/draft-clear': {
    title: '清空本地草稿',
    description: '清空小红书本地草稿；默认只统计数量，打开 execute 选项才会真正清空',
  },
  'xiaohongshu/draft-delete': {
    title: '删除本地草稿',
    description: '删除一条小红书本地草稿；默认只核对，打开 execute 选项才会真正删除',
  },
  'xiaohongshu/draft-open': {
    title: '查看草稿详情',
    description: '读取一条小红书本地草稿的详情',
  },
  'xiaohongshu/drafts': {
    title: '本地草稿列表',
    description: '列出小红书本地草稿箱里的草稿',
  },
  'xiaohongshu/whoami': {
    title: '当前账号',
    description: '查看当前登录的小红书账号（昵称、粉丝数）',
  },
  'xiaohongshu/feed': {
    title: '首页推荐',
    description: '读取小红书首页推荐流',
    args: { limit: '返回条数' },
  },
  'xiaohongshu/follow': {
    title: '关注用户',
    description: '关注指定的小红书用户（在个人主页上模拟点击关注）',
  },
  'xiaohongshu/login': {
    title: '登录账号',
    description: '打开小红书登录页，等浏览器完成登录',
  },
  'xiaohongshu/note': {
    title: '笔记详情',
    description: '读取小红书笔记的正文和互动数据',
  },
  'xiaohongshu/notifications': {
    title: '我的通知',
    description: '读取小红书通知，类型可选 mentions（提及）、likes（点赞）、connections（新增关注）',
  },
  'xiaohongshu/publish': {
    title: '发布图文笔记',
    description: '发布小红书图文笔记（创作者中心操作），可配文字卡片，也可只存为草稿',
  },
  'xiaohongshu/saved': {
    title: '收藏的笔记',
    description: '读取小红书收藏笔记；可按收藏夹筛选，也可只列出收藏夹',
    args: {
      id: '用户 ID 或主页链接，留空使用当前登录账号',
      collection: '收藏夹名称，留空读取全部收藏',
      'list-collections': '只列出收藏夹，不读取笔记',
      limit: '返回条数',
    },
  },
  // 旧版收藏专辑命令,目录里已隐藏,保留旧记录的中文说明。
  'xiaohongshu/collections': {
    description: '读取小红书收藏专辑列表及每个专辑的笔记数量',
    args: {
      id: '用户 ID 或主页链接，留空使用当前登录账号',
      limit: '返回专辑数量',
    },
  },
  'xiaohongshu/liked': {
    title: '点赞过的笔记',
    description: '读取小红书点赞过的笔记列表',
    args: { limit: '返回条数' },
  },
  'xiaohongshu/search': {
    title: '搜索笔记',
    description: '搜索小红书笔记，可用小红书自带的排序、发布时间和笔记类型筛选',
    args: {
      query: '搜索关键词',
      limit: '返回条数',
      sort: '排序依据，默认综合',
      time: '发布时间，默认不限',
      type: '笔记类型，默认不限',
    },
    choices: {
      sort: { general: '综合', latest: '最新', likes: '最多点赞', comments: '最多评论', collects: '最多收藏' },
      time: { all: '不限', day: '一天内', week: '一周内', 'half-year': '半年内' },
      type: { all: '不限', video: '视频', image: '图文' },
    },
  },
  'xiaohongshu/unfollow': {
    title: '取消关注',
    description: '取消关注指定的小红书用户（在个人主页上模拟点击）',
  },
  'xiaohongshu/user': {
    title: '博主主页笔记',
    description: '读取小红书博主主页上的公开笔记',
  },
  'xiaohongshu/user-posts': {
    title: '博主全部笔记',
    description: '提取小红书博主的全部笔记链接，可按发布时间筛选、按点赞数排序',
    args: {
      id: '博主 ID 或主页链接',
      range: '发布时间范围，默认全部',
      sort: '排序，默认按发布时间',
      timeout: '最长加载秒数（30–600）',
    },
    choices: {
      range: { all: '全部', today: '今天', '3d': '近 3 天', '7d': '近 7 天', '15d': '近半个月', '1m': '近 1 个月', '3m': '近 3 个月', '6m': '近半年' },
      sort: { time: '按发布时间', likes: '按点赞数' },
    },
  },

  // ——— B站 ———
  'bilibili/comment': {
    title: '发表评论',
    description: '在 B站视频下发表评论或回复，@用户会解析为真实提及；打开 execute 选项才会真正发出',
  },
  'bilibili/comments': {
    title: '视频评论',
    description: '获取 B站视频的评论，也可读取某条评论下的楼中楼回复',
  },
  'bilibili/download': {
    title: '下载视频',
    description: '下载 B站视频，需要先安装 yt-dlp',
  },
  'bilibili/dynamic': {
    title: '动态列表',
    description: '读取 B站的动态流',
  },
  'bilibili/favorite': {
    title: '我的收藏夹',
    description: '读取我的收藏夹里的视频，默认第一个收藏夹，可指定收藏夹 ID',
  },
  'bilibili/feed': {
    title: '动态时间线',
    description: '读取动态时间线：不指定用户时是你关注的时间线，指定用户则是其动态，可按类型筛选',
  },
  'bilibili/feed-detail': {
    title: '动态详情',
    description: '查看某条动态的详情，支持充电专属内容',
  },
  'bilibili/follow': {
    title: '关注用户',
    description: '关注 B站用户，需要登录',
  },
  'bilibili/following': {
    title: '关注列表',
    description: '读取 B站用户的关注列表，默认是当前登录用户',
  },
  'bilibili/history': {
    title: '观看历史',
    description: '读取我的 B站观看历史',
  },
  'bilibili/login': {
    title: '登录账号',
    description: '打开 B站登录页，等浏览器完成登录',
  },
  'bilibili/me': {
    title: '我的资料',
    description: '读取我的 B站资料：昵称、UID、等级、硬币、粉丝和关注数',
  },
  'bilibili/ranking': {
    title: '视频排行榜',
    description: '读取 B站视频排行榜',
  },
  'bilibili/search': {
    title: '搜索视频或用户',
    description: '搜索 B站视频或用户',
  },
  'bilibili/subtitle': {
    title: '视频字幕',
    description: '获取 B站视频的字幕，可指定语言和分P',
  },
  'bilibili/summary': {
    title: 'AI 视频总结',
    description: '获取 B站视频的官方 AI 总结（和视频页「AI总结」一致，含分段大纲和时间戳）',
  },
  'bilibili/unfollow': {
    title: '取消关注',
    description: '取消关注 B站用户，需要登录',
  },
  'bilibili/user-videos': {
    title: '用户投稿视频',
    description: '查看指定用户的投稿视频',
  },
  'bilibili/video': {
    title: '视频信息',
    description: '获取 B站视频的元数据（标题、作者、时长、数据等）',
  },
  'bilibili/whoami': {
    title: '当前账号',
    description: '查看当前登录的 B 站账号（UID、昵称、等级）',
  },
  'bilibili/hot': {
    title: '热门视频',
    description: '读取 B 站热门视频榜',
    args: { limit: '返回条数' },
  },

  // ——— X ———
  'twitter/accept': {
    title: '自动通过私信请求',
    description: '按关键词自动通过符合条件的私信请求，可限制最多通过的数量',
  },
  'twitter/article': {
    title: '读取长文章',
    description: '读取推文里的长文章（Article），导出为 Markdown',
  },
  'twitter/block': {
    title: '屏蔽用户',
    description: '屏蔽指定的 X 用户',
  },
  'twitter/bookmark': {
    title: '收藏推文',
    description: '把指定推文加入书签',
  },
  'twitter/bookmark-folder': {
    title: '文件夹内的书签',
    description: '读取某个书签文件夹里的推文；文件夹 ID 可用「书签文件夹列表」命令获取',
  },
  'twitter/bookmark-folders': {
    title: '书签文件夹列表',
    description: '列出你的书签文件夹，含文件夹 ID、名称、条数和创建时间',
  },
  'twitter/bookmarks': {
    title: '我的书签',
    description: '读取你的书签（收藏的推文，最新的在前）',
  },
  'twitter/delete': {
    title: '删除推文',
    description: '按链接删除指定的推文',
  },
  'twitter/device-follow': {
    title: '铃铛通知动态',
    description: '读取已开启铃铛通知的账号的新推文（通知里“某某等 N 人有新帖子”聚合的那一批）',
  },
  'twitter/download': {
    title: '下载推文媒体',
    description: '下载 X 上的图片和视频：填用户名则抓取其主页的全部媒体，填推文链接则只下载这一条',
  },
  'twitter/follow': {
    title: '关注用户',
    description: '关注指定的 X 用户',
  },
  'twitter/follow-batch': {
    title: '批量关注用户',
    description: '按逗号分隔的用户名列表，批量关注多个 X 用户',
  },
  'twitter/followers': {
    title: '粉丝列表',
    description: '读取某个用户的粉丝，不填则读取你自己的',
  },
  'twitter/following': {
    title: '关注列表',
    description: '读取某个用户关注的账号，不填则读取你自己的',
  },
  'twitter/hide-reply': {
    title: '隐藏回复',
    description: '隐藏你推文下的某条回复，用来处理机器人或垃圾回复',
  },
  'twitter/like': {
    title: '点赞推文',
    description: '给指定推文点赞',
  },
  'twitter/likes': {
    title: '点赞过的推文',
    description: '读取某个用户点赞过的推文，不填则读取你自己的',
  },
  'twitter/list-add': {
    title: '加入列表',
    description: '把用户加入你创建的列表；已在列表中则不做处理',
  },
  'twitter/list-add-batch': {
    title: '批量加入列表',
    description: '把逗号分隔的多个用户批量加入你创建的列表',
  },
  'twitter/list-create': {
    title: '创建列表',
    description: '新建一个 X 列表，返回新列表的 ID',
  },
  'twitter/list-delete': {
    title: '删除列表',
    description: '删除你创建的列表；需要明确确认后才会执行',
  },
  'twitter/list-remove': {
    title: '移出列表',
    description: '把用户从你创建的列表中移除；本来就不在列表中则不做处理',
  },
  'twitter/list-remove-batch': {
    title: '批量移出列表',
    description: '把逗号分隔的多个用户批量从你创建的列表中移除',
  },
  'twitter/list-tweets': {
    title: '列表内的推文',
    description: '读取某个列表时间线里的推文',
  },
  'twitter/lists': {
    title: '我的列表',
    description: '读取你的列表，包括你创建的和你关注的',
  },
  'twitter/login': {
    title: '登录账号',
    description: '打开 X 登录页，等浏览器完成登录',
  },
  'twitter/notifications': {
    title: '我的通知',
    description: '读取你的通知（点赞、回复、新增关注等），最新的在前',
  },
  'twitter/post': {
    title: '发布推文',
    description: '发布一条推文或推文串，可附图片',
  },
  'twitter/profile': {
    title: '用户资料',
    description: '读取某个用户的资料（简介、数据等），不填则读取你自己的',
  },
  'twitter/quote': {
    title: '引用推文',
    description: '引用指定推文并附上你的文字，可附本地或网络图片',
  },
  'twitter/reply': {
    title: '回复推文',
    description: '回复指定推文，可附本地或网络图片',
  },
  'twitter/reply-dm': {
    title: '批量回复私信',
    description: '向最近的私信对话发送同一条消息；默认跳过已发送过相同内容的对话',
  },
  'twitter/retweet': {
    title: '转发推文',
    description: '转发指定推文',
  },
  'twitter/search': {
    title: '搜索推文',
    description: '搜索 X 上的推文，可按作者、媒体类型筛选或排除某类内容，并可切换热门、最新、图片、视频标签',
  },
  'twitter/thread': {
    title: '推文串与回复',
    description: '读取一条推文的完整对话：原推文和全部回复',
  },
  'twitter/trending': {
    title: '热门话题',
    description: '读取 X 的热门话题',
  },
  'twitter/tweets': {
    title: '用户最新推文',
    description: '读取某个用户最近发布的推文（按时间倒序，不含置顶），不填则读取你自己的',
  },
  'twitter/unblock': {
    title: '取消屏蔽',
    description: '取消屏蔽指定的 X 用户',
  },
  'twitter/unbookmark': {
    title: '取消收藏推文',
    description: '把指定推文从书签中移除',
  },
  'twitter/unfollow': {
    title: '取消关注',
    description: '取消关注指定的 X 用户',
  },
  'twitter/unlike': {
    title: '取消点赞',
    description: '取消对指定推文的点赞',
  },
  'twitter/unretweet': {
    title: '取消转发',
    description: '撤销对指定推文的转发',
  },
  'twitter/whoami': {
    title: '当前账号',
    description: '查看当前登录的 X 账号',
  },
  'twitter/timeline': {
    title: '首页时间线',
    description: '读取你的 X 首页时间线',
    args: {
      type: '时间线类型',
      limit: '返回条数，默认 20',
      'top-by-engagement': '按互动量取前 N 条，0 为不重排',
    },
    choices: {
      type: { 'for-you': '推荐', following: '关注（按时间倒序）' },
    },
  },

  // ——— YouTube ———
  'youtube/channel': {
    title: '频道信息',
    description: '获取 YouTube 频道信息和近期视频',
  },
  'youtube/comments': {
    title: '视频评论',
    description: '获取 YouTube 视频的评论',
  },
  'youtube/feed': {
    title: '首页推荐',
    description: '获取 YouTube 首页推荐的视频',
  },
  'youtube/history': {
    title: '观看历史',
    description: '获取你的 YouTube 观看历史',
  },
  'youtube/like': {
    title: '点赞视频',
    description: '给指定的 YouTube 视频点赞',
  },
  'youtube/login': {
    title: '登录账号',
    description: '打开 YouTube 登录页，等浏览器完成登录',
  },
  'youtube/playlist': {
    title: '播放列表内容',
    description: '获取播放列表的信息和其中的视频',
  },
  'youtube/search': {
    title: '搜索视频',
    description: '搜索 YouTube 视频，可按类型、上传时间和排序方式筛选',
  },
  'youtube/subscribe': {
    title: '订阅频道',
    description: '订阅指定的 YouTube 频道',
  },
  'youtube/transcript': {
    title: '视频字幕文稿',
    description: '获取视频的字幕（文稿），可指定语言；可按段落整理，也可逐条输出原始分段',
  },
  'youtube/unlike': {
    title: '取消点赞',
    description: '取消对指定视频的点赞',
  },
  'youtube/unsubscribe': {
    title: '取消订阅',
    description: '取消订阅指定的 YouTube 频道',
  },
  'youtube/video': {
    title: '视频信息',
    description: '获取视频的元数据（标题、播放量、简介等）',
  },
  'youtube/watch-later': {
    title: '稍后观看',
    description: '获取你的「稍后观看」列表',
  },
  'youtube/whoami': {
    title: '当前账号',
    description: '查看当前登录的 YouTube 账号',
  },
  'youtube/subscriptions': {
    title: '我的订阅',
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

/** 命令的中文短名。表里没有返回 undefined,由调用方决定怎么回落(通常是英文命令名)。 */
export function commandTitle(commandKey: string): string | undefined {
  return ZH[commandKey]?.title
}

/** 参数说明:同上。**逐参数回落**——一条命令译了 description 不代表每个参数都译了。 */
export function argHelp(commandKey: string, argName: string, fallback?: string): string {
  return ZH[commandKey]?.args?.[argName] ?? fallback ?? ''
}

/** 下拉选项的中文标签:表里没有就显示选项值原文。 */
export function choiceLabel(commandKey: string, argName: string, value: string): string {
  return ZH[commandKey]?.choices?.[argName]?.[value] ?? value
}

/** 该命令是否有中文说明。仅供测试与文案盘点使用,不参与渲染判断。 */
export function hasZhCopy(commandKey: string): boolean {
  return commandKey in ZH
}
