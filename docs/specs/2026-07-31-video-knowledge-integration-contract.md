# video-knowledge 接入契约（准备阶段，不含实现）

本文档只做一件事：把「爪爪要接 video-knowledge」这件事的**已知事实、契约形状、以及三个必须先决策的问题**写下来。它**不指定 UI**，也不承诺工期——因为对接目标当前仍在快速演进，先画 UI 是对着移动靶开枪。

调查时间 2026-07-31，对照 commit：`main@caefe21`、`integration/m1-productization@4583bf4`。

---

## 0. 首要更正：目标不是 `Developer/video-knowledge`

最初指定的路径 `C:\Users\Lauseusing\Developer\video-knowledge` 是 **`main` 分支**，其上**没有任何对外集成面**——只有一条 `ingest` 子命令，输出是四行 `key=value` 文本，非 JSON。

真正该对接的是同机 worktree：

```
C:\Users\Lauseusing\Developer\video-knowledge-m1-productization   [integration/m1-productization]
```

实测差距：**182 commits / 339 files / +94,145 −2,914 行**。集成所需的 `desktop.py`、`web_ui.py`、`exit_codes.py` 三个文件在 main 上**一个都不存在**（已逐个核对）。

> **这条不解决，后面全是空谈。** 见 §5 决策 1。

---

## 1. 对方已经为「外部 shell 接入」写好了一层

这不是我们要去适配一个不友好的 CLI —— `desktop.py` 的文件头明确写着它是给 "a native or web shell" 用的 job/view-model API。可用的接口有三种：

### 1.1 常驻 HTTP（推荐）

```
video-knowledge gui --root <data> --host 127.0.0.1 --port 0 --no-browser
```

启动后向 stdout 打印一行 `gui=http://127.0.0.1:<port>`。服务端 `web_ui.py`：

- **强制只绑回环**：host 非 `127.0.0.1`/`localhost` 时直接 raise（`web_ui.py:107`）
- 启动时生成 `secrets.token_urlsafe(32)`，写操作要 `X-VK-Token` 头 + same-origin 检查（`:161-165`）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/preview` | 预览将要执行的 ProcessingRequest |
| POST | `/api/jobs` | 提交任务 → `201 {job_id, kind}` |
| GET | `/api/jobs/<id>` | 轮询状态（返回完整 view JSON） |
| POST | `/api/jobs/<id>/cancel` | 协作式取消 |
| POST | `/api/jobs/<id>/retry` | 同参重跑 |
| GET | `/api/outputs/<id>/<key>` | 取产物字节（含 root 逃逸校验） |
| POST | `/api/uploads` | 上传 .srt/.vtt/.json，≤8 MiB |
| POST | `/api/query` | 带引用的检索问答 |
| GET | `/api/diagnostic` | YouTube CDP 会话诊断 |

**已知需要对方改一行**：token 目前只注入 GET `/` 返回的 HTML（`web_ui.py:190`），没有单独的获取端点。三种解法——(a) 我方 GET `/` 正则抠出来（丑，但零改动）；(b) 让 `_run_gui` 把 token 也打到 stdout（改 1 行，最干净）；(c) 支持 `VK_UI_TOKEN` 注入。**建议 (b)**，需对方仓配合。

### 1.2 一次性子进程

```
video-knowledge desktop "<URL>" --preset course-learning --root <data> --json
```

stdout 输出完整 JSON view，exit code 是稳定枚举（`exit_codes.py:6`，已核对源码）：

`0 OK / 1 ERROR / 2 USAGE / 3 PARTIAL / 4 CONFIGURATION / 5 DEPENDENCY_MISSING / 6 BUDGET_EXCEEDED / 7 CAPABILITY_UNAVAILABLE`

映射由 `exit_code_for_exception()` 按**异常类型**完成，不依赖文本——这点很重要，意味着我方可以按码分派而不必解析人读输出。

**但这条路对本场景不可用**：单条视频实测耗时 **10–30 分钟**（见 §2），期间无进度、无取消。除非我方自己去读 `vk.db` 的 `stage_runs` 表补进度——那等于绕开对方的接口去读它的私有存储，不接受。

### 1.3 直接 import（不建议）

依赖树含 torch / funasr / onnxruntime。打包体积与跨平台构建会失控，且丧失进程隔离。**排除。**

---

## 2. 时间与成本的量级——这决定 UI 形态

对方 `docs/M0-ACCEPTANCE.md` 的真机三集实测：

| 内容 | 视频时长 | 处理耗时 | 成本 |
|---|---|---|---|
| 中文课程 | 68 min | **27.4 min** | ¥1.06 |
| 英文科普 | 16 min | **16.8 min** | ¥0.25 |
| 中文访谈 | 34 min | **8.3 min** | ¥0.46 |

**结论：每条 10–30 分钟、¥0.2–1.1。** 三个直接后果：

1. **必须是异步 job 模型**，不能同步等——这排除了 §1.2。
2. **必须能取消**，且取消要在 UI 上显式可达（对方是协作式取消，`pipeline/control.py`）。
3. **花钱这件事必须在提交前告知**。这与本仓既有的 acknowledgement 协议是同一类问题：用户点一下就产生真实费用，不能默默发生。**建议复用 acknowledgement 的思路**，但这是一条独立的确认（金额与预算档，不是数据授权），不要挤进现有那个对话框。

**进度粒度的坏消息**：对方**没有进度回调 / 事件流 / NDJSON**（已 grep 确认）。只能轮询 `/api/jobs/<id>` 拿粗状态（`queued → running → done|partial|failed|cancelled|…`）。所以我方 UI 上不该画百分比进度条——**画不出来就别画**，用阶段名 + 已耗时更诚实。

---

## 3. 运行前提清单（这是接入的真正成本所在）

**必须**
- Python ≥ 3.12 + `uv sync --extra dev`
- `config/providers.local.toml`（由 `.example` 复制）：三档模型 `model_id` + `base_url`。**`base_url` 必须带 `/v1`**——对方文档记录过漏掉后返回 HTML 首页、报出无关 JSON 解析错的真实踩坑
- 环境变量 `VK_RELAY_API_KEY`（可分档）
- 网络（中转站 LLM 调用）

**按需**
- `yt-dlp` 在 PATH
- **YouTube 需要手动起一个带 `--remote-debugging-port=9224` 的专用 Chrome 并登录**，设 `VK_CHROME_CDP_URL`
- 无字幕视频 → `--extra media-asr`（FunASR + torch + RapidOCR，很重）+ ffmpeg/ffprobe
- GPU 不需要（对方 M2a/M2b 验收明确 CPU-only）

约 35 个 `VK_*` 环境变量（`composition.py:91`）。

---

## 4. 与本仓既有约束的关系

| 本仓不变式 | 对 video-knowledge 接入意味着什么 |
|---|---|
| **I-P1 Host 是执行准入唯一权威** | video-knowledge 是**另一个执行器**，不走 OpenCLI Host。它需要**自己的准入表达**，不能默认沿用 OpenCLI 的判决——那套判决描述的是 opencli 命令，与这里无关。**不要把它硬塞进 `decisionByKey`。** |
| **I-P6 冻结契约（shell:false 等）** | 若走 sidecar，spawn 必须同样 `shell:false`、参数不经 shell 展开、只允许白名单参数。现成的 `host_supervisor.rs` 已有这套姿势（Job Object + stdin EOF 看门狗），**应复用其监管模式**，而不是新写一套进程管理。 |
| **I-P7 参数值不落盘** | 视频 URL 是用户输入，且可能是私密链接。job 历史若要持久化，**URL 属于 values 一类**，同样不该落盘；只存 job_id 与状态。 |
| 桥接健康诊断（`/browser-bridge/health`） | 对方的 `diagnose --json` 返回 `configured/endpoint_status/session_state/reason_code/action` 五元组，形状与我方健康诊断高度同构。**接入时应做同样的字段投影**，不透传。 |

---

## 5. 三个必须先决策的问题（未决之前不写实现）

**决策 1 · 对着哪个分支集成。**
`main` 无集成面，必须用 `integration/m1-productization`。但那条分支上还有 8 个活跃 worktree 在并行演进，接口可能继续动。需要先确认它的**合入计划**——否则我方是在对着移动靶开枪。
> 建议：等它合入 main，或由对方给出「集成面已冻结」的明确承诺。

**决策 2 · Python 运行时怎么随桌面应用分发。**
`uv` 装的 `.venv` 不可搬移。三条路：(a) 要求用户自行安装（onboarding 成本高，但零打包工作）；(b) 打 wheel + `uv tool install`（对方仓已有 `test_product_cli_install.py` 验证干净 wheel 安装，这条路是通的）；(c) PyInstaller 打包（体积失控风险，含 torch 时尤甚）。
> 倾向 (b)，但需实测装机体积。

**决策 3 · YouTube 的 Chrome CDP 前提怎么引导。**
需要用户手动起一个带远程调试端口的专用 Chrome 并登录——这在桌面应用里是刺眼的 onboarding 步骤。对方的 `diagnose --json` 正好可以驱动向导。
> 注意：这与本仓 OpenCLI 的 Browser Bridge 是**两套不同的浏览器接入机制**，用户可能要装两次、登两次。这个重复体验必须在设计阶段解决，不能留给用户自己困惑。

---

## 5.5 已定：提交视频任务前必须弹一次费用确认（2026-07-31 拍板）

**结论：要弹。** 用户已确认。

**为什么这条要单独定下来，而不是等写 UI 时顺手加。** 本应用现有的唯一防误操作机制是
acknowledgement 确认协议，而那套协议**管不到这件事**——它的六根轴（authorities / exposure /
effects / credentialFlow / residues / executionPath）描述的是「这条命令碰了什么数据」，
里面没有任何一根表达「这次点击会花多少钱、跑多久」。

vk 的 job 有两个 opencli 只读命令完全没有的性质：

- **真的花钱**：实测 ¥0.2–1.1 一条（对方 M0 真机验收数据）
- **跑 10–30 分钟**：期间无法从界面判断它在干什么（对方无进度事件流）

**如果先做 UI 再补确认，「点一下就扣钱」会先成为默认行为**，之后再加反而像是在给用户添麻烦。
所以先立规矩。

**这条确认的形状（与 acknowledgement 分开，不复用）**：

| 项 | 决定 |
|---|---|
| 触发时机 | 提交 job 前，每次都弹（不是"记住我的选择"——金额随视频长度变，记不得） |
| 必须显示 | 预估费用区间、预估耗时区间、以及这两个数**是估算不是承诺** |
| 数据来源 | `GET /api/preview` 的 ProcessingRequest 预览（对方已有该端点） |
| 不复用 acknowledgement 的理由 | 那是一次性授权（"允许执行一次"后持久保存）；费用确认必须每次都问 |
| 存储 | **不存**。没有"下次不再提示"——那正是这道防线要防的 |

**未决、留给实现阶段**：预估值算不准时怎么显示（对方的 preview 端点给不给费用估算，
待 P-int-1 实测）。若给不出估算，退化为"这类任务通常 10–30 分钟、¥0.2–1.1"的**区间告知**，
而不是隐去不说。

---

## 6. 准备阶段的建议范围（本 goal 不实现）

在三个决策落定前，能做且不会白做的只有一件事：**一个接入自检页面**——检查 video-knowledge 是否可用、在哪个分支、Python/uv 是否就位、配置文件与 key 是否齐、YouTube CDP 会话是否连上。它只消费 `diagnose --json` 与文件存在性，**不依赖任何可能变动的 job API**。

明确不做：job 提交 UI、进度展示、产物浏览。这些都绑在 §5 决策 1 的答案上。

---

## 附：本文档的事实来源

所有断言均经本机实测或源码逐行核对，非推测：分支差距用 `git diff --shortstat` 实测；`desktop.py`/`web_ui.py`/`exit_codes.py` 在 main 上不存在经 `ls` 逐个确认；token 注入点、exit code 枚举、gui stdout 行均已读源码原文；耗时与成本引自对方 `docs/M0-ACCEPTANCE.md` 的真机验收记录。
