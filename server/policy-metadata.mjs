// 人工审定记录。审定依据见 spec §9.1——本文件是那份审定的可执行形式。
// reviewedAgainst 由 reviewShapeHash 回填(见下方 shapeOf)。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reviewShapeHash } from './policy-fingerprint.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 读盘**惰性 + memo**:模块求值期一律不碰磁盘。理由见 policy.mjs 里 legacyBaseline() 的注释——
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
  // **十一条共同前提**:effects/residues 的取值以「Host 不放行 --trace / --site-session /
  // --keep-tab / --window」为条件(审定 §1.2 口径 F)。这些是 opencli 的运行时全局选项
  // (commanderAdapter.js:49,53-55),不是 manifest args,因此**不进 reviewShapeHash**——
  // 它们的封堵由 policy.mjs 的 assertDeclaredArgvOnly 在 Host 侧兑现,不能只靠前端 buildArgv。
  ['xiaohongshu/whoami', {
    get reviewedAgainst() { return shapeOf('xiaohongshu/whoami') },
    metadata: {
      executionPath: 'browser-bridge',
      // goto creator.xiaohongshu.com + 页内 credentials:'include' 取创作者资料(clis/xiaohongshu/auth.js:11,15)。
      authorities: ['browser-profile', 'public-network'],
      // 输出 username/followers = 本机登录的是谁(auth.js:34-37),非公开事实。
      exposure: 'personal',
      effects: [],
      credentialFlow: 'consume',
      // siteSession:'persistent' → 共享会话名 site:xiaohongshu + keepTab=true,标签租约不释放
      // (execution.js:461,465,479,314)。
      residues: ['persistent-session'],
    },
  }],
  ['xiaohongshu/feed', {
    get reviewedAgainst() { return shapeOf('xiaohongshu/feed') },
    metadata: {
      executionPath: 'browser-bridge',
      // goto /explore 后纯客户端读注水的 Pinia store,无额外请求(clis/xiaohongshu/feed.js:105,29-66)。
      authorities: ['browser-profile', 'public-network'],
      // 账号个性化推荐流;url 内嵌 note 级 xsec_token(feed.js:88-97),按审定口径 D 不升 secret。
      exposure: 'personal',
      effects: [],
      credentialFlow: 'consume',
      // ephemeral 会话 + keepTab=false,成功/失败两路径都调 closeWindow(execution.js:466,480,314,339)。
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
  ['bilibili/whoami', {
    get reviewedAgainst() { return shapeOf('bilibili/whoami') },
    metadata: {
      executionPath: 'browser-bridge',
      // goto bilibili.com + 页内 credentials:'include' 打 api.bilibili.com(clis/bilibili/auth.js:12; utils.js:130,181)。
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
      // getCookies(x.com) 只读 cookie 名 + goto x.com/home(clis/twitter/auth.js:6,15)。
      authorities: ['browser-profile', 'public-network'],
      // 输出 username/url(auth.js:25)。
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
      // (clis/twitter/shared.js:280),无 credentials 故不带 cookie;回退时整包下载至多 30 个
      // x.com 脚本(shared.js:305-315)。记此一笔:domain 不是出网面的完整表达。
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
])

/**
 * browser-cookie-read-pilot 的**显式成员集**(spec 试点口径)。
 *
 * 为什么不用派生谓词(`browser && strategy==='cookie' && access==='read'`):那会把实测 **496**
 * 条一次性拉进 tier,其中 488 条随即因 metadata-missing 落 unknown。结果仍 fail-closed,但
 * 三处代价真实存在——tier 名字("pilot")与成员规模不符;`no-tier` 与 `metadata-missing` 两个
 * reasonCode 的语义被搅混;§4.1.2 L2「触碰即处置」的记账面凭空扩大 60 倍。
 * **显式集合是「试点」的诚实表达**:进 tier 的只有这十一条,其余命令继续 `unknown/no-tier`。
 */
export const BROWSER_COOKIE_READ_PILOT = new Set([
  'xiaohongshu/whoami', 'xiaohongshu/feed', 'xiaohongshu/saved', 'xiaohongshu/collections', 'xiaohongshu/liked',
  'bilibili/whoami', 'bilibili/hot',
  'twitter/whoami', 'twitter/timeline',
  'youtube/whoami', 'youtube/subscriptions',
])
