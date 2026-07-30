# browser-cookie-read-pilot 八条命令审定

- 日期：2026-07-30（v1，逐条对 vendored 源码求证）
- 上游规格：`docs/specs/2026-07-26-p1-b0-policy-protocol-design.md`（轴定义 §3.1、准入算法 §4.3、双哈希 §5）
- 审定对象：`@jackwener/opencli@1.8.6`（vendored，`node_modules/@jackwener/opencli/`）
- 快照：`public/catalog.snapshot.json`（1278 条，`opencliVersion: 1.8.6`）
- 本文件即审定记录本体；§5 是它的可执行形式，待人工整合进 `server/policy-metadata.mjs`

---

## 1. 范围、方法与横切口径

### 1.1 审定对象与已核事实

八条命令在 catalog 里的共同形态（实测）：`access=read`、`strategy=cookie`、`browser=true`、`type=js`。

| 命令 | modulePath | domain | siteSession | navigateBefore | args |
|---|---|---|---|---|---|
| `xiaohongshu/whoami` | `xiaohongshu/auth.js` | creator.xiaohongshu.com | **persistent** | false | （无） |
| `xiaohongshu/feed` | `xiaohongshu/feed.js` | www.xiaohongshu.com | null | false | limit |
| `bilibili/whoami` | `bilibili/auth.js` | www.bilibili.com | **persistent** | false | （无） |
| `bilibili/hot` | `bilibili/hot.js` | www.bilibili.com | null | `https://www.bilibili.com` | limit |
| `twitter/whoami` | `twitter/auth.js` | x.com | **persistent** | false | （无） |
| `twitter/timeline` | `twitter/timeline.js` | x.com | null | `https://x.com` | type / limit / top-by-engagement |
| `youtube/whoami` | `youtube/auth.js` | www.youtube.com | **persistent** | false | （无） |
| `youtube/subscriptions` | `youtube/subscriptions.js` | www.youtube.com | null | `https://www.youtube.com` | limit |

两条派生链已核对，catalog 与源码自洽：`bilibili/hot.js:2-11` 与 `youtube/subscriptions.js:8-18` 都**没有**声明 `browser`，`registry.js:64-65` 的 `normalizeCommand` 由 `Strategy.COOKIE` 推得 `browser=true`，`registry.js:68-69` 再由 `strategy===COOKIE && domain` 推得 `navigateBefore=https://<domain>`。

同 cohort 规模（实测）：`access=read && strategy=cookie && browser=true` 共 **496** 条。本次审定的是其中 8 条，故 tier 是**试点**而非 cohort 全量（见 §6.1）。

legacy 基线重合度（实测）：八条**均不在** `server/policy-legacy-baseline.json` 的 276 条内；该基线里 `browser=true` 的条目为 **0**。因此八条一定走 `policy.mjs:127-184` 的 tier 评估路径，不会在第 2 步短路。

### 1.2 六条横切口径裁决

这些问题在八条上完全相同。集中裁决一次，逐条不再重复；**每条都点明了它的代价与残余风险**。

#### 口径 A — CLI 运行时自身的家务，不计入命令的 `effects` / `authorities`

实测：`dist/src/main.js:126` 在每次非补全调用上执行 `checkForUpdateBackground()`；`dist/src/update-check.js:152-176` 在 24h TTL 之外会 fetch `registry.npmjs.org`（`:24`）与 `api.github.com`（`:25`），并 `writeFileSync` 到 `~/.opencli/update-check.json`（`:21`、`:36-43`）。`dist/src/browser/profile.js:5-7,17-38` 则让**每条**浏览器命令读一次 `~/.opencli/browser-profiles.json`。

若把这些计入：**每一条 opencli 命令**（含已入库审定的 `trae-cn/setup`）都会变成 `effects:['local-file-write']` 且 `authorities ∋ public-network, ambient-local-files`。轴退化为常量、丧失判别力，且已入库的三条记录当场作废。

> **裁决**：`effects`/`authorities` 描述的是**适配器为完成本命令语义而动用的资源**。CLI 进程级家务（更新检查、profile 配置读取、daemon 存活探测与拉起）属于 `executionPath` 的固有成本，**在本文件一次性记账**，不摊进逐条 metadata。
>
> **这不是豁免。** 它是横切风险，处置位置在 tier 准入的前置条件（§6.3），不是稀释到八条 metadata 里。这一条同时是对既有三条记录的追认——它们的 `effects: []` 只有在本口径下才成立。

#### 口径 B — 被加载页面自发的请求，不计入 `effects`

八条都通过真实站点页面工作。`page.goto` 之后站点自己的 JS 会继续发遥测 / 曝光 / scribe 请求，其中包含服务端可见的「已曝光 / 已读」痕迹——`twitter/whoami` 加载 `x.com/home`（`clis/twitter/auth.js:15`）、`xiaohongshu/feed` 加载 `/explore`（`clis/xiaohongshu/feed.js:105`）尤其明显。

> **裁决**：`effects` 记的是**适配器发起或指示的请求**；被加载页面自发的行为不计。否则任何 `browser-bridge` 命令都是 `remote-write`，该轴归零。
>
> **残余风险照记**：从站点视角看，这八条与用户本人浏览不可区分，会推进推荐权重与已读状态。**这是本 tier 的确认文案必须说清的事，不是能被 metadata 消掉的事。**

#### 口径 C — 浏览器 profile 自身的落盘，不计入 `local-file-write`

导航会让 Chrome 写自己的历史 / 缓存 / cookie 库。那是 `authorities ∋ browser-profile` 的题中之义。`local-file-write` 保留给**适配器显式写出的产物**（对照被排除的 download 家族：`%TEMP%\opencli-download`）。

#### 口径 D — note 级签名 token 不把 `exposure` 抬到 `secret`

`xiaohongshu/feed` 输出的 `url` 内嵌 `xsec_token`（`clis/xiaohongshu/feed.js:88-97`，在 `:140` 进入返回行）。它与被显式 deny 的 `paperreview/review`（`server/policy.mjs:52-55`）形状相似、性质不同：

- `xsec_token` 的作用对象是**一条公开笔记**的详情接口，是反爬签名，不绑定账号、不授予任何账号权限；`feed.js:83-87` 的注释实测过「source 值不被校验，只有 token 必需」；
- `paperreview` 的 token 是 capability token，内嵌进 `review_url` 即可直接取得**非公开**资源。

> **裁决**：`exposure = personal`，不升 `secret`。
>
> **这是本审定里最可能被推翻的一条。** 若审阅者采「输出体里出现任何服务端签名串即 secret」的口径，则 `xiaohongshu/feed` 改判 `secret`，并因 §6.2 的允许集不收 `secret` 而落在 tier 阈值外（`denied/tier-threshold`）。其余七条不受影响。

#### 口径 E — `live-local-app` 不进 `authorities`

八条都要求本机跑着 Chrome + OpenCLI 扩展，并经由 `127.0.0.1` 上的 daemon 转发（`browser/bridge.js:36,57-63` → `browser/daemon-lifecycle.js:23-32`）。形式上这与 `trae-cn/targets`（连接运行中的本地 CDP 端点）相似。

> **裁决**：**不计** `live-local-app`。理由：`authorities` 回答「本命令取用了什么外部资源」，这里的资源是 `browser-profile`；「取用它必须有个活着的 Chrome」是**传输方式**，而传输方式正是 `executionPath: 'browser-bridge'` 这一轴在表达的东西。计入会让该值在 496 条上恒真、零判别力，同时让 `authorities` 一轴兼表两义。
>
> 反方意见记录在案：§4.1.1 把 `live-local-app` 挡在 `local-direct` 之外，正是因为「direct-node 命令伸手去够一个活着的 app」是**意料之外**的额外权限；而对 browser-bridge，够到浏览器是路径定义本身。两条理由同向，故裁决成立。

#### 口径 F — 运行时全局选项不在审定形状内，必须在 Host 侧封死（**P0 缺口**）

`--trace`（默认 `off`，`dist/src/commanderAdapter.js:49`）、`--window` / `--site-session` / `--keep-tab`（`:53-55`）是**每条命令都可用的运行时选项**，但它们不是 manifest args，因此**不进 `reviewShapeHash`**——`server/policy-fingerprint.mjs:59-80` 只投影 `command.args`。

而 Host 的 argv 校验（`server/policy.mjs:280-290`、`:320-322`）只查四件事：token 数量与类型、`commandKey === argv[0]/argv[1]`、无 NUL、存在 `-f json`。**它不禁止追加 `--trace on` / `--site-session persistent` / `--keep-tab true`。**

后果，两条都可从源码推到底：

- `--trace on` → `execution.js:191,229-240` 建 `ObservationSession` → `observation/artifact.js:16-25` 在 `~/.opencli/profiles/<contextId>/traces/<traceId>/` 建目录并写 `trace/screenshots/state`。该次运行**真实产生** `local-file-write` + `temp-file`。（脱敏面已核：`observation/redaction.js:2-13` 的 `SENSITIVE_HEADER_NAMES` 含 `x-csrf-token`、`cookie`、`authorization`，故 `twitter/timeline` 的 ct0 请求头会被打码；但响应体预览仍会落盘时间线正文。）
- `--site-session persistent` → `execution.js:461` 的 `normalizeSiteSession(rawOption) ?? cmd.siteSession` 让**用户值优先**，四条 ephemeral 命令当场变 persistent，`residues: []` 失真。

> **裁决**：本审定的 `effects` 与 `residues` 取值，**以「不追加运行时全局选项」为前提**。该前提今天由前端 `src/data/command.ts:16-51`（只发声明过的 args + `-f json`）保证，**但 Host 层没有强制**——而 I-P1 说 Host 才是唯一权威，绕过前端不得获得额外执行能力。这里恰恰能获得。
>
> 处置见 §6.3-P0。在该项落地前，八条的 `residues`/`effects` 是**未被 Host 兑现的承诺**。

---

## 2. 逐条审定

轴取值一律附 `文件:行号`。凡源码证不到又不允许 `unknown` 的，标注「证明不了」并说明缺口。

### 2.1 `xiaohongshu/whoami`

| 轴 | 取值 |
|---|---|
| executionPath | `browser-bridge` |
| authorities | `['browser-profile', 'public-network']` |
| exposure | `personal` |
| effects | `[]` |
| credentialFlow | `consume` |
| residues | `['persistent-session']` |

- **executionPath**：catalog `browser: true`；`dist/src/execution.js:200` 的 `shouldUseBrowserSession(cmd)` 对 `browser && func` 恒真（`capabilityRouting.js:43-46`），进入 `browserSession`。
- **authorities / public-network**：`clis/xiaohongshu/auth.js:11` `page.goto('https://creator.xiaohongshu.com/new/home')`。
- **authorities / browser-profile**：`clis/xiaohongshu/auth.js:15` 在该页上下文里 `fetch('/api/galaxy/creator/home/personal_info', { credentials: 'include' })`——以用户 Chrome profile 的登录 cookie 发出。
  - **更正一处初步结论**：本条的 `verify` **不**调用 `hasXhsSessionCookies`。`auth.js:4-8` 定义的 cookie 名检查只被 `quickCheck`（`:45`）与 `poll`（`:48`）引用；而 `quickCheck` 的唯一消费点是 `dist/src/commands/auth.js:92-96`（`opencli auth` 命令族），**不在 whoami 执行路径上**——`_shared/site-auth.js:70` 的 `func` 是 `tryProbe(config, page, 'identity')`，`:18-21` 只取 `config.verify`。
- **exposure**：输出 `username`（创作者昵称）与 `followers`（`auth.js:34-37`），加 `_shared/site-auth.js:11` 拼上的 `logged_in`/`site`。这是「本机登录的是谁」，不是公开事实 → `personal`。返回体中**无任何 cookie / token 值**。
- **effects**：全文件无 `node:fs`（实测 grep 命中为 0）；唯一请求是一个 GET。
- **credentialFlow**：消费 `web_session` 等 cookie（经 `credentials:'include'` 隐式），不产出、不回写 → `consume`。`produce` 的那条是 `_shared/site-auth.js:73-117` 注册的 `login`（`access: 'write'`），**不在八条内**。
- **residues**：`site-auth.js:59` 声明 `siteSession:'persistent'` → `execution.js:461` 得 `'persistent'` → `:465` 会话名为跨进程同名的 `site:xiaohongshu` → `:479` `keepTab=true` → `:314` 的 `if (!keepTab) await page.closeWindow?.()` **不执行**，标签租约在扩展侧保留。这正是 `persistent-session` 的语义。

### 2.2 `xiaohongshu/feed`

| 轴 | 取值 |
|---|---|
| executionPath | `browser-bridge` |
| authorities | `['browser-profile', 'public-network']` |
| exposure | `personal` |
| effects | `[]` |
| credentialFlow | `consume` |
| residues | `[]` |

- **executionPath**：`clis/xiaohongshu/feed.js:156` 显式 `browser: true`。
- **public-network**：`feed.js:105` `page.goto('https://www.xiaohongshu.com/explore')`。
- **browser-profile**：读的是登录态 SSR 注水出来的 Pinia store（`feed.js:29-66`，`pinia._s.get('feed').feeds`）；未登录态的首页内容与登录态不同 → 输出取决于 profile 会话。
- **exposure**：首页推荐是账号个性化流；`url` 内嵌 `xsec_token`（`:88-97`、`:140`）。按口径 D 判 `personal`。
- **effects**：无 `node:fs`；**无额外网络请求**——`feed.js:1-13` 的文件头注释明写旧版那个会拉下一页推荐的 `tap`/`fetchFeeds` 已被移除，改为纯客户端 store 读。
- **credentialFlow**：不显式取 cookie；登录态经页面会话消费 → `consume`。
- **residues**：catalog `siteSession: null` → `execution.js:461` 默认 `'ephemeral'` → `:466` 会话名 `site:xiaohongshu:<uuid>`（每次运行新 UUID）→ `:480` `keepTab=false` → `:314`（成功）与 `:339`（失败）**两条路径都调** `closeWindow()` 释放租约 → `[]`。
  - 缺口照记：`closeWindow` 是 best-effort（`browser/page.js:190-202` 吞异常）。Host 超时杀进程时它根本不会运行（§4.3），租约要等扩展 30s 空闲计时器回收（`execution.js:311-313,336-338` 注释）。这是**故障路径**上的暂态，不改变正常路径取值。

### 2.3 `bilibili/whoami`

| 轴 | 取值 |
|---|---|
| executionPath | `browser-bridge` |
| authorities | `['browser-profile', 'public-network']` |
| exposure | `personal` |
| effects | `[]` |
| credentialFlow | `consume` |
| residues | `['persistent-session']` |

- **public-network**：`clis/bilibili/auth.js:12` `page.goto('https://www.bilibili.com')`；`clis/bilibili/utils.js:126-133` 的 `getNavData` 页内 fetch `api.bilibili.com/x/web-interface/nav`；`utils.js:167-176` 的 `apiGet` 拼 `https://api.bilibili.com` + `:177-185` 的 `fetchJson`。
- **browser-profile**：上述两处 fetch 均 `credentials: 'include'`（`utils.js:130`、`utils.js:181`）。
- **exposure**：输出 `id`(mid) / `username` / `level`（`auth.js:16-20`）→ `personal`。
- **effects**：全链路只有 GET；WBI 签名的 md5 走 `node:crypto`（`utils.js:148-151`），不落盘。
  - 注：`utils.js:4` import 了 `node:https`，被 `resolveBvid`（`:29-48`）用于 b23.tv 短链解析——**本命令路径不调用它**。
- **credentialFlow**：消费 `SESSDATA`/`DedeUserID` → `consume`。与 2.1 同，`verify`（`auth.js:11-21`）不走 `quickCheck`。
- **residues**：同 2.1，`siteSession:'persistent'` → 会话名 `site:bilibili`、`keepTab=true` → `['persistent-session']`。

### 2.4 `bilibili/hot`

| 轴 | 取值 |
|---|---|
| executionPath | `browser-bridge` |
| authorities | `['browser-profile', 'public-network']` |
| exposure | **`public`** |
| effects | `[]` |
| credentialFlow | `consume` |
| residues | `[]` |

- **executionPath**：见 §1.1 的派生链（`registry.js:64-65`）。pipeline 型命令仍走浏览器会话：`capabilityRouting.js:53` 因 `navigateBefore` 非 false 直接返回 true。
- **public-network**：pipeline 第 1 步 `{ navigate: 'https://www.bilibili.com' }`（`clis/bilibili/hot.js:13`）；第 2 步 evaluate 内 `fetch('https://api.bilibili.com/x/web-interface/popular?ps=...&pn=1')`（`:15-17`）。
- **browser-profile**：该 fetch 带 `credentials: 'include'`（`hot.js:16`）——**请求以登录身份发出**，故 browser-profile 成立，即使榜单内容本身不个性化。
- **exposure = public**（八条里唯一）：输出列 `rank/title/author/play/danmaku/bvid/url`（`hot.js:11`、`:29-37`），全部是站内公开视频元数据，**没有任何本机账号字段**。
  - 界线说清：`credentials:'include'` 影响的是 `authorities` 与 `credentialFlow`；`exposure` 判的是**返回体内容**，两者不联动。
  - 置信度：「返回体不含用户字段」🟢（源码可证）；「服务端不对该端点做个性化」🟡（源码证不到，也不需要——即便轻度个性化，输出仍是公开视频元数据，不构成关于用户的个人数据）。
- **effects**：pipeline 只用到 `navigate/evaluate/map/limit` 四个步骤（`hot.js:12-39`），对应 `dist/src/pipeline/registry.js:38-51` 的 handler 中 `steps/browser.js` 与 `steps/transform.js`，**均不写盘**；`download` 步骤未被使用。
- **credentialFlow**：`consume`。
- **residues**：`siteSession: null` → ephemeral + `keepTab=false` → `[]`。
- 顺带记一处无害冗余：pre-nav（`execution.js:250-264`，由 `navigateBefore=https://www.bilibili.com` 触发）与 pipeline 第 1 步 navigate 是同一 URL，扩展侧有「已在目标 URL 则跳过」的快路径（`execution.js:258-260` 注释）。

### 2.5 `twitter/whoami`

| 轴 | 取值 |
|---|---|
| executionPath | `browser-bridge` |
| authorities | `['browser-profile', 'public-network']` |
| exposure | `personal` |
| effects | `[]` |
| credentialFlow | `consume` |
| residues | `['persistent-session']` |

- **public-network**：`clis/twitter/auth.js:15` `page.goto('https://x.com/home')`。
- **browser-profile**：`auth.js:12` 调 `hasTwitterSessionCookies` → `auth.js:6` `page.getCookies({ url: 'https://x.com' })`——**本条确实显式取 cookie**（与 2.1/2.3 不同）。
- **exposure**：输出 `username` 与 `url`（`auth.js:25`）→ `personal`。
- **effects**：无 fs、无写请求。
  - 口径 B 在本条上最刺眼：`x.com/home` 是真实首页，加载即产生曝光与遥测。按口径 B 不计入 `effects`，但确认文案必须覆盖。
- **credentialFlow**：`auth.js:5-9` 只读 `auth_token`/`ct0` 的**名**（`cookies.map(cookie => cookie.name)`），不读值、不进输出 → `consume`。
- **residues**：`['persistent-session']`，同 2.1。

### 2.6 `twitter/timeline`

| 轴 | 取值 |
|---|---|
| executionPath | `browser-bridge` |
| authorities | `['browser-profile', 'public-network']` |
| exposure | `personal` |
| effects | **`[]`**（POST 判定见下） |
| credentialFlow | `consume` |
| residues | `[]` |

- **public-network**——**本条的出网面超出 catalog 声明的 `domain: x.com`，单独点名**：
  - `clis/twitter/timeline.js:188-191` 页内 fetch `/i/api/graphql/<queryId>/<endpoint>`（同源）；
  - `clis/twitter/shared.js:280` 在 x.com 页面上下文里 fetch **`https://raw.githubusercontent.com/fa0311/twitter-openapi/refs/heads/main/src/config/placeholder.json`**——第三方主机，5s abort（`shared.js:277-278`）；
  - 失败后回退：`shared.js:298-315` 扫描页面脚本，取首 15 + 尾 15 共至多 30 个 x.com 脚本包，**逐个整包 `fetch(...).text()`**。
  - 泄露面评估：该 GitHub 请求未传 `credentials`，fetch 默认 `same-origin`，跨源**不带 cookie**；泄露的是「本机 IP + 正在解析 HomeTimeline queryId」这一事实，不含账号数据。
  - **这是审定该记住的一件事**：`reviewShapeHash` 把 `domain` 写进哈希、注释说它代表「数据发往哪里」（`policy-fingerprint.mjs:69`）。本条证明 `domain` **不是**出网面的完整表达。
- **browser-profile**：`timeline.js:166` `page.getCookies({ url: 'https://x.com' })`。
- **exposure = personal**：home timeline 是本账号的个性化流。列里含他人 `bio`/媒体 URL（`timeline.js:159`），但取最高档由「这是本账号的时间线」决定。返回行中**无 ct0、无 bearer**（对照 `:159` 的 columns 与 `:80-94` 的 `extractTweet` 返回体）。
- **effects = [] —— `POST HomeLatestTimeline` 判定为查询而非变更**，四条源码依据：
  1. `--type following` 走 `POST`（`timeline.js:12`），但变量与 features 全在 **query string**（`timeline.js:62-66` 的 `buildHomeTimelineUrl`）；
  2. fetch **不带 body**（`timeline.js:189`：`fetch(url, { method, headers, credentials })`）——GraphQL mutation 必须有 body；
  3. 响应按 `data.home.home_timeline_urt.instructions` 解析（`timeline.js:99`），是时间线**读取**信封；
  4. `vars.seenTweetIds = []`（`timeline.js:57`）——该字段的用途是把「已看过的推文」回报给排序器，适配器**显式发空数组**，即主动不上报已读。
     故 `remote-write` **不成立**。POST 在此是传输方式，不是语义。
  - `clis/twitter/utils.js:85-113` 确有 fs 写（`mkdtempSync` + `writeFileSync`），但那是 `downloadRemoteImage`，`timeline.js:4` 只 import `TWITTER_BEARER_TOKEN` 与 `applyTopByEngagement`，该函数**在本命令路径上不被调用**；`utils.js:1-30` 的模块顶层全是常量声明，**无写盘副作用**。
- **credentialFlow = consume**：`timeline.js:166-169` 取 **ct0 的值**，`:173-178` 放进 `X-Csrf-Token` 头；另有内置 bearer（`utils.js:12`），按其注释是 X web 客户端自用的公共只读 token，不是用户凭据。两者都不进输出。无任何写回 cookie 的调用 → 非 `produce`/`both`。
- **residues = []**：`siteSession: null` → ephemeral + `keepTab=false`。

### 2.7 `youtube/whoami`

| 轴 | 取值 |
|---|---|
| executionPath | `browser-bridge` |
| authorities | `['browser-profile', 'public-network']` |
| exposure | `personal` |
| effects | `[]` |
| credentialFlow | `consume` |
| residues | `['persistent-session']` |

- **public-network**：`clis/youtube/auth.js:14` `page.goto('https://www.youtube.com/')`。
- **browser-profile**：`auth.js:11` 调 `hasGoogleSessionCookie` → `auth.js:5` `page.getCookies({ url: 'https://www.youtube.com' })`；并读页面内 `window.ytcfg`（`:18-19`）。
- **exposure**：输出 `name`（`INNERTUBE_CONTEXT.user.identityName` 或头像 aria-label，`auth.js:28-33`、`:38`）→ `personal`。
- **effects**：无 fs、无写请求。
- **credentialFlow**：`auth.js:6-7` 只读 `SID`/`SAPISID`/`__Secure-1PSID` 的**名** → `consume`。
- **residues**：`['persistent-session']`，同 2.1。

### 2.8 `youtube/subscriptions`

| 轴 | 取值 |
|---|---|
| executionPath | `browser-bridge` |
| authorities | `['browser-profile', 'public-network']` |
| exposure | `personal` |
| effects | `[]` |
| credentialFlow | `consume` |
| residues | `[]` |

- **executionPath**：`clis/youtube/subscriptions.js:8-18` 未声明 `browser`，由 `registry.js:65` 推得（派生链见 §1.1）。
- **public-network**：pre-nav 到 `https://www.youtube.com`（派生），再 `subscriptions.js:21` `page.goto('https://www.youtube.com/feed/channels')`。
- **browser-profile**：解析 `window.ytInitialData`（`:25`）；`/feed/channels` 只有登录态才含订阅列表，未登录时代码走 `{ error: 'YouTube data not found — are you logged in?' }`（`:26`）。
- **exposure**：输出订阅频道列表 `rank/name/handle/subscribers/url`（`:18`、`:30-44`、`utils.js:135-165`）→ 用户的订阅关系是 `personal`。
- **effects**：无 fs；`extractSubscriptionChannel` 是被 `toString()` 注入页面的纯函数（`subscriptions.js:37`、`clis/youtube/utils.js:135-165`），只读 DOM 数据。
- **credentialFlow**：不显式取 cookie，经页面会话消费 → `consume`。
- **residues**：`[]`（ephemeral + keepTab=false）。

---

## 3. 汇总表

| 命令 | executionPath | authorities | exposure | effects | credentialFlow | residues | 算法出口（现行 §4.3） |
|---|---|---|---|---|---|---|---|
| `xiaohongshu/whoami` | browser-bridge | browser-profile, public-network | personal | `[]` | consume | `[persistent-session]` | 第 9 步 → ack |
| `xiaohongshu/feed` | browser-bridge | browser-profile, public-network | personal | `[]` | consume | `[]` | 第 9 步 → ack |
| `bilibili/whoami` | browser-bridge | browser-profile, public-network | personal | `[]` | consume | `[persistent-session]` | 第 9 步 → ack |
| `bilibili/hot` | browser-bridge | browser-profile, public-network | **public** | `[]` | consume | `[]` | **第 10 步 → ready（需改，见 §6.2）** |
| `twitter/whoami` | browser-bridge | browser-profile, public-network | personal | `[]` | consume | `[persistent-session]` | 第 9 步 → ack |
| `twitter/timeline` | browser-bridge | browser-profile, public-network | personal | `[]` | consume | `[]` | 第 9 步 → ack |
| `youtube/whoami` | browser-bridge | browser-profile, public-network | personal | `[]` | consume | `[persistent-session]` | 第 9 步 → ack |
| `youtube/subscriptions` | browser-bridge | browser-profile, public-network | personal | `[]` | consume | `[]` | 第 9 步 → ack |

六轴无一处 `unknown`；无一处「证明不了」。八条的 `authorities` 完全同值；差异只落在 `exposure`（`bilibili/hot`）与 `residues`（四条 whoami）两列。

---

## 4. 运行时间契约审计

### 4.1 八条没有任何可信的长时声明

- catalog 命令级字段全集实测为 `access/aliases/args/browser/columns/command/defaultFormat/defaultWindowMode/description/domain/example/modulePath/name/navigateBefore/site/siteSession/strategy/type`——**没有 `timeout` 字段**，1278 条全体为 0。
- 八条**均未**声明名为 `timeout` 的参数（实测逐条为 false）。
- `execution.js:507-519` 的 `readUserTimeoutSeconds` 明写：命令必须自带名为 `timeout` 的 arg 才启用用户超时（`:508`），否则返回 `null`。

> 结论：**没有任何 vendored 元数据可供 Host 用来「按命令加长」。** 任何加长都是我们自己拍的数，不该挂在逐命令 metadata 上。

### 4.2 分层超时的真实叠加（三层，且层序是反的）

| 层 | 值 | 出处 | 罩住什么 |
|---|---|---|---|
| opencli adapter 闸 | **60s** | `browser/config.js:14` `DEFAULT_BROWSER_COMMAND_TIMEOUT`；用在 `execution.js:295-301` | **仅 `runCommand`**，即适配器 func/pipeline 主体 |
| opencli 连接闸 | 45s | `browser/config.js:13`；`runtime.js:40` → `bridge.connect` → `daemon-lifecycle` | daemon 拉起 + 扩展连上 |
| daemon 传输闸 | **120s**（+10s HTTP 余量） | `browser/daemon-client.js:27`、`:31` | **每一个** `navigate`/`exec`/`cookies` 单操作 |
| Host 闸 | **90s** | `server/run-manager.mjs:66,166-171` | 整个 opencli 子进程 wall clock |

**关键事实一：opencli 没有 wall-clock 总闸。** 60s 那道闸包在 `execution.js:294-301` 的 try 里，而 **pre-navigation 的 `page.goto`（`:251-264`）在它之外**，`browserSession` 的 connect（`runtime.js:39-49`）也在它之外。`bilibili/hot`、`twitter/timeline`、`youtube/subscriptions` 三条都有 pre-nav，那次导航只受 daemon 的 120s 约束。

理论最坏叠加：connect 45s + pre-nav 130s + adapter 60s + closeWindow 130s ≈ **365s**，远超 Host 的 90s。

**关键事实二：层序反了。** `daemon-client.js:19-26` 的注释写明设计意图是「失败由内向外浮现（extension < daemon < client）」。该不变式在 opencli **内部**成立，但 Host 的 90s 切在 daemon 的 120s **之下**——于是任何单个浏览器操作挂死时，**Host 先杀，opencli 的结构化错误永远来不及产生**。用户看到的是 `OpenCLI timed out after 90000ms`（`run-manager.mjs:280`），而不是「扩展未连接 / 标签失联 / profile 不匹配」。

**关键事实三：Windows 上超时路径不会做清理。** `run-manager.mjs:227` 发 `SIGTERM`、`:241-256` 2s 后 `SIGKILL`。Node 在 Windows 上没有 POSIX 信号，`kill()` 走 `TerminateProcess`，子进程无法执行任何清理 → `execution.js:314/339` 的 `closeWindow()` 不会运行，ephemeral 命令的标签租约要等扩展 30s 空闲计时器回收（`execution.js:311-313,336-338` 注释）。这是**已知行为**，不是 bug。（🟡 Windows 信号语义属 Node 平台行为，非本仓源码可证。）

### 4.3 结论与建议

**建议：不按命令加长；按 `executionPath` 分档。**

| executionPath | 建议 Host `commandTimeoutMs` | 依据 |
|---|---|---|
| `direct-node`（legacy 276 + local-direct 3） | **保持 90s** | 无浏览器传输层，90s 已宽裕 |
| `browser-bridge`（本 tier 八条） | **150s** | daemon 传输闸 120s（`daemon-client.js:27`）+ HTTP 余量 10s（`:31`）= 130s；任何单个浏览器操作最迟在 130s 内由 opencli 自己以结构化错误收尾，再留 20s 让它完成错误封装与退出 |

这个 150s **是从源码里的两个常量算出来的，不是倍数**。低于 130s 的 Host 闸都会系统性地抢在 opencli 之前杀进程、把可归因错误换成不可归因错误。

若团队坚持 90s，必须同时接受并写入已知行为：(a) browser 命令的故障归因劣化为「超时」一种；(b) 超时路径不做租约清理（§4.2 事实三）。**这不是不可接受的选择，但它是一个选择，不能当成默认。**

**另一件独立的事：`twitter/timeline` 是八条里唯一有现实概率触到 opencli 自己那道 60s 闸的。** 它的成本结构最差：pre-nav 加载 x.com SPA + `shared.js:277-280` 的 5s GitHub 超时 + 回退时最多 30 个脚本包全量下载（`shared.js:305-315`）+ 分页循环（`timeline.js:184`，`MAX_PAGINATION_PAGES=100`，每页一次 daemon 往返）。建议真机门**单独记录它的 P95 耗时**，用实测决定要不要动，不要先验加长。

顺带记一处未设防的输入：`bilibili/hot` 的 `--limit` 被直接插进 `ps=` 查询串（`hot.js:15`），而 pipeline 侧没有 `xiaohongshu/feed` 那样的 `parseLimit` 上下界校验（对照 `feed.js:18-27`）。`execution.js:48-54` 只保证它是个 Number，`--limit 1e9` 会原样发给 B 站。这是耗时风险而非安全风险，记在此处备查。

### 4.4 裁决（协调器，2026-07-30）：**保留 90s，本次不加长**

**结论：Host `commandTimeoutMs` 维持 90000ms，不按 `executionPath` 分档，不实现任何倍数规则。**

依据是 §4.1 自己查实的事实：**八条命令没有任何可信的长时声明**——catalog 无 `timeout` 字段（1278 条全体为 0），八条均未声明名为 `timeout` 的参数，`execution.js:508` 因此恒返回 `null`。本 goal 对这种情形的口径是明确的：*没有可信长时声明就保留现有 90 秒并记录结论；只有源码明确要求更长预算时才允许由 Host 侧受信策略元数据设置。*

§4.3 建议的 150s 不满足该条件，且理由方向不同：它推出的不是「这些命令需要更长时间」，而是「daemon 传输闸 120s 高于 Host 闸 90s，所以 Host 会先杀」。那是**分层超时的层序问题**，不是命令的时间需求。用一个从传输层常量算出来的数去改逐命令预算，等于把基础设施上限当成命令契约——这正是本审定在别处反复拒绝的推理形状。

**代价照单接受并记录在此**（§4.2 已论证，不重复推导）：

1. **故障归因劣化**：任何单个浏览器操作挂死时，Host 的 90s 先于 daemon 的 120s 触发，用户看到 `OpenCLI timed out after 90000ms`（`run-manager.mjs:280`）而不是「扩展未连接 / 标签失联 / profile 不匹配」。**缓解**：`GET /browser-bridge/health` 提供结构化诊断（daemon / extension / profile / 版本 / 可重试），超时后用户能自行看清是哪一层的问题——这条端点在相当程度上补回了被 90s 切掉的归因信息。
2. **超时路径不做租约清理**：Windows 上 `kill()` 走 `TerminateProcess`，`closeWindow()` 不执行，ephemeral 命令的标签租约等扩展 30s 空闲回收。这是既有行为，与本裁决无关，但一并记账。

**重新裁决的触发条件（写死，免得下次靠感觉）**：真机门实测 `twitter/timeline` 的 P95 耗时超过 90s。§4.3 已点名它是八条里唯一有现实概率触到 opencli 自己那道 60s 闸的（pre-nav SPA + 5s GitHub 超时 + 最多 30 个脚本包回退 + 至多 100 页分页）。**用实测决定，不先验加长。** 届时若确需加长，只允许由 Host 侧受信策略元数据设置，**客户端参数不得扩大 Host 上限**——这一条与 argv 白名单（§1.2 口径 F）同源：请求方不得自行放大自己的执行预算。

---

## 5. `ReviewedPolicyRecord` 数据块

按 `server/policy-metadata.mjs` 现有格式（getter 形式的 `reviewedAgainst`，理由见该文件 `:34-37`）。追加到 `REVIEWED_RECORDS` 的 Map entries 末尾即可，**无需改动既有三条**。

```js
  // ── browser-cookie-read-pilot（审定见 docs/specs/2026-07-30-browser-cookie-read-pilot-review.md）──
  // 八条共同前提：effects/residues 的取值以「Host 不放行 --trace/--site-session/--keep-tab」为条件（§1.2 口径 F）。
  ['xiaohongshu/whoami', {
    get reviewedAgainst() { return shapeOf('xiaohongshu/whoami') },
    metadata: {
      executionPath: 'browser-bridge',
      // goto creator.xiaohongshu.com + 页内 credentials:'include' 取创作者资料(clis/xiaohongshu/auth.js:11,15)。
      authorities: ['browser-profile', 'public-network'],
      // 输出 username/followers = 本机登录的是谁(auth.js:34-37)，非公开事实。
      exposure: 'personal',
      effects: [],
      credentialFlow: 'consume',
      // siteSession:'persistent' → 共享会话名 site:xiaohongshu + keepTab=true，标签租约不释放
      // (execution.js:461,465,479,314)。
      residues: ['persistent-session'],
    },
  }],
  ['xiaohongshu/feed', {
    get reviewedAgainst() { return shapeOf('xiaohongshu/feed') },
    metadata: {
      executionPath: 'browser-bridge',
      // goto /explore 后纯客户端读注水的 Pinia store，无额外请求(clis/xiaohongshu/feed.js:105,29-66)。
      authorities: ['browser-profile', 'public-network'],
      // 账号个性化推荐流；url 内嵌 note 级 xsec_token(feed.js:88-97)，按口径 D 不升 secret。
      exposure: 'personal',
      effects: [],
      credentialFlow: 'consume',
      // ephemeral 会话 + keepTab=false，成功/失败两路径都调 closeWindow(execution.js:466,480,314,339)。
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
      // pipeline: navigate + 页内 fetch popular，credentials:'include'(clis/bilibili/hot.js:13,15-17)。
      authorities: ['browser-profile', 'public-network'],
      // 八条里唯一 public：返回列全为站内公开视频元数据，无任何本机账号字段(hot.js:11,29-37)。
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
      // 出网面超出 domain=x.com：queryId 解析会打 raw.githubusercontent.com(clis/twitter/shared.js:280)，
      // 无 credentials 故不带 cookie；回退时整包下载至多 30 个 x.com 脚本(shared.js:305-315)。
      authorities: ['browser-profile', 'public-network'],
      // 本账号的个性化时间线；ct0 只进请求头不进返回行(timeline.js:173-178 vs :159)。
      exposure: 'personal',
      // POST HomeLatestTimeline 判定为查询非变更：变量在 query string、fetch 无 body、
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
      // goto /feed/channels 并解析 ytInitialData；未登录时无订阅数据(clis/youtube/subscriptions.js:21,25-26)。
      authorities: ['browser-profile', 'public-network'],
      // 用户的订阅关系列表(subscriptions.js:18,30-44)。
      exposure: 'personal',
      effects: [],
      credentialFlow: 'consume',
      residues: [],
    },
  }],
```

---

## 6. tier 允许集与状态映射建议

### 6.1 tier 定义：显式 key 集，不用派生谓词

`server/policy.mjs:64-67` 的 `tierOf` 现在只识别 `local-direct`。建议增补一支：

```js
const BROWSER_COOKIE_READ_PILOT = new Set([
  'xiaohongshu/whoami', 'xiaohongshu/feed',
  'bilibili/whoami',    'bilibili/hot',
  'twitter/whoami',     'twitter/timeline',
  'youtube/whoami',     'youtube/subscriptions',
])
```

**为什么不用派生谓词**（`browser===true && strategy==='cookie' && access==='read'`）：那会把 **496** 条一次性拉进 tier，其中 488 条随即因 `metadata-missing` 落 `unknown`。结果仍是 fail-closed，但有三处代价：tier 名字（"pilot"）与实际成员规模不符；`no-tier` 与 `metadata-missing` 两个 reasonCode 的语义被搅混；§4.1.2 L2「触碰即处置」的记账面凭空扩大 60 倍。**显式集合是「试点」的诚实表达。**

### 6.2 允许集（各轴上界）

| 轴 | 允许值 | 被挡在外的实例 |
|---|---|---|
| `executionPath` | `browser-bridge` | — |
| `authorities` | ⊆ {`browser-profile`, `public-network`} | `ambient-local-files`、`explicit-local-input`、`live-local-app`（八条均不需要；只放行实际用到的） |
| `exposure` | `public`、`personal` | `secret`（口径 D 若被推翻，`xiaohongshu/feed` 落此） |
| `effects` | **必须为 `[]`** | download / write / login 家族 |
| `credentialFlow` | ⊆ {`none`, `consume`} | `produce`、`both`（`*/login` 与 `xiaoyuzhou/*` 落此） |
| `residues` | ⊆ {`persistent-session`} | `temp-file`（trace / download 家族） |

与 `local-direct`（§4.1.1）的两处**有意放宽**，各有其代价：

- `credentialFlow` 从 `none` 放到 `consume` —— 消费浏览器登录态正是本 tier 的存在理由，不放就没有 tier。代价由 §6.4 的确认协议承担。
- `residues` 从 `[]` 放到允许 `persistent-session` —— 四条 whoami 的 `siteSession:'persistent'` 是上游写死的（`_shared/site-auth.js:59`），不可绕过。代价同上。

### 6.3 tier 准入的前置条件（不是逐命令 metadata，但没它 tier 不该开）

三条，全部来自 §1.2 的横切记账：

- **P0（阻断项）**：Host 必须对本 tier 的 argv 做**标志白名单**——只接受该命令 manifest 声明过的 flag 加 `-f json`，拒绝 `--trace` / `--site-session` / `--keep-tab` / `--window`。理由见口径 F：这些选项不进 `reviewShapeHash`，而 `policy.mjs:280-290` 今天不拦，于是 `effects:[]` 与 `residues` 是**未被 Host 兑现的承诺**，与 I-P1「绕过前端不得获得额外执行能力」直接冲突。**这一条不落地，八条不该进 ready/ack。**
- **P1**：`browser-bridge` 会 `spawn` 一个 detached、`stdio:'ignore'`、`unref` 的常驻 daemon（`browser/daemon-lifecycle.js:23-32`），它在命令结束后继续存活并监听 `127.0.0.1`。按口径 A 这不进逐条 `residues`，但它是**首次运行本 tier 任一命令的一次性副作用**，应在首次确认文案里说明。
- **P2**：扩展持有 `permissions:['cookies']` 与 `host_permissions:['<all_urls>']`（证据：随包测试 `dist/src/extension-manifest-regression.test.js:5-11`）。用户装的是一个全站 cookie 读取扩展，而非仅这四个站点的。确认文案不应把授权面说得比实际小。
  - 未证明项照记：「cookie 经扩展 `chrome.cookies` API 取、不读磁盘」——**扩展源码不在本仓**（vendored 包内无 `extension/` 目录）。本仓能证的是：opencli 的 Node 进程侧全程无任何 cookie 库读取（`page.getCookies` → `browser/page.js:185-188` → daemon `'cookies'` action），以及上述那份断言 `chrome.cookies.getAll` 所需权限的回归测试。**扩展实现本身未经本次审定。**

### 6.4 状态映射：我方倾向成立，且建议以最小改动落地

**我不反驳「`authorities` 含 `browser-profile` → 一律 `acknowledgement-required`」。补一条更强的理由：`browser-profile` 严格强于 `ambient-local-files`。**§4.3 第 9 步之所以对 `ambient-local-files` 弹窗，是因为「用户没指定读什么，程序自己去扫」；而 `browser-profile` 在此之上还多了一层——它动用的是**用户的登录态本身**，读取范围由站点会话决定，且从站点视角与用户亲自浏览不可区分（口径 B）。第 9 步写在 browser tier 存在之前，它的枚举不完整，不是它的判据错了。

**落地方式建议：改 §4.3 第 9 步本身，不加 tier 专属分支。**

```
9. authorities 含 'ambient-local-files' 或 'browser-profile'
   或 exposure==='personal' 或 residues 含 'persistent-session'
                                               → acknowledgement-required
```

三点理由：

1. **可证明是既有记录的 no-op**：三条已入库记录的 `authorities` 分别为 `[]` / `['explicit-local-input']` / `['ambient-local-files']`，`residues` 全为 `[]`（`server/policy-metadata.mjs:39-75`）——新增的两个条件在它们身上恒假。改动不会让任何已确认的命令行为变化。
2. **它修掉了本审定唯一的漏网者**：`bilibili/hot` 是 `public` + 无 persistent-session，按现行第 9 步会落 `ready` 直接放行——而它以用户登录身份打 B 站 API（`hot.js:16`）。这不该免确认。
3. `residues ∋ persistent-session` 那一支值得独立存在：跨命令保留的会话与标签租约是用户看得见的状态（浏览器里多一个不关的自动化窗口），确认时应当告知，而不是靠 `personal` 顺带覆盖。

**第 8 步不受影响**：它要求 `authorities` **恰好等于** `{explicit-local-input}`（`policy.mjs:173` 的 `sameSet`）。本 tier 的成员必含 `browser-profile`，永远命中不了第 8 步。这一点是结构保证，不需要额外防护。

**结果**：八条**全部** → `acknowledgement-required`，每条绑各自的 `decisionFingerprint`，首次确认后持久（§7 的粒度规则）。

---

## 7. daemon `/status` 字段白名单建议

`/status` 的返回体（`dist/src/daemon.js:207-237`）逐字段裁决。**先说结论：里面没有 cookie、token 或账号数据**，风险不在凭据泄露，而在标识符暴露与把回环端点细节递给 WebView。

| 字段 | 处置 | 理由 |
|---|---|---|
| `ok` | ✅ 转发 | 布尔 |
| `daemonVersion` | ✅ 转发 | 版本门与「请升级」文案需要 |
| `extensionConnected` | ✅ 转发 | 前端要区分「扩展没装/没连」与「命令失败」 |
| `extensionVersion` / `extensionCompatRange` | ✅ 转发 | 兼容性提示 |
| `profileRequired` / `profileDisconnected` | ✅ 转发 | 可操作的错误分类 |
| `pending` | ✅ 转发 | 队列深度，无标识信息 |
| `commandResultUnknown` | ✅ 转发 | 「结果未知」计数，排障有用 |
| `uptime` | ⚠️ 可转发 | 无敏感性；仅在 UI 真要显示时保留 |
| `pid` | ❌ 剔除 | 本机进程标识；前端无任何用途，却给了页面上下文一个可定位/可杀的目标 |
| `port` | ❌ 剔除 | 把 daemon 的回环端点直接递给 WebView。Host 自己已知该端口，前端不需要 |
| `memoryMB` | ❌ 剔除 | 遥测噪音，零 UI 价值；最小化原则 |
| `contextId` | ❌ 剔除（或换成 Host 侧序号） | **这是 Chrome profile 标识符**，也是 trace 目录的路径段（`observation/artifact.js:16`）。它稳定、可关联到具体浏览器 profile，且是命令路由到某个登录态的键。UI 若需区分多 profile，转发 Host 侧生成的稳定序号/别名，不转发原值 |
| `profiles[]` | ❌ 整体剔除，只转 `profiles.length` | 每项都含 `contextId` 与 `lastSeenAt`（浏览器 profile 的活动时间戳，一种行为信号）。前端目前只需要「有几个可用 profile」 |

**两条实现约束：**

1. **投影，不透传。** Host 侧构造一个固定形状的对象，逐字段挑选；**不要** `...status` 展开。否则 opencli 升级新增字段会自动流到前端，白名单当场失效——这与 §4.1.2 里 legacy artifact「禁止自动重建」是同一类失效模式。
2. **必须由 Host 代理，前端不得直连。** daemon 拒绝非 `chrome-extension://` 的 Origin（`daemon.js:173-177`）并要求 `X-OpenCLI` 头（`:203-206`），WebView 本来就打不通；这两道防线不该因为「前端要看状态」而被绕过或放宽。

---

## 8. 与初步结论的出入、残余风险与未证明项

### 8.1 出入点

| # | 初步结论 | 实测 |
|---|---|---|
| 1 | 「四条 whoami 共用 site-auth.js 的实现，各站 auth.js 只提供 quickCheck/verify/poll/columns」 | 成立，但 **`quickCheck` 不在 whoami 执行路径上**——它的唯一消费点是 `dist/src/commands/auth.js:92-96` 的 auth 命令族。whoami 只跑 `verify`（`_shared/site-auth.js:18-21,70`）。因此「quickCheck 读 cookie 名」不能作为 whoami 的 credentialFlow 证据；真正显式取 cookie 的只有 `twitter/whoami`、`youtube/whoami`（各自 `verify` 内自行调用）与 `twitter/timeline` |
| 2 | 「八条均无 node:fs 写入」 | 结论对，但推导要补一步：`clis/twitter/utils.js:1,104,111` **确有** fs 写。它在 `downloadRemoteImage` 里，`timeline.js:4` 未 import 该函数、路径上不调用，且模块顶层无副作用 |
| 3 | 「trace 文件只在 --trace 开启时产生」 | 对（`execution.js:191,229-240`；默认 off 见 `commanderAdapter.js:49`）。**但「默认关」只由前端 `buildArgv` 保证，Host 不拦 `--trace on`**（口径 F）。这是本次发现的 P0 缺口 |
| 4 | 「输出仅 stdout」 | 对，但**每次运行**还有一条与命令无关的写盘：`main.js:126` → `update-check.js:36-43` 写 `~/.opencli/update-check.json`（24h TTL），并出网打 npm 与 GitHub。按口径 A 不计入 `effects`，但必须记账 |
| 5 | 「执行链 … cookie 经扩展 chrome.cookies API 取，不读磁盘」 | Node 侧不读磁盘 ✅ 可证。**「扩展用 chrome.cookies」在本仓证不到**——扩展源码不在 vendored 包内；能引用的只有随包回归测试 `dist/src/extension-manifest-regression.test.js:5-11` |
| 6 | 「timeout：… runtime 上限 60s；daemon 传输 120s，连接 45s」 | 三个数字全对。**但 60s 只罩 adapter 主体，pre-nav 与 connect 都在它之外**（`execution.js:251-264` vs `:294-301`；`runtime.js:39-49`），故 opencli 没有 wall-clock 总闸 |
| 7 | （未提及） | **`twitter/timeline` 会打 `raw.githubusercontent.com`**（`clis/twitter/shared.js:280`），出网面超出 catalog 声明的 `domain: x.com`。这同时是对 `reviewShapeHash` 里 `domain` 字段语义的一处更正——它不是出网面的完整表达 |
| 8 | （未提及） | `bilibili/hot` 是八条里唯一的 `exposure: public`，在现行 §4.3 第 9 步下会**直接 ready 免确认**，尽管它以登录身份打 API。§6.4 的第 9 步改写正是为堵这个口 |

### 8.2 残余风险

| 风险 | 处置 |
|---|---|
| Host 不拦运行时全局选项 → `effects`/`residues` 承诺无法兑现 | §6.3-P0，**阻断项** |
| 页面自发遥测推进服务端已读/推荐状态 | 口径 B：不进 metadata，**进确认文案** |
| `xsec_token` 的 secret/personal 界线 | 口径 D：判 `personal`，推翻路径已写明 |
| Host 90s 抢在 daemon 120s 之前，故障归因劣化 | §4.3：建议 browser-bridge 档改 150s；坚持 90s 则记为已知行为 |
| 超时/取消路径不释放标签租约（Windows） | §4.2 事实三：依赖扩展 30s 空闲计时器，记为已知行为 |
| 扩展持 `<all_urls>` + `cookies` 权限，且其实现未经审定 | §6.3-P2：确认文案如实说明；扩展本体审定是独立课题 |
| 首条 browser 命令拉起常驻 detached daemon | §6.3-P1：一次性副作用，首次确认文案说明 |
| `bilibili/hot` 的 `--limit` 无上界 | §4.3 末段：耗时风险，真机门观察 |

### 8.3 未证明项（明确不猜）

1. **扩展侧实现**：cookie 获取方式、会话/租约的内存或持久化形态、30s 空闲计时器的实际行为——源码不在本仓，本次未审定。
2. **服务端行为**：B 站 `popular` 端点是否对登录用户做个性化；各站对本 tier 请求产生的服务端痕迹的具体形态。源码证不到，也不影响本次六轴取值（理由见 §2.4 与口径 B）。
3. **`twitter/timeline` 回退路径的实际触发率**：`raw.githubusercontent.com` 是否被 x.com 的 CSP 拦掉，决定它走 5s 超时还是走 30 包扫描。这是耗时问题，需真机实测，不做先验假设。
