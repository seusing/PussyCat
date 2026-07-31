# video-knowledge（爪爪）接入计划

基于同日契约 `docs/specs/2026-07-31-video-knowledge-integration-contract.md`。
本计划由 video-knowledge 侧维护方代表两仓拍板：契约提出的三个未决决策在 §2 给出
解法与 vk 侧承诺；契约中的事实与约束不再复述，只引用。

对照：本仓 `p1b0/policy-protocol-spec`；vk 仓 `integration/m1-productization@a921215`
（契约调查时为 4583bf4，此后仅 docs/评审补强，集成面文件 `desktop.py`/`web_ui.py`/
`exit_codes.py` 零改动——冻结承诺见 D1）。

---

## 1. MVP 范围裁定（先立靶再开枪）

**MVP 语料入口 = 小红书链接 + 本地文件。YouTube 后置。**

依据：用户真实语料是 10 条帕鲁 XHS 视频；vk 侧已实测 XHS 匿名采集 3/3 过门
（yt-dlp extractor，零 cookie 零 CDP，`docs/evidence/xhs-acquisition-matrix.v1.json`），
入库全链 10/10 跑通（爪爪要接的就是这条已验证链）。YouTube 才需要 CDP 专用
Chrome——把契约决策 3 的整个 onboarding 难题移出 MVP。

MVP 能力面：提交 job（XHS URL / 本地媒体+字幕）→ 状态/取消/重试 → 产物浏览
（笔记六件套）→ 检索问答（带引用）。不含：YouTube 登录态、M3b、批量 manifest。

## 2. 三个决策的解法

**D1 · 对着 `integration/m1-productization` 的冻结集成面开发，不等 main 合入。**
main 合入绑在最终签发上（external_deferred，时间不可依赖）。vk 侧承诺（由本人执行，
见 §7）：把 shell 集成面显式冻结成契约——HTTP 路由表、exit code 枚举、
`gui=`/`token=` stdout 行、token 头与 same-origin 规则——落
`docs/SHELL-INTEGRATION-CONTRACT.md` + 契约测试锁形状 + 本地 tag `vk-shell-v1`。
此后集成面只做加法；破坏性改动需先改契约文档并升 tag。爪爪按 tag 对齐，不追 HEAD。

**D2 · Python 分发走 wheel + uv（契约选项 b），应用零打包 Python。**
onboarding 向导驱动：uv 单文件二进制（~20 MB，可随应用带）→
`uv tool install` 干净 wheel（vk 侧已有外部 venv 安装冒烟验证）。
`media-asr` extra（torch 栈，3–5 GB）单列为向导内可选步——但如实标注：
**XHS 视频无字幕轨，走 XHS 就必须装**。真实装机体积在 P-int-1 实测出数并回填此处。

**D3 · CDP 向导整体后置（随 YouTube 场景）。**
后置期用 `/api/diagnostic` 五元组驱动向导（契约 §4 已确认与本仓健康诊断同构）；
与 Browser Bridge 的"双浏览器双登录"体验冲突在那一期一并设计。MVP 自检页仅把
CDP 显示为灰色"未配置（YouTube 场景才需要）"。

## 3. 架构与数据流

```
React(zustand) ── Tauri IPC ──► sidecar 监管（复用 host_supervisor.rs 姿势：
   │                            Job Object / shell:false / 白名单参数）
   │                              │ spawn: video-knowledge gui --root <data>
   │                              │        --host 127.0.0.1 --port 0 --no-browser
   │                              ▼ 解析 stdout: gui=<url> / token=<t>（vk 新增行）
   └── fetch ──► node server 内 vk-proxy ──(X-VK-Token, 回环)──► vk web_ui HTTP
                 （复用 browser-bridge-health 的字段投影模式；前端永不直连 vk 端口，
                  token 不进前端，绕开 same-origin 与 token 暴露两个问题）
```

生命周期：首次用到时拉起；空闲 N 分钟关停（stdin EOF 看门狗同款）；崩溃自动重启
并给 UI 一条可见事件。vk 数据目录 `<appdata>/爪爪/video-knowledge-data`，与应用
自身存储分离。

## 4. 阶段计划

**P-int-0 · 自检页 + vk 侧冻结（可立即开工，零 job API 依赖）**
- 本仓：契约 §6 的自检页——五项灯：vk 安装与版本 / uv+Python / config+key 存在性
  （只测存在，不读值）/ ffmpeg+yt-dlp / CDP（灰）。数据源：文件存在性 +
  `diagnose --json`。
- vk 仓（§7 清单）：token stdout 行、契约文档、契约测试、tag `vk-shell-v1`。
- 验收：自检页在「全绿」「缺 key」「未安装」三种真机状态下显示正确；vk 契约测试绿。

**P-int-1 · sidecar 监管 + 代理层**
- 监管器（Rust，host_supervisor 模式复用）+ node server `vk-proxy` 路由
  （/vk/jobs 等 → 回环转发，健康端点做字段投影不透传）。
- 首个联调测试项：node 侧无 Origin 请求过不过 vk 的 same-origin 检查（契约遗留
  疑点）；不过则 vk 侧在契约内补"无 Origin 视为同源"一行并升契约测试。
- 验收：伪 vk（脚本化 stdout + HTTP stub）下监管器全生命周期单测绿；真 vk 拉起/
  关停/崩溃重启冒烟各一次；装机体积实测数回填 D2。

**P-int-2 · Job UI（MVP 主体）**
- 提交：XHS URL / 本地文件 + preset 选择 + **费用确认对话框**（显示金额区间与预算档；
  独立确认，不并入既有 acknowledgement 对话框——契约 §2.3）。
- 运行中：job 列表轮询 `/api/jobs/<id>`，展示**阶段名 + 已耗时**（明确不画百分比，
  契约 §2 progress 结论）；取消、失败重试可达。
- 完成：产物六件套浏览（`/api/outputs`）；检索页（`/api/query`，引用可展开跳原文）。
- 不变式：URL 按 I-P7 不落盘——job 历史只存 job_id/状态/耗时/成本；vk 是独立执行器
  （I-P1），其费用确认协议自成一套，不进 `decisionByKey`。
- 验收：一条真实 XHS 短链端到端（提交→费用确认→运行→产物→查询），中途真实取消一次
  + 重试一次；成本数字与 vk 台账一致。

**P-int-3 · Onboarding 向导**
- uv/wheel 安装步 → `providers.local.toml` 由模板生成（`base_url` 校验必须带 `/v1`，
  契约 §3 踩坑）→ key 指导用户设环境变量（**应用不存储、不中转 key，只做存在性
  检查**）→ media-asr 可选步（带体积与"XHS 必装"提示）。
- 验收：全新 Windows 用户目录从零走完向导后，P-int-2 的端到端用例直接通过。

依赖关系：P-int-0 与本仓当前 p1b0 工作互不阻塞；P-int-1 依赖 P-int-0 的 vk 冻结；
P-int-2 依赖 P-int-1；P-int-3 可与 P-int-2 并行开发、最后串验收。

## 5. 风险清单

| 风险 | 处置 |
|---|---|
| vk 集成面漂移 | D1 冻结契约 + 契约测试 + tag；爪爪只对 tag |
| same-origin 检查拒掉 node 代理 | P-int-1 首个联调项，vk 侧留了契约内修正路径 |
| media-asr 体积劝退 | 向导单列可选步 + 如实体积标注；不装则只支持带字幕语料 |
| vk 端 job 并发行为未知 | P-int-1 实测（预期串行队列），UI 按排队语义展示 |
| 双浏览器双登录体验（YouTube 期） | 后置到 D3 那一期设计，MVP 不触碰 |
| 端口/实例冲突 | `--port 0` 随机口 + 监管器单实例锁 |

## 6. vk 侧配套改动清单（由 vk 侧维护方执行，每项 ≤ 半天）

1. `_run_gui` stdout 增打 `token=<t>` 一行（契约 §1.1 方案 b）。
2. `docs/SHELL-INTEGRATION-CONTRACT.md`：路由表、exit codes、stdout 行、token/
   same-origin 规则、job 状态机、"只加不破"承诺与升版规则。
3. 契约测试（锁路由存在性、exit code 枚举值、stdout 行格式、无 Origin 请求语义）。
4. 本地 tag `vk-shell-v1`（随其一致性门与全量回归绿一起打）。

## 7. 验收总则

沿用两仓共同纪律：每阶段真实证据（命令+输出）、可回滚提交、费用一律先确认后发生、
key 永不入库不入日志。本文档为计划；实现按阶段各起 goal/任务，不在本文档内展开。
