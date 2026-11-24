// 人工审定记录。审定依据见 spec §9.1——本文件是那份审定的可执行形式。
// reviewedAgainst 由 reviewShapeHash 回填(见下方 shapeOf)。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reviewCarryHash, reviewShapeHash } from './policy-fingerprint.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 读盘**惰性 + memo**:模块求值期一律不碰磁盘。理由:
// index.mjs 的 try/catch 在静态 import **之后**才生效,顶层 JSON.parse 一旦失败就是裸 SyntaxError,
// failReady() 收不到,supervisor 拿不到 opencliHostReady:false。
let snapshotMemo = null
function snapshot() {
  if (snapshotMemo === null) {
    snapshotMemo = JSON.parse(
      readFileSync(join(projectRoot, 'public/catalog.snapshot.json'), 'utf8').replace(/^﻿/, ''),
    )
  }
  return snapshotMemo
}

const shapeMemo = new Map()
const shapeOf = (key) => {
  if (shapeMemo.has(key)) return shapeMemo.get(key)
  const current = snapshot()
  const command = current.commands.find((c) => c.command === key)
  if (!command) throw new Error(`审定记录指向 catalog 里不存在的命令: ${key}`)
  const shape = reviewShapeHash(command, current.opencliVersion)
  shapeMemo.set(key, shape)
  return shape
}

// 审定基准版本 = 打包快照的 OpenCLI 版本。换了版本后,参数没变的命令凭 reviewedCarry 沿用审定。
export const reviewBaselineVersion = () => snapshot().opencliVersion

const carryMemo = new Map()
const carryOf = (key) => {
  if (carryMemo.has(key)) return carryMemo.get(key)
  const command = snapshot().commands.find((c) => c.command === key)
  if (!command) throw new Error(`审定记录指向 catalog 里不存在的命令: ${key}`)
  const carry = reviewCarryHash(command)
  carryMemo.set(key, carry)
  return carry
}

// reviewedAgainst 用 **getter** 而非立即求值:算它要读快照,而读盘必须惰性(见上)。
// getter 是自有访问器属性,`Object.hasOwn(record, 'reviewedAgainst')` 与
// `typeof record.reviewedAgainst === 'string'` 都照常成立,故 isCompleteRecord 无需改动,
// 导出的仍是一个货真价实的 Map —— 既有消费方与测试**一行都不用改**。
export const REVIEWED_RECORDS = new Map([
  ['trae-cn/setup', {
    get reviewedAgainst() { return shapeOf('trae-cn/setup') },
    metadata: {
      executionPath: 'direct-node',
      // 空集:它只打印本地 setup 说明文本,不访问网络、不读用户文件。
      authorities: [],
      exposure: 'public',
      effects: [],
      credentialFlow: 'none',
      residues: [],
    },
  }],
  ['mercury/reimbursement-plan', {
    get reviewedAgainst() { return shapeOf('mercury/reimbursement-plan') },
    metadata: {
      executionPath: 'direct-node',
      // 用户在本次调用中显式指定报销资料(receipt/amount/merchant/notes 均必填)。
      authorities: ['explicit-local-input'],
      exposure: 'personal',
      effects: [],
      credentialFlow: 'none',
      residues: [],
    },
  }],
  ['antigravity/recent-paths', {
    get reviewedAgainst() { return shapeOf('antigravity/recent-paths') },
    metadata: {
      executionPath: 'direct-node',
      // 主动扫描 Antigravity 的 history.recentlyOpenedPathsList——用户没指定读什么。
      authorities: ['ambient-local-files'],
      exposure: 'personal',
      effects: [],
      credentialFlow: 'none',
      residues: [],
    },
  }],

  // ── browser-cookie-read-pilot ──────────────────────────────────────────────
  // 审定全文见 docs/specs/2026-07-30-browser-cookie-read-pilot-review.md(逐条附源码行号)。
  // **十五条共同前提**:effects/residues 的取值以「Host 不放行 --trace / --site-session /
  // --keep-tab / --window」为条件(审定 §1.2 口径 F)。这些是 opencli 的运行时全局选项
  // (commanderAdapter.js:49,53-55),不是 manifest args,因此**不进 reviewShapeHash**——
  // 它们的封堵由 policy.mjs 的 assertDeclaredArgvOnly 在 Host 侧兑现,不能只靠前端 buildArgv。
  //
  // **小红书分大陆版和国际版(rednote.com)**(opencli-overrides/xiaohongshu/region.js):爪爪原生的小红书读取命令
  // (search/note/comments/user-posts/saved/collections)和复用其 collection-helpers 的上游 liked,先 getCookies 读 www.xiaohongshu.com / www.rednote.com
  // 的 id_token(只看是否为空,region.js:31),大陆版没登录、国际版登录了就在 www.rednote.com 打开页面,
  // 否则照旧在 www.xiaohongshu.com;输出的链接一律写成 www.xiaohongshu.com。manifest 的 domain 仍是
  // www.xiaohongshu.com,与 twitter/timeline 一样,domain 不是出网面的完整表达。上游 feed 不分地区。
  ['xiaohongshu/whoami', {
    get reviewedAgainst() { return shapeOf('xiaohongshu/whoami') },
    metadata: {
      executionPath: 'browser-bridge',
      // 爪爪的 xiaohongshu/auth.js 换掉上游:读两个网页版的 id_token 定先查哪边,goto creator.xiaohongshu.com
      // 或 creator.rednote.com 的 /new/home,页内 credentials:'include' 取创作者资料;一边 401/403 就查另一边
      // (opencli-overrides/xiaohongshu/region.js:31,45,70)。
      authorities: ['browser-profile', 'public-network'],
      // 输出 username/followers/region = 本机登录的是谁、登录在哪个地区,非公开事实。
      exposure: 'personal',
      effects: [],
      credentialFlow: 'consume',
      // siteSession:'persistent' → 共享会话名 site:xiaohongshu + keepTab=true,标签租约不释放
      // (execution.js:551,558,572,355)。
      residues: ['persistent-session'],
    },
  }],
  ['xiaohongshu/feed', {
    get reviewedAgainst() { return shapeOf('xiaohongshu/feed') },
    metadata: {
      executionPath: 'browser-bridge',
      // goto /explore 后纯客户端读注水的 Pinia store,无额外请求(clis/xiaohongshu/feed.js:99,30-67)。
      authorities: ['browser-profile', 'public-network'],
      // 账号个性化推荐流;url 内嵌 note 级 xsec_token(feed.js:82-91),按审定口径 D 不升 secret。
      exposure: 'personal',
      effects: [],
      credentialFlow: 'consume',
      // ephemeral 会话 + keepTab=false,成功/失败两路径都调 closeWindow(execution.js:559,573,355,382)。
      residues: [],
    },
  }],
  ['xiaohongshu/saved', {
    get reviewedAgainst() { return shapeOf('xiaohongshu/saved') },
    metadata: {
      executionPath: 'browser-bridge',
      authorities: ['browser-profile', 'public-network'],
      exposure: 'personal',
      effects: [],
      credentialFlow: 'consume',
      residues: [],
    },
  }],
  ['xiaohongshu/collections', {
    get reviewedAgainst() { return shapeOf('xiaohongshu/collections') },
    metadata: {
      executionPath: 'browser-bridge',
      authorities: ['browser-profile', 'public-network'],
      exposure: 'personal',
      effects: [],
      credentialFlow: 'consume',
      residues: [],
    },
  }],
  ['xiaohongshu/liked', {
    get reviewedAgainst() { return shapeOf('xiaohongshu/liked') },
    metadata: {
      executionPath: 'browser-bridge',
      authorities: ['browser-profile', 'public-network'],
      exposure: 'personal',
      effects: [],
      credentialFlow: 'consume',
      residues: [],
    },
  }],
  ['xiaohongshu/search', {
    get reviewedAgainst() { return shapeOf('xiaohongshu/search') },
    metadata: {
      executionPath: 'browser-bridge',
      // goto /search_result 后点页面筛选面板、滚动读 DOM(opencli-overrides/xiaohongshu/search.js:364,373,383-390)。
      // 筛选面板里有看不见、点不了的诱饵选项,只点用户看得见的那个(search.js:112)。
      authorities: ['browser-profile', 'public-network'],
      // 他人公开笔记的元数据;url 内嵌 note 级 xsec_token,按审定口径 D 不升 secret。
      exposure: 'public',
      effects: [],
      credentialFlow: 'consume',
      residues: [],
    },
  }],
  ['xiaohongshu/user-posts', {
    get reviewedAgainst() { return shapeOf('xiaohongshu/user-posts') },
    // 滚完整个博主主页要几分钟;命令内 --timeout 上限 600s(user-posts-helpers.js 的 parseTimeoutSeconds),
    // Host 留 30s 收尾。客户端参数不能超过这个上限(审定 §4.5)。
    commandTimeoutMs: 630_000,
    metadata: {
      executionPath: 'browser-bridge',
      // goto /explore 再 goto 博主主页,读注水的 Pinia store 并滚动(opencli-overrides/xiaohongshu/user-posts.js:45-46,26,60)。
      // 标题关键词(--keyword)只在本地对已读到的笔记标题做筛选,不发额外请求。
      // xhslink 短链接先在 Node 里请求一次、不跟随跳转、只读 Location(opencli-overrides/xiaohongshu/short-link.js:32)。
      authorities: ['browser-profile', 'public-network'],
      // 博主公开笔记列表;url 内嵌 note 级 xsec_token,按审定口径 D 不升 secret。
      exposure: 'public',
      effects: [],
      credentialFlow: 'consume',
      residues: [],
    },
  }],
  ['xiaohongshu/note', {
    get reviewedAgainst() { return shapeOf('xiaohongshu/note') },
    metadata: {
      executionPath: 'browser-bridge',
      // 短链接 / 分享文案里的 xhslink 先在 Node 里请求一次、不跟随跳转、只读 Location(opencli-overrides/xiaohongshu/short-link.js:32)。
      // 再 goto 笔记页读页面(clis/xiaohongshu/risk-control.js:63,65 的 readXhsDetailPage;遇风控软拦截最多冷却后重读一次,:73-76)。
      authorities: ['browser-profile', 'public-network'],
      // 他人公开笔记的正文和互动数(clis/xiaohongshu/note.js:109-120)。
      exposure: 'public',
      effects: [],
      credentialFlow: 'consume',
      residues: [],
    },
  }],
  ['xiaohongshu/comments', {
    get reviewedAgainst() { return shapeOf('xiaohongshu/comments') },
    metadata: {
      executionPath: 'browser-bridge',
      // 短链接处理同 xiaohongshu/note;goto 笔记页读评论区,同样经 readXhsDetailPage
      // (clis/xiaohongshu/comments.js:307;risk-control.js:63,65,73-76)。
      authorities: ['browser-profile', 'public-network'],
      // 他人公开笔记的评论正文、评论者、点赞数和评论图片链接(comments.js:325-336)。
      exposure: 'public',
      effects: [],
      credentialFlow: 'consume',
      residues: [],
    },
  }],
  ['bilibili/whoami', {
    get reviewedAgainst() { return shapeOf('bilibili/whoami') },
    metadata: {
      executionPath: 'browser-bridge',
      // goto bilibili.com + 页内 credentials:'include' 打 api.bilibili.com(clis/bilibili/auth.js:12; utils.js:158,210)。
      authorities: ['browser-profile', 'public-network'],
      // 输出 mid/username/level(auth.js:16-20)。
      exposure: 'personal',
      effects: [],
      credentialFlow: 'consume',
      residues: ['persistent-session'],
    },
  }],
  ['bilibili/hot', {
    get reviewedAgainst() { return shapeOf('bilibili/hot') },
    metadata: {
      executionPath: 'browser-bridge',
      // pipeline: navigate + 页内 fetch popular,credentials:'include'(clis/bilibili/hot.js:13,15-17)。
      authorities: ['browser-profile', 'public-network'],
      // 八条里唯一 public:返回列全为站内公开视频元数据,无任何本机账号字段(hot.js:11,29-37)。
      // exposure 判的是返回体内容,与「请求以登录身份发出」不联动——后者体现在 authorities/credentialFlow。
      exposure: 'public',
      effects: [],
      credentialFlow: 'consume',
      residues: [],
    },
  }],
  ['twitter/whoami', {
    get reviewedAgainst() { return shapeOf('twitter/whoami') },
    metadata: {
      executionPath: 'browser-bridge',
      // getCookies(x.com) 只读 cookie 名 + goto x.com/home(clis/twitter/auth.js:10,58;之后轮询读主页链接,:41-52)。
      authorities: ['browser-profile', 'public-network'],
      // 输出 username/url(auth.js:67)。
      exposure: 'personal',
      effects: [],
      credentialFlow: 'consume',
      residues: ['persistent-session'],
    },
  }],
  ['twitter/timeline', {
    get reviewedAgainst() { return shapeOf('twitter/timeline') },
    metadata: {
      executionPath: 'browser-bridge',
      // 出网面**超出** catalog 的 domain=x.com:queryId 解析会打 raw.githubusercontent.com
      // (clis/twitter/shared.js:302),无 credentials 故不带 cookie;回退时整包下载至多 30 个
      // x.com 脚本(shared.js:327-337)。记此一笔:domain 不是出网面的完整表达。
      authorities: ['browser-profile', 'public-network'],
      // 本账号的个性化时间线;ct0 只进请求头不进返回行(timeline.js:173-178 vs :159)。
      exposure: 'personal',
      // POST HomeLatestTimeline 判定为**查询非变更**:变量在 query string、fetch 无 body、
      // 响应是 home_timeline_urt 读取信封、seenTweetIds 显式发空数组(timeline.js:62-66,189,99,57)。
      effects: [],
      credentialFlow: 'consume',
      residues: [],
    },
  }],
  ['youtube/whoami', {
    get reviewedAgainst() { return shapeOf('youtube/whoami') },
    metadata: {
      executionPath: 'browser-bridge',
      // getCookies(youtube.com) 只读 cookie 名 + goto + 读 ytcfg(clis/youtube/auth.js:5,14,18-19)。
      authorities: ['browser-profile', 'public-network'],
      // 输出 identityName / 头像 aria-label(auth.js:28-33,38)。
      exposure: 'personal',
      effects: [],
      credentialFlow: 'consume',
      residues: ['persistent-session'],
    },
  }],
  ['youtube/subscriptions', {
    get reviewedAgainst() { return shapeOf('youtube/subscriptions') },
    metadata: {
      executionPath: 'browser-bridge',
      // goto /feed/channels 并解析 ytInitialData;未登录时无订阅数据(clis/youtube/subscriptions.js:21,25-26)。
      authorities: ['browser-profile', 'public-network'],
      // 用户的订阅关系列表(subscriptions.js:18,30-44)。
      exposure: 'personal',
      effects: [],
      credentialFlow: 'consume',
      residues: [],
    },
  }],

  // ── browser-account-switch ─────────────────────────────────────────────────
  // 爪爪原生 switch-account(opencli-overrides/_shared/account-switch.js + 各站点 switch-account.js)。
  // 先查一次身份记下当前账号(小红书查所在地区的创作者中心,其余复用上游 whoami);小红书 / B站 / X 再走站点自己的
  // 退出入口登出(创作者中心头像菜单「退出登录」、passport /login/exit/v2、x.com/logout 的确认按钮),YouTube 不退出、
  // 打开「添加 Google 账号」;然后在前台打开登录页,由用户扫码或输密码。之后每 2s 只读该站会话 cookie(YouTube 读页面
  // ytcfg;小红书读两个地区的 id_token),变了才再查一次身份。
  // 退出是登录态的变更,记在 credentialFlow 'both' 里;命令不发内容、不写文件,effects 仍为 []。
  ['xiaohongshu/switch-account', {
    get reviewedAgainst() { return shapeOf('xiaohongshu/switch-account') },
    // 命令内最多等 300s(account-switch.js 的 WAIT_SECONDS),Host 留 30s 收尾。
    commandTimeoutMs: 330_000,
    metadata: {
      executionPath: 'browser-bridge',
      // 会话指纹:www.xiaohongshu.com 与 www.rednote.com(国际版)的 id_token(游客会话没有);
      // 身份在所在地区的创作者中心请求 /api/galaxy/creator/home/personal_info,与上游 whoami 同一接口。
      // 登录页是网页版 www.xiaohongshu.com/login:国际版账号扫码后,网页版自己带着这次扫码的 qrId/code 转到
      // www.rednote.com 接着登录,用户只扫一次(创作者中心的登录页会丢掉这次扫码,要再扫一次)。
      authorities: ['browser-profile', 'public-network'],
      // 输出换号前后的账号名,即本机登录的是谁。
      exposure: 'personal',
      effects: [],
      // 读现有登录态(consume),并等用户在页面里登录出新的登录态(produce)。
      credentialFlow: 'both',
      // siteSession:'persistent',与 whoami 共用 site:xiaohongshu 会话。
      residues: ['persistent-session'],
    },
  }],
  ['bilibili/switch-account', {
    get reviewedAgainst() { return shapeOf('bilibili/switch-account') },
    // 命令内最多等 300s(account-switch.js 的 WAIT_SECONDS),Host 留 30s 收尾。
    commandTimeoutMs: 330_000,
    metadata: {
      executionPath: 'browser-bridge',
      // 会话指纹:www.bilibili.com 的 SESSDATA / DedeUserID。
      authorities: ['browser-profile', 'public-network'],
      // 输出换号前后的账号名,即本机登录的是谁。
      exposure: 'personal',
      effects: [],
      // 读现有登录态(consume),并等用户在页面里登录出新的登录态(produce)。
      credentialFlow: 'both',
      // siteSession:'persistent',与 whoami 共用 site:bilibili 会话。
      residues: ['persistent-session'],
    },
  }],
  ['twitter/switch-account', {
    get reviewedAgainst() { return shapeOf('twitter/switch-account') },
    // 命令内最多等 300s(account-switch.js 的 WAIT_SECONDS),Host 留 30s 收尾。
    commandTimeoutMs: 330_000,
    metadata: {
      executionPath: 'browser-bridge',
      // 会话指纹:x.com 的 auth_token / twid。
      authorities: ['browser-profile', 'public-network'],
      // 输出换号前后的账号名,即本机登录的是谁。
      exposure: 'personal',
      effects: [],
      // 读现有登录态(consume),并等用户在页面里登录出新的登录态(produce)。
      credentialFlow: 'both',
      // siteSession:'persistent',与 whoami 共用 site:twitter 会话。
      residues: ['persistent-session'],
    },
  }],
  ['youtube/switch-account', {
    get reviewedAgainst() { return shapeOf('youtube/switch-account') },
    // 命令内最多等 300s(account-switch.js 的 WAIT_SECONDS),Host 留 30s 收尾。
    commandTimeoutMs: 330_000,
    metadata: {
      executionPath: 'browser-bridge',
      // 会话指纹:www.youtube.com 页面上的 ytcfg LOGGED_IN / DATASYNC_ID。
      authorities: ['browser-profile', 'public-network'],
      // 输出换号前后的账号名,即本机登录的是谁。
      exposure: 'personal',
      effects: [],
      // 读现有登录态(consume),并等用户在页面里登录出新的登录态(produce)。
      credentialFlow: 'both',
      // siteSession:'persistent',与 whoami 共用 site:youtube 会话。
      residues: ['persistent-session'],
    },
  }],

  // ── browser-dot-chat ───────────────────────────────────────────────────────
  // 爪爪原生点点对话(opencli-overrides/xiaohongshu-dot/chat.js)。在账号所在地区的网页里(大陆站 www.xiaohongshu.com/ai_chat,
  // 国际版 www.rednote.com/explore)调页面点点会话模块的 createConversation / sendMessage / interruptCurrentMessage,
  // 请求和签名都由页面自己发出、生成,不碰网络层。站点 key 单独成 xiaohongshu-dot,浏览器会话 site:xiaohongshu-dot
  // 只放点点这一个标签;页面放久了会先刷新再问。
  ['xiaohongshu-dot/chat', {
    get reviewedAgainst() { return shapeOf('xiaohongshu-dot/chat') },
    // 命令内最多等 180s(chat.js 的 MAX_TIMEOUT_SECONDS),Host 留 30s 收尾。
    commandTimeoutMs: 210_000,
    metadata: {
      executionPath: 'browser-bridge',
      // 用本机 Chrome 里小红书(大陆站或国际版)的登录态,由页面经长连接 / HTTP 发问、收答。
      authorities: ['browser-profile', 'public-network'],
      // 回答可能涉及本人账号的数据(例如收藏夹),按个人信息算。
      exposure: 'personal',
      // 每条提问都会存进点点那边的会话记录。
      effects: ['remote-write'],
      credentialFlow: 'consume',
      // siteSession:'persistent' → 共享会话 site:xiaohongshu-dot + keepTab=true,点点页面常驻以接续多轮对话。
      residues: ['persistent-session'],
    },
  }],
  ['xiaohongshu-dot/stop', {
    get reviewedAgainst() { return shapeOf('xiaohongshu-dot/stop') },
    metadata: {
      executionPath: 'browser-bridge',
      // 在同一个点点标签里调会话对象的 interruptCurrentMessage(页面随之通知点点停止这一轮)。
      authorities: ['browser-profile', 'public-network'],
      // 只返回是否停掉了。
      exposure: 'public',
      // 停止生成会改动点点那边这一轮的状态;opencli 层记成 read 只为不被 chat 的写租约挡住。
      effects: ['remote-write'],
      credentialFlow: 'consume',
      residues: ['persistent-session'],
    },
  }],
])

// reviewedCarry 同样惰性 + memo:基准快照里该命令的沿用比对哈希。
for (const [key, record] of REVIEWED_RECORDS) {
  Object.defineProperty(record, 'reviewedCarry', { get: () => carryOf(key), enumerable: true })
}

/**
 * browser-cookie-read-pilot 的**显式成员集**(spec 试点口径)。
 *
 * 为什么不用派生谓词(`browser && strategy==='cookie' && access==='read'`):那会把实测 **496**
 * 条一次性拉进 tier,其中 488 条随即因 metadata-missing 落 unknown。结果仍 fail-closed,但
 * 三处代价真实存在——tier 名字("pilot")与成员规模不符;`no-tier` 与 `metadata-missing` 两个
 * reasonCode 的语义被搅混;§4.1.2 L2「触碰即处置」的记账面凭空扩大 60 倍。
 * **显式集合是「试点」的诚实表达**:进 tier 的只有这十五条,其余命令继续 `unknown/no-tier`。
 */
export const BROWSER_COOKIE_READ_PILOT = new Set([
  'xiaohongshu/whoami', 'xiaohongshu/feed', 'xiaohongshu/saved', 'xiaohongshu/collections', 'xiaohongshu/liked',
  'xiaohongshu/search', 'xiaohongshu/user-posts', 'xiaohongshu/note', 'xiaohongshu/comments',
  'bilibili/whoami', 'bilibili/hot',
  'twitter/whoami', 'twitter/timeline',
  'youtube/whoami', 'youtube/subscriptions',
])

/**
 * browser-account-switch 的显式成员集:爪爪原生的四条切换账号命令。
 * 与试点分开成组,因为它要 credentialFlow 'both'(用户在页面里登录出新会话),试点只收 consume。
 */
export const BROWSER_ACCOUNT_SWITCH = new Set([
  'xiaohongshu/switch-account', 'bilibili/switch-account', 'twitter/switch-account', 'youtube/switch-account',
])

/**
 * browser-dot-chat 的显式成员集:爪爪原生的点点对话(提问 + 停止生成)。
 * 单独成组,因为它要 effects 'remote-write'(提问会存进点点的会话记录),别的浏览器分组都只收 []。
 */
export const BROWSER_DOT_CHAT = new Set(['xiaohongshu-dot/chat', 'xiaohongshu-dot/stop'])
