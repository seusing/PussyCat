//! 受管 Node Host 子进程的 supervisor(spec §4 启动协议 / §5 双通道清理)。
//!
//! 五条不可协商的不变式,改动本文件前先读:
//!
//! * **I1** spawn 后**立即** `AssignProcessToJobObject`(job 带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)
//!   —— 主进程消亡(含崩溃/被 `taskkill /F` 强杀)时由**内核**连坐整棵子树,不依赖任何代码还能运行。
//! * **I2** stdin 管道**保持打开且从不写入** —— Host 侧(`OPENCLI_HOST_PARENT_WATCH=1`)监听 EOF 自退。
//!   父进程一消失写端即关闭,这条**不依赖 Job**,覆盖 Job 分配失败的场景。
//! * **I3** Job 分配失败 → 记录降级继续(靠 I2);若 **I2 也不可用** → **fail-closed 不启动**,
//!   绝不留无主子进程(错误路径一律先 kill 再返回)。
//! * **I4** **持续排空 stdout/stderr 直到进程退出** —— 读到 readiness 行就停会把管道灌满、
//!   背压死锁子进程。两个排空线程读到 EOF 才结束,判定行只是"顺路"抄一份送回主线程。
//! * **I5** 五分支各自可辨:`NodeMissing` / `NodeTooOld` / `HostReportedFailure` /
//!   `ReadinessTimeout` / `ProcessFailed`,文案与日志不得混为一谈。
//!   (`SupervisionUnavailable` 是第六个变体,专收 I3 的 fail-closed —— 它不属于 readiness 判定的
//!   五分支,单列是为了不把"我们拒绝托管"伪装成"Host 挂了"。)

// 本模块的进程清理保证**只在 Windows 成立**,这不是"暂未适配",是硬约束:
// 通道 1(Job Object KILL_ON_JOB_CLOSE)是 Windows 内核语义,别的平台没有等价物;
// `kill_tree` 也只有 taskkill 一种实现。放一个恒返回 Err 的空壳去"支持"其它平台,
// 结果是 Host 崩了以后 opencli 孙进程成真孤儿 —— 那比编译不过危险得多。
// 要支持别的平台,先实现等价的进程组/子树回收(POSIX 上是 setsid + killpg),再删这条。
#[cfg(not(windows))]
compile_error!(
    "host_supervisor 仅支持 Windows：Job Object 连坐与 taskkill 收树都没有跨平台等价物，\
     缺了它们 opencli 孙进程会成为无主孤儿。先实现等价的子树回收再放开本平台。"
);

use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// 与 `@jackwener/opencli` 的 `engines` 持平(server/index.mjs 同门槛)。
pub const NODE_MIN_MAJOR: u32 = 20;
/// 用户可见文案:20 已 EOL,是"最低可运行"而非推荐。
pub const NODE_REQUIRED: &str = ">= 20（推荐当前 LTS 22 / 24）";

const READY_MARKER: &str = "opencliHostReady";
const READINESS_TIMEOUT: Duration = Duration::from_secs(15);
/// `node --version` 的时限。它跑在 setup 钩子里,**没有时限就等于可能永久白窗**;
/// READINESS_TIMEOUT 只管 start_host,管不到探测这一步。
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// 进程已退出后再等排空线程交货的兜底窗口(正常是零等待)。
const PIPE_COLLECT_TIMEOUT: Duration = Duration::from_secs(1);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const STDERR_TAIL_LINES: usize = 40;

/// Windows: 子进程不弹控制台窗口(release 下主进程是 windows 子系统,没有可继承的控制台)。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---------------------------------------------------------------------------
// 错误分支(I5)
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum HostStartError {
    /// ① 起不来 node 本身(不存在/不可执行)。
    NodeMissing { detail: String },
    /// ② 预探测到的 node 版本低于门槛。
    NodeTooOld { found: String, required: &'static str },
    /// ③ **协议内**失败:Host 自知的失败(catalog 缺失、端口占用……),`{"opencliHostReady":false}`。
    HostReportedFailure { summary: String, detail: Option<String> },
    /// ④ 超时:进程还活着但迟迟不给判定行。
    ReadinessTimeout { stderr_tail: String },
    /// ⑤ 进程异常:提前退出,或判定行 JSON 非法/缺字段。
    ProcessFailed { code: Option<i32>, stderr_tail: String },
    /// ⑥ 非 readiness 分支:supervisor 自身无法安全托管(双通道皆失效等)→ fail-closed。
    SupervisionUnavailable { detail: String },
}

impl HostStartError {
    /// 稳定的机器可读 kind,供错误视图路由(T6)与日志过滤用。
    pub fn kind(&self) -> &'static str {
        match self {
            Self::NodeMissing { .. } => "node-missing",
            Self::NodeTooOld { .. } => "node-too-old",
            Self::HostReportedFailure { .. } => "host-reported-failure",
            Self::ReadinessTimeout { .. } => "readiness-timeout",
            Self::ProcessFailed { .. } => "process-failed",
            Self::SupervisionUnavailable { .. } => "supervision-unavailable",
        }
    }
}

impl fmt::Display for HostStartError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NodeMissing { detail } => write!(f, "未找到可执行的 Node：{detail}"),
            Self::NodeTooOld { found, required } => {
                write!(f, "Node 版本过低：检测到 {found}，需要 {required}")
            }
            Self::HostReportedFailure { summary, detail } => match detail {
                Some(detail) => write!(f, "Host 启动失败：{summary}\n{detail}"),
                None => write!(f, "Host 启动失败：{summary}"),
            },
            Self::ReadinessTimeout { stderr_tail } => {
                write!(f, "Host 启动超时（{}s）\n{stderr_tail}", READINESS_TIMEOUT.as_secs())
            }
            Self::ProcessFailed { code, stderr_tail } => {
                write!(f, "Host 异常退出（退出码 {code:?}）\n{stderr_tail}")
            }
            Self::SupervisionUnavailable { detail } => {
                write!(f, "无法安全托管 Host 进程，已拒绝启动：{detail}")
            }
        }
    }
}

impl std::error::Error for HostStartError {}

// ---------------------------------------------------------------------------
// Job Object(I1)
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod job {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// 带 `KILL_ON_JOB_CLOSE` 的匿名 Job。**句柄活着 = 子树活着**;句柄一关(正常 drop 或
    /// 进程消亡时由内核回收),内核连坐杀光 job 里的所有进程。
    pub struct KillOnCloseJob(HANDLE);

    // HANDLE 是裸指针 newtype 故不自动 Send/Sync。这里持有的是内核对象句柄:
    // 内核对象本身线程安全,我们只在 Drop 里 CloseHandle 恰一次,跨线程移动/共享无 UB。
    unsafe impl Send for KillOnCloseJob {}
    unsafe impl Sync for KillOnCloseJob {}

    impl KillOnCloseJob {
        pub fn create() -> Result<Self, String> {
            unsafe {
                let handle = CreateJobObjectW(None, PCWSTR::null())
                    .map_err(|e| format!("CreateJobObjectW 失败: {e}"))?;
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let set = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if let Err(e) = set {
                    let _ = CloseHandle(handle);
                    return Err(format!("SetInformationJobObject(KILL_ON_JOB_CLOSE) 失败: {e}"));
                }
                Ok(Self(handle))
            }
        }

        pub fn assign(&self, process: *mut core::ffi::c_void) -> Result<(), String> {
            unsafe {
                AssignProcessToJobObject(self.0, HANDLE(process))
                    .map_err(|e| format!("AssignProcessToJobObject 失败: {e}"))
            }
        }
    }

    impl Drop for KillOnCloseJob {
        fn drop(&mut self) {
            // 关句柄 = 触发 KILL_ON_JOB_CLOSE。正常退出路径下此时子进程早已自己走完。
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

fn raw_process_handle(child: &Child) -> *mut core::ffi::c_void {
    use std::os::windows::io::AsRawHandle;
    child.as_raw_handle()
}

// ---------------------------------------------------------------------------
// 句柄
// ---------------------------------------------------------------------------

/// 已就绪的 Host。**字段顺序即析构顺序**:先 stdin(通道 2)、再 child、最后 job 句柄
/// (通道 1 作最终保险)。即便调用方忘了 `shutdown`,drop 也不会留下无主进程。
///
/// ⚠️ 但**直接 drop 不等于优雅退出**:drop 只是关 stdin 后立刻关 job 句柄,内核当场硬杀,
/// Host 来不及 `app.close()` —— 在途 run 与 SSE 连接会被直接斩断。想要优雅收尾必须走
/// [`shutdown`],它会先给 Host 2s 自己走完。drop 是**兜底**,不是等价路径。
pub struct HostHandle {
    pub port: u16,
    pub pid: u32,
    pub opencli_version: Option<String>,
    pub policy_commands: Option<u64>,
    /// Host 自报的通道 2 事实(readiness 行里的 `parentWatch`)。
    parent_watch: bool,
    /// **永不写入**(I2):它的存在本身就是"父进程还活着"的信号。
    stdin: Option<ChildStdin>,
    child: Child,
    job: Option<job::KillOnCloseJob>,
    stderr_tail: StderrTail,
}

impl HostHandle {
    /// 通道 1 是否真的生效(false = 已降级为 stdin EOF 单通道)。
    pub fn job_attached(&self) -> bool {
        self.job.is_some()
    }

    /// 通道 2 是否真的生效:我们握着写端 **且** Host 自报看门狗已挂上。
    pub fn parent_watch_attached(&self) -> bool {
        self.stdin.is_some() && self.parent_watch
    }

    /// 最近若干行 stderr —— Host 启动后崩了也能诊断。
    pub fn stderr_tail(&self) -> String {
        self.stderr_tail.snapshot()
    }
}

// ---------------------------------------------------------------------------
// stderr 尾部环形缓冲
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct StderrTail(Arc<Mutex<VecDeque<String>>>);

impl StderrTail {
    fn push(&self, line: String) {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if guard.len() >= STDERR_TAIL_LINES {
            guard.pop_front();
        }
        guard.push_back(line);
    }

    fn snapshot(&self) -> String {
        let guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        guard.iter().cloned().collect::<Vec<_>>().join("\n")
    }
}

// ---------------------------------------------------------------------------
// readiness 判定
// ---------------------------------------------------------------------------

enum Verdict {
    Ready {
        port: u16,
        reported_pid: Option<u32>,
        opencli_version: Option<String>,
        policy_commands: Option<u64>,
        /// Host **自报**的通道 2 事实:stdin EOF 看门狗是否真的挂上了。
        /// 缺字段一律当 false —— 老版本 Host(没这个字段)就是没有看门狗,不能乐观默认。
        parent_watch: bool,
    },
    /// 协议内失败(分支③)。
    Failed { summary: String, detail: Option<String> },
    /// 含 marker 但 JSON 非法/缺字段(分支⑤)。
    Malformed { reason: String, line: String },
    /// stdout 读到 EOF 也没等到判定行(分支⑤,通常是进程提前退出)。
    StdoutClosed,
}

fn parse_verdict(line: &str) -> Verdict {
    let value: serde_json::Value = match serde_json::from_str(line.trim()) {
        Ok(value) => value,
        Err(e) => {
            return Verdict::Malformed {
                reason: format!("readiness 行不是合法 JSON: {e}"),
                line: line.to_string(),
            }
        }
    };
    match value.get(READY_MARKER).and_then(serde_json::Value::as_bool) {
        Some(true) => {
            let port = value
                .get("port")
                .and_then(serde_json::Value::as_u64)
                .filter(|p| *p > 0 && *p <= u64::from(u16::MAX));
            match port {
                Some(port) => Verdict::Ready {
                    port: port as u16,
                    reported_pid: value
                        .get("pid")
                        .and_then(serde_json::Value::as_u64)
                        .map(|v| v as u32),
                    opencli_version: value
                        .get("opencliVersion")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                    policy_commands: value.get("policyCommands").and_then(serde_json::Value::as_u64),
                    parent_watch: value
                        .get("parentWatch")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                },
                None => Verdict::Malformed {
                    reason: "readiness 行 ready:true 但 port 缺失或不是合法端口".to_string(),
                    line: line.to_string(),
                },
            }
        }
        Some(false) => match value
            .pointer("/error/summary")
            .and_then(serde_json::Value::as_str)
        {
            Some(summary) => Verdict::Failed {
                summary: summary.to_string(),
                detail: value
                    .pointer("/error/detail")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
            },
            None => Verdict::Malformed {
                reason: "readiness 行 ready:false 但 error.summary 缺失".to_string(),
                line: line.to_string(),
            },
        },
        None => Verdict::Malformed {
            reason: format!("readiness 行缺少 bool 字段 {READY_MARKER}"),
            line: line.to_string(),
        },
    }
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/// Host 入口相对 **resource 根**的位置。`dist-host/` 镜像仓内相对拓扑,整棵树原样放进
/// `<resources>/host/`。
///
/// 只给出相对路径,由调用方用 `BaseDirectory::Resource` 解析(spec §8:不手工拼 resource 路径)——
/// resource 根在 dev / 打包 / 各平台下位置不同,自己 join 迟早在某个形态上错。
pub const HOST_ENTRY_RESOURCE: &str = "host/server/index.mjs";

#[cfg(windows)]
const NODE_EXE: &str = "node.exe";
#[cfg(not(windows))]
const NODE_EXE: &str = "node";

/// 把外部程序名解析成**绝对路径**,再交给 `Command`。
///
/// 未限定的名字会走 Windows 的搜索序,而那个序里**应用自身目录排在 PATH 之前**——
/// 2026-07-26 用最小 Rust 程序实证过(`docs/releases/2026-07-26-p1-a-tauri-packaging-t9.md` §9):
/// 与 launcher 同目录的 `node.exe` 确实顶掉了 `C:\Program Files\nodejs\node.exe`。
/// per-user NSIS 装在 `%LOCALAPPDATA%`,安装目录与应用本体同属当前用户可写,所以这不是理论问题。
///
/// 本函数只认 PATH 里的条目,并且:
/// * **只接受绝对路径候选** —— 这一条是承重的。Windows 把 PATH 里的空项(`;;`、首尾分号)
///   当作"当前目录",空项拼出来的候选是相对路径 `node.exe`,在这里当场出局;
///   驱动器相对写法(`C:node.exe`)同理。相对路径交给 `Command` 等于没修。
///   (原本还写了一条"跳过空条目"的显式分支,变异实测证明它被本条完全覆盖 —— 删掉了:
///    没有任何测试能区分的"防御"只会烂掉。)
/// * **跳过应用自身目录** —— 纵深防御:哪怕它真出现在 PATH 里也不采信。
fn resolve_program(exe: &str, path_var: &OsStr, app_dir: Option<&Path>) -> Option<PathBuf> {
    for dir in std::env::split_paths(path_var) {
        if app_dir.is_some_and(|app| app == dir) {
            continue;
        }
        let candidate = dir.join(exe);
        if candidate.is_absolute() && candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn app_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

/// 解析系统 Node。找不到即分支①(`NodeMissing`),与探测失败共用同一种文案。
fn resolve_node() -> Result<PathBuf, HostStartError> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    resolve_program(NODE_EXE, &path, app_dir().as_deref()).ok_or_else(|| HostStartError::NodeMissing {
        detail: format!("PATH 里找不到 {NODE_EXE}(应用自身目录不参与解析,见 M-10)"),
    })
}

/// 系统自带工具 → System32 绝对路径。
///
/// 这里信任 `SystemRoot` 环境变量。取舍写明:能改我们进程环境的攻击者本来就能改 PATH,
/// 那是比 M-10(往应用目录丢一个文件)**更强**的能力;而 M-10 这条路已被绝对化彻底堵死。
/// 为了再挡住更强的那种能力而引入一段 `GetSystemDirectoryW` 的 unsafe FFI,收益不抵复杂度。
#[cfg(windows)]
fn system_tool(exe: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from(r"C:\Windows"));
    Path::new(&root).join("System32").join(exe)
}

/// 预探测 `node --version`(分支①②)。
///
/// 返回**解析到的 node 绝对路径**与版本串。路径要一并返回,是为了让 `start_host` 复用同一个
/// 解析结果 —— 探测一个 node、启动另一个 node,既是 M-10 的另一副面孔,也是诊断噩梦。
pub fn probe_node() -> Result<(PathBuf, String), HostStartError> {
    let node = resolve_node()?;
    let mut cmd = Command::new(&node);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // 不用 `cmd.output()`:它**没有时限**,而 READINESS_TIMEOUT 只管 start_host,管不到这里。
    // node 被安全软件拦截、装在不可达的网络盘上、或是个坏 shim 时,output() 会永久阻塞 ——
    // 而这段跑在 setup 钩子里,一卡就是永久白窗(窗口都建不出来,用户连错误页都看不到)。
    let mut child = cmd.spawn().map_err(|e| HostStartError::NodeMissing {
        detail: format!("`node --version` 无法执行: {e}"),
    })?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let outcome = wait_for_exit(&mut child, Duration::from_millis(0));
        terminate(&mut child, &outcome);
        return Err(HostStartError::NodeMissing {
            detail: "`node --version` 的输出管道不可用".to_string(),
        });
    };
    // 后台排空两个管道(I4 的同一条道理:探测虽只有一行输出,也不能让主线程边等边读)。
    let out_rx = collect_to_end(stdout);
    let err_rx = collect_to_end(stderr);

    let outcome = wait_for_exit(&mut child, PROBE_TIMEOUT);
    let Some(status) = outcome.exited() else {
        terminate(&mut child, &outcome);
        return Err(HostStartError::NodeMissing {
            detail: format!(
                "`node --version` 在 {}s 内没有返回（node 可能被安全软件拦截、装在不可达的网络盘上，或是个坏 shim）",
                PROBE_TIMEOUT.as_secs()
            ),
        });
    };
    // 进程已退出 → 管道已 EOF → 排空线程马上会送出结果;给个短窗口兜底,拿不到就当空串。
    let stdout_text = out_rx.recv_timeout(PIPE_COLLECT_TIMEOUT).unwrap_or_default();
    let stderr_text = err_rx.recv_timeout(PIPE_COLLECT_TIMEOUT).unwrap_or_default();

    if !status.success() {
        return Err(HostStartError::NodeMissing {
            detail: format!(
                "`node --version` 退出码 {:?}: {}",
                status.code(),
                stderr_text.trim()
            ),
        });
    }

    let found = stdout_text.trim().to_string();
    let major = parse_major(&found).ok_or_else(|| HostStartError::NodeMissing {
        detail: format!("无法解析 node 版本输出: {found:?}"),
    })?;
    if major < NODE_MIN_MAJOR {
        return Err(HostStartError::NodeTooOld {
            found,
            required: NODE_REQUIRED,
        });
    }
    Ok((node, found))
}

fn parse_major(version: &str) -> Option<u32> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

/// 拉起 Host 并等它自报端口。成功即代表**至少一条清理通道生效**(I3)。
///
/// `entry` 是 Host 入口的**绝对路径**,由调用方经 `BaseDirectory::Resource` 解析
/// [`HOST_ENTRY_RESOURCE`] 得到 —— supervisor 不关心 resource 根长什么样。
/// Host 会读的**全部**环境变量,与 `server/` 里的 `process.env.OPENCLI_HOST_*` 一一对应。
/// 由 `host_env_surface_is_fully_pinned` 扫源码守护:将来在 server 里新增读取点却忘了在这里
/// 决定它,那条测试会红 —— 手写清单不加守护迟早腐烂。
///
/// 只被守卫测试消费,故 `cfg(test)`;放在 `configure_host_env` 旁边而不是塞进 tests 模块,
/// 是为了改那个函数的人一眼看见这份契约清单。
#[cfg(test)]
const HOST_ENV_KEYS: &[&str] = &[
    "OPENCLI_HOST_PORT",
    "OPENCLI_HOST_ADDRESS",
    "OPENCLI_HOST_PARENT_WATCH",
    "OPENCLI_HOST_ALLOWED_ORIGINS",
    "OPENCLI_HOST_CATALOG_PATH",
    "OPENCLI_HOST_LEGACY_BASELINE_PATH",
    "OPENCLI_HOST_CANCEL_GRACE_MS",
    "OPENCLI_HOST_COMMAND_TIMEOUT_MS",
    "OPENCLI_HOST_MAX_CONCURRENT_RUNS",
    "OPENCLI_HOST_VK_PYTHON",
    "OPENCLI_HOST_VK_ROOT",
    "OPENCLI_HOST_VK_CONFIG_DIR",
    "OPENCLI_HOST_VK_STATE_DIR",
    "OPENCLI_HOST_RADAR_STATE_FILE",
    "OPENCLI_HOST_VK_HOME",
    "OPENCLI_HOST_VK_BUNDLE_DIR",
];

/// Host 的配置面必须**完全**由 supervisor 决定:凡 Host 会读的变量,这里要么显式设值,
/// 要么显式移除(移除 = 回落到 Host 自己的默认值)。
///
/// `Command` 默认继承父环境,等于把配置面开放给任何能设环境变量的东西:
/// * `OPENCLI_HOST_ADDRESS=0.0.0.0` → Host 绑到全网卡,**"回环 bind"这条冻结契约当场破掉**;
/// * `OPENCLI_HOST_CATALOG_PATH`(T2 为造"协议内失败"加的测试注入点)→ 替换 policy 白名单的来源。
///
/// 威胁模型上需要攻击者已能设置该用户的环境变量,不算高危;但这是"一处收口就守住两条明文契约"
/// 的事,没有理由留着。
fn configure_host_env(cmd: &mut Command) {
    cmd.env("OPENCLI_HOST_PORT", "0")
        // 回环 bind 是冻结契约,不接受来自环境的改写。
        .env("OPENCLI_HOST_ADDRESS", "127.0.0.1")
        // 通道 2 开关(I2):Host 见到它才装 stdin EOF 看门狗。
        .env("OPENCLI_HOST_PARENT_WATCH", "1");

    // CORS 白名单(spec §7):**只放实测到的那一个 origin**,不猜、不"多写几个保险"——
    // 放宽 origin 会直接削弱 P0-B 的 DNS-rebinding 防线。
    // 生产 WebView 的 origin 由 T8 用打包产物实测捕获:`http://tauri.localhost`
    // (证据:日志 `rejected Origin: http://tauri.localhost`)。
    #[cfg(not(debug_assertions))]
    cmd.env("OPENCLI_HOST_ALLOWED_ORIGINS", "http://tauri.localhost");
    // 调试构建走 devUrl(http://localhost:5173),用 Host 自身的默认白名单。
    // **显式移除**而不是放任继承:否则环境里的同名变量会在 dev 形态下悄悄放宽白名单。
    #[cfg(debug_assertions)]
    cmd.env_remove("OPENCLI_HOST_ALLOWED_ORIGINS");

    // 其余一律回落到 Host 默认值(2000ms / 90000ms / 1 并发),不接受环境改写。
    // OPENCLI_HOST_LEGACY_BASELINE_PATH 与 CATALOG_PATH 同性质(readiness 测试注入点),
    // 且能替换 legacy 基线来源 —— 打包形态继承它等于把 fail-closed 的地基交给环境,必须移除。
    cmd.env_remove("OPENCLI_HOST_CATALOG_PATH")
        .env_remove("OPENCLI_HOST_LEGACY_BASELINE_PATH")
        .env_remove("OPENCLI_HOST_CANCEL_GRACE_MS")
        .env_remove("OPENCLI_HOST_COMMAND_TIMEOUT_MS")
        .env_remove("OPENCLI_HOST_MAX_CONCURRENT_RUNS");

    // video-knowledge sidecar 配置面(vk-shell-v1):`VK_PYTHON` 决定 Host 会 spawn
    // 哪个可执行文件 —— 放任继承等于把 spawn 向量交给任何能设用户环境变量的东西,
    // 比改写监听地址更危险,必须移除。开发直连(npm run dev:server)不经本函数。
    cmd.env_remove("OPENCLI_HOST_VK_PYTHON")
        .env_remove("OPENCLI_HOST_VK_ROOT")
        .env_remove("OPENCLI_HOST_VK_CONFIG_DIR")
        .env_remove("OPENCLI_HOST_VK_STATE_DIR")
        .env_remove("OPENCLI_HOST_RADAR_STATE_FILE")
        .env_remove("OPENCLI_HOST_VK_HOME")
        .env_remove("OPENCLI_HOST_VK_BUNDLE_DIR");

    // 打包形态:supervisor 是 HOME 的唯一权威来源。Python 由 Node 在每次 sidecar
    // 启动前通过统一 receipt resolver 动态解析，安装/adopt 后无需重启 Host。
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let home = Path::new(&local_app_data).join(VK_DATA_HOME_DIR);
        cmd.env("OPENCLI_HOST_VK_HOME", &home);
    }
}

/// vk 捆绑件目录(wheel+uv+manifest)随资源发货:<resources>/vk。
/// 由 start_host 依据 Host 入口路径推导并注入;目录不存在(dev 形态)则不设。
fn configure_vk_bundle_env(cmd: &mut Command, host_entry: &Path) {
    let resource_root = host_entry
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf);
    if let Some(root) = resource_root {
        let bundle = root.join("vk");
        if bundle.join("runtime-manifest.json").is_file() {
            cmd.env("OPENCLI_HOST_VK_BUNDLE_DIR", bundle);
        }
    }
}

/// 爪爪的 vk 数据根目录名。与 NSIS 安装目录(productName「爪爪」)分离,
/// 卸载默认不触碰 —— 知识库保留是默认行为,清空走 vk-data-tool 的显式 purge。
const VK_DATA_HOME_DIR: &str = "爪爪-data";

/// `node` 必须是 [`probe_node`] 解析出来的**绝对路径**:探测一个 node、启动另一个 node
/// 既是 M-10 的另一副面孔,也是诊断噩梦。
pub fn start_host(node: &Path, entry: &Path) -> Result<HostHandle, HostStartError> {
    log::info!("[supervisor] 启动 Host: {} {}", node.display(), entry.display());

    let mut cmd = Command::new(node);
    cmd.arg(entry);
    configure_host_env(&mut cmd);
    configure_vk_bundle_env(&mut cmd, entry);

    cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| HostStartError::NodeMissing {
        detail: format!("spawn `node {}` 失败: {e}", entry.display()),
    })?;
    let pid = child.id();

    // ── I1:spawn 之后**第一件事**就是入 Job,窗口期越短越好(此时 node 还没来得及派生孙进程)。
    let job = match job::KillOnCloseJob::create() {
        Ok(job) => match job.assign(raw_process_handle(&child)) {
            Ok(()) => Some(job),
            Err(reason) => {
                log::warn!("[supervisor] 通道 1(Job Object)分配失败,降级靠 stdin EOF: {reason}");
                None
            }
        },
        Err(reason) => {
            log::warn!("[supervisor] 通道 1(Job Object)创建失败,降级靠 stdin EOF: {reason}");
            None
        }
    };

    // ── I2:握住写端。**通道 2 是否真成立要等 readiness 才知道**(见下面的 fail-closed):
    // 我们这边有写端只是必要条件,Host 那边真挂上看门狗才是充分条件。
    let stdin = child.stdin.take();

    let stderr_tail = StderrTail::default();
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let detail = "Host 的 stdout/stderr 管道不可用：拿不到 readiness 判定,也无法排空".to_string();
        log::error!("[supervisor] fail-closed: {detail}");
        abandon(child, stdin);
        return Err(HostStartError::SupervisionUnavailable { detail });
    };

    // ── I4:两个排空线程各自读到 EOF 才结束。判定行只是"顺路"抄一份送回主线程,绝不因此停读。
    let (tx, rx) = mpsc::channel::<Verdict>();
    thread::spawn(move || {
        let mut reported = false;
        drain_lines(stdout, |line| {
            if !reported && line.contains(READY_MARKER) {
                reported = true;
                let _ = tx.send(parse_verdict(&line));
            }
            log::info!("[host stdout] {line}");
        });
        if !reported {
            let _ = tx.send(Verdict::StdoutClosed);
        }
        log::info!("[supervisor] Host stdout 已排空到 EOF");
    });
    let stderr_sink = stderr_tail.clone();
    thread::spawn(move || {
        drain_lines(stderr, |line| {
            log::warn!("[host stderr] {line}");
            stderr_sink.push(line);
        });
        log::info!("[supervisor] Host stderr 已排空到 EOF");
    });

    let verdict = match rx.recv_timeout(READINESS_TIMEOUT) {
        Ok(verdict) => verdict,
        // 判定行没等到:先分清"进程还活着但慢"(④)与"进程已经死了"(⑤)。
        Err(RecvTimeoutError::Timeout) => {
            let already_exited = child.try_wait().ok().flatten();
            abandon(child, stdin);
            let stderr_tail = stderr_tail.snapshot();
            return Err(match already_exited {
                Some(status) => HostStartError::ProcessFailed {
                    code: status.code(),
                    stderr_tail,
                },
                None => HostStartError::ReadinessTimeout { stderr_tail },
            });
        }
        // 排空线程连 StdoutClosed 都没送出来(panic 等),按 stdout 关闭处理。
        Err(RecvTimeoutError::Disconnected) => Verdict::StdoutClosed,
    };

    match verdict {
        Verdict::Ready {
            port,
            reported_pid,
            opencli_version,
            policy_commands,
            parent_watch,
        } => {
            if reported_pid.is_some_and(|reported| reported != pid) {
                log::warn!("[supervisor] Host 自报 pid {reported_pid:?} 与 spawn 得到的 {pid} 不一致");
            }

            // ── I3 fail-closed:到这一步两条通道的成立与否**都是已验证的事实**了。
            // 通道 2 = 我们握着写端(stdin.is_some) **且** Host 自报看门狗已挂上(parent_watch)。
            // 只设过 OPENCLI_HOST_PARENT_WATCH=1 不算数:dist-host/ 是 gitignore 的构建产物,
            // 可能是没有看门狗的旧版本(本 task 就真踩到过一次)。
            let channel_2 = stdin.is_some() && parent_watch;
            if !supervision_ok(job.is_some(), stdin.is_some(), parent_watch) {
                let detail = format!(
                    "两条清理通道都不成立（Job Object 未生效；stdin 写端={}，Host 自报看门狗={}）：\
                     主进程一旦消亡将留下无主的 node/opencli 进程",
                    stdin.is_some(),
                    parent_watch
                );
                log::error!("[supervisor] fail-closed,已杀掉刚起的 Host: {detail}");
                abandon(child, stdin);
                return Err(HostStartError::SupervisionUnavailable { detail });
            }
            if job.is_none() {
                log::warn!("[supervisor] 降级为单通道(stdin EOF):主进程被强杀时 Host 仍会自退,但没有内核连坐");
            }
            if !channel_2 {
                log::warn!(
                    "[supervisor] 降级为单通道(Job Object):stdin 写端={} Host 自报看门狗={} —— \
                     dist-host 可能是旧版本,建议重跑 npm run build:host",
                    stdin.is_some(),
                    parent_watch
                );
            }

            log::info!(
                "[supervisor] Host 就绪 port={port} pid={pid} opencli={opencli_version:?} 通道1={} 通道2={channel_2}",
                job.is_some()
            );
            Ok(HostHandle {
                port,
                pid,
                opencli_version,
                policy_commands,
                parent_watch,
                stdin,
                child,
                job,
                stderr_tail,
            })
        }
        Verdict::Failed { summary, detail } => {
            // 协议内失败:Host 打完这行会自己非零退出,这里只做收尾,不当"进程异常"论处。
            abandon(child, stdin);
            Err(HostStartError::HostReportedFailure { summary, detail })
        }
        Verdict::Malformed { reason, line } => {
            // 先关写端再等(评审 M-7):装了看门狗的 Host 见 EOF 会自退,不关就是白等满
            // SHUTDOWN_GRACE,然后进 abandon 再等一遍 —— 失败路径平白多花一倍时间。
            drop(stdin);
            let code = wait_for_exit(&mut child, SHUTDOWN_GRACE)
                .exited()
                .and_then(|s| s.code());
            abandon(child, None);
            Err(HostStartError::ProcessFailed {
                code,
                stderr_tail: format!("{reason}\n> {line}\n{}", stderr_tail.snapshot()),
            })
        }
        Verdict::StdoutClosed => {
            drop(stdin);
            let code = wait_for_exit(&mut child, SHUTDOWN_GRACE)
                .exited()
                .and_then(|s| s.code());
            abandon(child, None);
            Err(HostStartError::ProcessFailed {
                code,
                stderr_tail: stderr_tail.snapshot(),
            })
        }
    }
}

/// 优雅退出:关 stdin(通道 2)→ 等 2s → `taskkill /T /F` 收尾 → 最后才放 Job 句柄(通道 1 兜底)。
pub fn shutdown(handle: HostHandle) {
    let HostHandle {
        pid,
        stdin,
        mut child,
        job,
        ..
    } = handle;

    // 1) 关写端 → Host 收到 EOF → 先 app.close() 收 SSE 与在途 run,再 exit(0)。
    drop(stdin);

    // 2) 给它 2s 走完优雅路径。
    let outcome = wait_for_exit(&mut child, SHUTDOWN_GRACE);
    match outcome.exited() {
        Some(status) => log::info!("[supervisor] Host pid={pid} 已优雅退出({status})"),
        None => {
            // 3) 只有"主进程还活着"的正常退出路径才轮得到 taskkill —— 它从来不是崩溃兜底。
            //    按 pid 收树只在"确认仍在运行"时做(terminate 内部把关,防 pid 复用误杀)。
            log::warn!(
                "[supervisor] Host pid={pid} 未在 {}ms 内退出,强制收尾",
                SHUTDOWN_GRACE.as_millis()
            );
            terminate(&mut child, &outcome);
        }
    }

    // 4) 最后关 Job 句柄:漏网的孙进程由内核连坐。
    drop(job);
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/// 逐行排空到 EOF。用字节读 + `from_utf8_lossy`:非 UTF-8 输出(某些 Windows 语言环境)
/// 不能让排空提前中止,否则就退化成 I4 要防的那种背压死锁。
fn drain_lines<R: Read>(source: R, mut on_line: impl FnMut(String)) {
    let mut reader = BufReader::new(source);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {
                while matches!(buf.last(), Some(b'\n' | b'\r')) {
                    buf.pop();
                }
                on_line(String::from_utf8_lossy(&buf).into_owned());
            }
            Err(e) => {
                log::warn!("[supervisor] 排空 Host 输出时读失败: {e}");
                break;
            }
        }
    }
}

/// 等待结果。**必须区分"确认还在跑"与"状态不可知"**:`kill_tree` 是按 **pid** 下手的
/// (`taskkill /PID`),而 pid 会被系统复用 —— 只有确认进程仍在运行时才允许用 pid 杀,
/// `try_wait` 报错时拿 pid 去 taskkill 有误杀无关进程的风险。
enum WaitOutcome {
    Exited(ExitStatus),
    /// 预算耗尽,确认仍在运行 —— 可以按 pid 收树。
    StillRunning,
    /// `try_wait` 报错,进程状态不可知 —— **不许**按 pid 杀,只能用句柄杀。
    Unknown,
}

impl WaitOutcome {
    fn exited(&self) -> Option<ExitStatus> {
        match self {
            Self::Exited(status) => Some(*status),
            _ => None,
        }
    }
}

/// I3 的裁决:**至少一条清理通道成立**才允许把 Host 留在世上。
///
/// 抽成纯函数是为了它能被直接测 —— 埋在 `start_host` 里就只能靠"读代码相信它",
/// 而这条分支恰恰是最难在真机上触发、又最不能出错的一条。
/// * 通道 1 = Job Object 已 assign(内核连坐,覆盖崩溃/强杀)
/// * 通道 2 = 我们握着 stdin 写端 **且** Host 自报看门狗已挂上(缺一不可)
fn supervision_ok(job_attached: bool, stdin_held: bool, parent_watch: bool) -> bool {
    job_attached || (stdin_held && parent_watch)
}

/// 在后台线程里把一个管道读到 EOF,整段文本从 channel 送回。
fn collect_to_end<R: Read + Send + 'static>(source: R) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut text = String::new();
        drain_lines(source, |line| {
            text.push_str(&line);
            text.push('\n');
        });
        let _ = tx.send(text);
    });
    rx
}

fn wait_for_exit(child: &mut Child, budget: Duration) -> WaitOutcome {
    let deadline = Instant::now() + budget;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return WaitOutcome::Exited(status),
            Ok(None) => {}
            Err(e) => {
                log::warn!("[supervisor] try_wait 失败,进程状态不可知: {e}");
                return WaitOutcome::Unknown;
            }
        }
        if Instant::now() >= deadline {
            return WaitOutcome::StillRunning;
        }
        thread::sleep(Duration::from_millis(25));
    }
}

/// 收尸:句柄杀恒可用(不受 pid 复用影响);只有**确认仍在运行**才追加按 pid 的 taskkill 收树。
fn terminate(child: &mut Child, outcome: &WaitOutcome) {
    match outcome {
        WaitOutcome::Exited(_) => {}
        WaitOutcome::StillRunning => {
            kill_tree(child.id());
            let _ = child.kill();
        }
        WaitOutcome::Unknown => {
            let _ = child.kill();
        }
    }
    let _ = child.wait();
}

/// 错误路径的统一收尾。`Child` 的 drop **不**杀进程,任何提前 return 都必须先走这里,
/// 否则就正好制造出 I3 要杜绝的无主子进程。
fn abandon(mut child: Child, stdin: Option<ChildStdin>) {
    drop(stdin);
    let outcome = wait_for_exit(&mut child, SHUTDOWN_GRACE);
    terminate(&mut child, &outcome);
}

/// 按 pid 收整棵树。**只在确认进程仍在运行时调用**(见 [`WaitOutcome`]):pid 会被系统复用。
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    // 绝对路径(M-10):`taskkill` 是收尸路径 —— 被同目录同名 exe 顶掉的话,不只是执行了
    // 别人的代码,还会让进程清理**静默失败**(假 taskkill 返回成功、孤儿留在原地),
    // 正好架空 I1/I2 这两条整个阶段绕着建的不变式。
    let status = Command::new(system_tool("taskkill.exe"))
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    if let Err(e) = status {
        log::warn!("[supervisor] taskkill pid={pid} 执行失败: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `node --version` 出的是 `v20.11.1` 这种带前缀的串。
    #[test]
    fn parse_major_accepts_v_prefix_and_bare_version() {
        assert_eq!(parse_major("v20.11.1"), Some(20));
        assert_eq!(parse_major("24.0.0"), Some(24));
        assert_eq!(parse_major(" v22.9.0\n"), Some(22));
        assert_eq!(parse_major("not-a-version"), None);
    }

    /// I5:协议内失败(③)与 JSON 非法/缺字段(⑤)必须判成不同的东西,不能混为一谈。
    #[test]
    fn verdict_branches_stay_distinguishable() {
        let ready = parse_verdict(
            r#"{"opencliHostReady":true,"port":54321,"pid":1234,"opencliVersion":"1.8.6","policyCommands":277,"parentWatch":true}"#,
        );
        match ready {
            Verdict::Ready { port, policy_commands, parent_watch, .. } => {
                assert_eq!(port, 54321);
                assert_eq!(policy_commands, Some(277));
                assert!(parent_watch);
            }
            _ => panic!("应判定为 Ready"),
        }

        // 缺 parentWatch(老版本 dist-host)必须当 false —— 乐观默认会让 fail-closed 形同虚设。
        match parse_verdict(r#"{"opencliHostReady":true,"port":1}"#) {
            Verdict::Ready { parent_watch, .. } => assert!(!parent_watch, "缺字段不能当 true"),
            _ => panic!("应判定为 Ready"),
        }

        let failed =
            parse_verdict(r#"{"opencliHostReady":false,"error":{"summary":"catalog 缺失","detail":"x"}}"#);
        match failed {
            Verdict::Failed { summary, detail } => {
                assert_eq!(summary, "catalog 缺失");
                assert_eq!(detail.as_deref(), Some("x"));
            }
            _ => panic!("应判定为协议内失败"),
        }

        // 缺 port / 非法 JSON / 缺 marker → 一律 Malformed(映射分支⑤,不与协议内失败混淆)
        assert!(matches!(
            parse_verdict(r#"{"opencliHostReady":true}"#),
            Verdict::Malformed { .. }
        ));
        assert!(matches!(
            parse_verdict("[opencliHostReady] listening"),
            Verdict::Malformed { .. }
        ));
        assert!(matches!(
            parse_verdict(r#"{"opencliHostReady":"yes"}"#),
            Verdict::Malformed { .. }
        ));
        assert!(matches!(
            parse_verdict(r#"{"opencliHostReady":false}"#),
            Verdict::Malformed { .. }
        ));
    }

    /// I1 的真身:`KILL_ON_JOB_CLOSE` 必须真的连坐。三个 unsafe 调用里任何一个搞错
    /// (漏 SetInformationJobObject、传错 size、assign 到错句柄)都编得过、只是**默默不生效**——
    /// 只有真起一个进程再关句柄才能证伪。这里的 node 挂着 setInterval 永不自退,
    /// 所以"它退了"本身就等于"内核杀了它"。
    #[cfg(windows)]
    #[test]
    fn kill_on_job_close_actually_terminates_the_child() {
        let job = job::KillOnCloseJob::create().expect("创建 job");
        let mut child = Command::new("node")
            .args(["-e", "setInterval(() => {}, 1000)"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn node");
        job.assign(raw_process_handle(&child)).expect("assign 到 job");
        assert!(
            child.try_wait().expect("try_wait").is_none(),
            "刚 spawn 就没了,后面的断言证明不了任何事"
        );

        drop(job); // 关掉最后一个 job 句柄 = 触发连坐

        let outcome = wait_for_exit(&mut child, Duration::from_secs(5));
        let terminated = outcome.exited().is_some();
        // 连坐没生效时这个 node 会一直活着,`child.wait()` 就会**永久悬挂**——
        // 断言失败必须失败得干脆,不能变成挂死的假绿(先收尸再断言)。
        terminate(&mut child, &outcome);
        assert!(
            terminated,
            "job 句柄关闭后 5s 内子进程仍在跑 —— KILL_ON_JOB_CLOSE 没生效,I1 是假的"
        );
    }

    /// I1 的**真实形状**:spec §5 断言的是"内核连坐**整棵子树**",而真实链路是
    /// Tauri → node(Host) → opencli(孙)。只验直接子进程会漏掉最要命的一种残留:
    /// Host 死了、它派生的 opencli 还在跑。
    ///
    /// 关键时序:**先把父进程 assign 进 job,再让它派生孙进程** —— job 成员派生的子进程
    /// 自动进同一个 job,这正是我们依赖的内核语义。所以父进程要等 stdin 上的信号才开工,
    /// 免得它抢在 assign 之前就把孙生出来(那样孙确实会漏,但那是竞态不是语义)。
    ///
    /// 孙进程必须 `detached: true` + `unref()`:**实测本机上普通孙进程在父进程被杀时会跟着死**
    /// (与 job 无关)。用普通孙进程写这个测试是**假绿** —— 它连"孙根本没进 job"都照样通过
    /// (变异验证实证)。detached 孙进程能活过父之死(control 已验),于是"它死了"就只能是 job 干的。
    #[cfg(windows)]
    #[test]
    fn kill_on_job_close_terminates_the_whole_subtree() {
        use std::io::Write;

        let job = job::KillOnCloseJob::create().expect("创建 job");
        let script = "process.stdin.once('data', () => { \
             const { spawn } = require('child_process'); \
             const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true }); \
             g.unref(); \
             console.log(g.pid); \
             }); setInterval(() => {}, 1000)";
        let mut child = Command::new("node")
            .args(["-e", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn 父 node");
        let child_pid = child.id();
        job.assign(raw_process_handle(&child)).expect("assign 到 job");

        // assign 完成后才放行:此刻起派生的孙进程一定在 job 里
        let mut stdin = child.stdin.take().expect("stdin");
        stdin.write_all(b"go\n").expect("write");
        stdin.flush().ok();

        let stdout = child.stdout.take().expect("stdout");
        let (tx, rx) = mpsc::channel::<String>();
        thread::spawn(move || {
            drain_lines(stdout, |line| {
                let _ = tx.send(line);
            })
        });
        let grandchild_pid: u32 = rx
            .recv_timeout(Duration::from_secs(15))
            .expect("没等到孙进程 pid")
            .trim()
            .parse()
            .expect("孙进程 pid 不是数字");
        assert!(
            process_alive(grandchild_pid),
            "孙进程 {grandchild_pid} 还没起来,后面的断言证明不了任何事"
        );

        drop(job); // 关句柄 = 连坐

        let outcome = wait_for_exit(&mut child, Duration::from_secs(5));
        let child_gone = outcome.exited().is_some();
        let mut grandchild_gone = false;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if !process_alive(grandchild_pid) {
                grandchild_gone = true;
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }

        // 先收尸再断言:连坐没生效时这俩会永远活着,别把失败变成悬挂 + 泄漏进程
        terminate(&mut child, &outcome);
        if !grandchild_gone {
            kill_tree(grandchild_pid);
        }

        assert!(child_gone, "job 关闭后父进程 {child_pid} 仍在跑");
        assert!(
            grandchild_gone,
            "job 关闭后**孙进程** {grandchild_pid} 仍在跑 —— 连坐没覆盖整棵子树,\
             真实链路里这就是 Host 死了 opencli 还在跑"
        );
    }

    /// dist-host 必须镜像仓内相对拓扑(server 用相对 import 引 ../src/shared/*.mjs,拍平必断);
    /// 且必须是**相对** resource 根的路径,否则 BaseDirectory::Resource 解析会被绝对路径旁路掉。
    #[test]
    fn host_entry_resource_is_relative_and_mirrors_topology() {
        assert_eq!(HOST_ENTRY_RESOURCE, "host/server/index.mjs");
        assert!(
            !Path::new(HOST_ENTRY_RESOURCE).is_absolute(),
            "必须是相对路径,交给 BaseDirectory::Resource 解析"
        );
    }

    /// I3:fail-closed 的真值表。**"设过环境变量"不是证据** —— 只有 Host 自报
    /// `parentWatch:true` 才算通道 2 成立(dist-host 是 gitignore 产物,可能是没看门狗的旧版本)。
    #[test]
    fn supervision_requires_at_least_one_real_channel() {
        // 通道 1 在,其余随便
        assert!(supervision_ok(true, false, false));
        assert!(supervision_ok(true, true, true));
        // 只有通道 2,且两个条件齐备
        assert!(supervision_ok(false, true, true));
        // 通道 2 缺任一半 → 无通道 → 必须 fail-closed
        assert!(!supervision_ok(false, true, false), "只设了环境变量、Host 没挂看门狗 → 不算通道");
        assert!(!supervision_ok(false, false, true), "没握写端 → 不算通道");
        assert!(!supervision_ok(false, false, false));
    }

    #[test]
    fn packaged_host_never_pins_vk_python_from_parent_or_active_pointer() {
        let mut cmd = Command::new("node");
        configure_host_env(&mut cmd);
        let envs: std::collections::HashMap<String, Option<String>> = cmd
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|item| item.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert_eq!(
            envs.get("OPENCLI_HOST_VK_PYTHON"),
            Some(&None),
            "Python 必须由 Node receipt resolver 在每次 sidecar 启动前动态解析"
        );
        assert!(
            envs.get("OPENCLI_HOST_VK_HOME").and_then(|value| value.as_ref()).is_some(),
            "Rust 仍须固定注入 app-owned HOME"
        );
    }

    /// C1:探测必须有时限。`probe_node` 的全部时限就来自 `wait_for_exit(_, PROBE_TIMEOUT)`,
    /// 这里拿一个永不自退的进程验证两件事:预算到点必返回 `StillRunning`(不是无限等),
    /// 且 `terminate` 真收得掉尸。原来的 `cmd.output()` 在这种进程上会永久阻塞 —— 而它跑在
    /// setup 钩子里,阻塞 = 永久白窗,连错误页都渲染不出来。
    #[cfg(windows)]
    #[test]
    fn wait_for_exit_is_bounded_and_terminate_reaps() {
        let mut child = Command::new("node")
            .args(["-e", "setInterval(() => {}, 1000)"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn node");
        let pid = child.id();

        let started = Instant::now();
        let outcome = wait_for_exit(&mut child, Duration::from_millis(300));
        let elapsed = started.elapsed();

        assert!(
            matches!(outcome, WaitOutcome::StillRunning),
            "永不自退的进程应判定为 StillRunning"
        );
        assert!(
            elapsed < Duration::from_secs(3),
            "预算 300ms 却等了 {elapsed:?} —— 时限没生效"
        );

        terminate(&mut child, &outcome);
        assert!(!process_alive(pid), "terminate 之后 pid={pid} 仍在");
    }

    /// I-3:Host 的配置面必须**完全**由 supervisor 决定,一个变量都不能漏成"从父环境继承"。
    #[test]
    fn host_env_surface_is_fully_pinned() {
        // ① 扫源码 —— 手写清单不加守护会腐烂:将来 server 里新增一个 process.env.OPENCLI_HOST_*
        //    却忘了在 HOST_ENV_KEYS 里决定它,这一半立刻红。
        let server_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../server");
        let mut found = std::collections::BTreeSet::new();
        for entry in std::fs::read_dir(&server_dir).expect("读 server/") {
            let path = entry.expect("目录项").path();
            if path.extension().and_then(|e| e.to_str()) != Some("mjs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("读 .mjs");
            for (i, _) in text.match_indices("process.env.OPENCLI_HOST_") {
                let tail = &text[i + "process.env.".len()..];
                let name: String = tail
                    .chars()
                    .take_while(|c| c.is_ascii_uppercase() || *c == '_')
                    .collect();
                found.insert(name);
            }
        }
        // 扫描逻辑本身失效时(改了目录结构/写法),不能静默通过成"没有读取点所以全都合规"。
        assert!(
            !found.is_empty(),
            "没扫到任何 OPENCLI_HOST_* 读取点 —— 是扫描逻辑失效了,不是 server 真没读环境变量"
        );
        for name in &found {
            assert!(
                HOST_ENV_KEYS.contains(&name.as_str()),
                "{name} 是 Host 会读的,但 supervisor 没决定它 → 打包形态下会从父环境继承"
            );
        }

        // ② 每个 key 都被显式设值或显式移除。
        let mut cmd = Command::new("node");
        configure_host_env(&mut cmd);
        let envs: std::collections::HashMap<String, Option<String>> = cmd
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|x| x.to_string_lossy().into_owned()),
                )
            })
            .collect();
        for key in HOST_ENV_KEYS {
            assert!(envs.contains_key(*key), "{key} 未被 supervisor 显式决定");
        }
        assert_eq!(
            envs["OPENCLI_HOST_ADDRESS"].as_deref(),
            Some("127.0.0.1"),
            "回环 bind 是冻结契约,不接受环境改写"
        );
        assert_eq!(envs["OPENCLI_HOST_PORT"].as_deref(), Some("0"));
        assert_eq!(
            envs["OPENCLI_HOST_CATALOG_PATH"], None,
            "测试注入点必须在打包形态下被移除"
        );
    }

    #[cfg(windows)]
    fn test_node() -> std::path::PathBuf {
        resolve_node().expect("测试机上必须有可解析的 node")
    }

    /// M-10:未限定的程序名会走 Windows 搜索序,**应用自身目录排在 PATH 之前**(已实证)。
    /// 解析器只认 PATH 条目,且必须挡住两条把"目录劫持"请回来的暗门。
    #[test]
    fn resolve_program_only_trusts_absolute_path_entries() {
        let root = std::env::temp_dir().join("opencli-resolve-tests");
        let real = root.join("real");
        let app = root.join("app");
        let decoy_only = root.join("empty");
        for dir in [&real, &app, &decoy_only] {
            std::fs::create_dir_all(dir).expect("建目录");
        }
        std::fs::write(real.join(NODE_EXE), b"").expect("写真 node");
        std::fs::write(app.join(NODE_EXE), b"").expect("写应用目录里的诱饵");

        let join = |dirs: &[&Path]| {
            std::env::join_paths(dirs.iter().map(|d| d.as_os_str())).expect("拼 PATH")
        };

        // ① 正常命中,且必须是绝对路径。
        let found = resolve_program(NODE_EXE, &join(&[&decoy_only, &real]), None).expect("该找到");
        assert_eq!(found, real.join(NODE_EXE));
        assert!(found.is_absolute());

        // ② **空条目**:Windows 把 PATH 里的空项当作"当前目录"。承重的是"只接受绝对候选":
        //    空项拼出来的是相对路径 `node.exe`,当场出局。
        let mut with_empty = OsString::from(";");
        with_empty.push(real.as_os_str());
        let found = resolve_program(NODE_EXE, &with_empty, None).expect("该找到");
        assert!(found.is_absolute(), "空 PATH 条目被当成了当前目录: {found:?}");
        assert_eq!(found, real.join(NODE_EXE));
        // 只有空条目时必须是 None,而不是回落到某个相对路径。
        assert!(resolve_program(NODE_EXE, OsStr::new(";;"), None).is_none());
        // 驱动器相对写法(`C:node.exe`)同样不是绝对路径,不能采信。
        assert!(resolve_program(NODE_EXE, OsStr::new("C:"), None).is_none());
        //
        // 诚实标注:这两条断言在**当前工作目录恰好放着 node.exe** 时才具备完全的判别力
        //(相对候选会真的命中)。制造那个条件要改进程级 CWD,而 CWD 是全进程共享的 ——
        // 并行跑的其他用例正靠它解析 `Command::new("node")`,改了会互相污染。
        // 故此处不追求"摘掉 is_absolute 必红",承重逻辑靠上面 ① 的绝对性断言 + 代码注释锁定。

        // ③ 纵深防御:应用自身目录即便真的排在 PATH 前面也不采信。
        let found = resolve_program(NODE_EXE, &join(&[&app, &real]), Some(&app)).expect("该找到");
        assert_eq!(found, real.join(NODE_EXE), "应用目录里的诱饵被选中了");

        // ④ 找不到就是找不到,不许回落到某个相对路径。
        assert!(resolve_program(NODE_EXE, &join(&[&decoy_only]), None).is_none());
    }

    /// 系统自带工具必须解析到 System32 绝对路径 —— `taskkill` 是收尸路径,
    /// 被同名 exe 顶掉会让进程清理**静默失败**,直接架空 I1/I2。
    #[test]
    #[cfg(windows)]
    fn system_tools_resolve_under_system32() {
        let taskkill = system_tool("taskkill.exe");
        assert!(taskkill.is_absolute());
        assert!(taskkill.is_file(), "System32 下没找到 taskkill.exe: {taskkill:?}");
        assert!(
            taskkill
                .to_string_lossy()
                .to_ascii_lowercase()
                .contains("system32"),
            "{taskkill:?} 不在 System32 下"
        );
    }

    /// `abandon` 的**隔离**测试:错误路径的收尸逻辑本身,不借 Job Object 的力。
    ///
    /// 为什么必须单独测:下面那三条 `start_host` 分支测试**证不了 `abandon`**。实测变异过——
    /// 把 `Failed` 分支的 `abandon` 换成两个 `drop`,测试照样绿,因为 `start_host` 返回时
    /// 局部变量 `job` 析构触发 `KILL_ON_JOB_CLOSE`,内核替它把孩子收了。
    /// 也就是说那三条守的是"用户可见的不变式(不留无主进程)",守不住"是谁收的"。
    /// 而 `abandon` 的价值恰在 **Job 分配失败的降级路径**上,那时没有内核兜底。
    #[test]
    #[cfg(windows)]
    fn abandon_reaps_a_child_that_ignores_stdin_eof() {
        let spawn_stubborn = || {
            let mut child = Command::new("node")
                // 既不读 stdin 也不会自退:唯一能让它消失的就是被杀。
                .args(["-e", "setInterval(() => {}, 1000)"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn node");
            let stdin = child.stdin.take();
            (child, stdin)
        };

        // ── 零假设对照:不调 abandon,只是把句柄丢掉 —— 它必须**活着**。
        //    对照组要是也死了,说明是环境在收尸,下面的实验组毫无信息量。
        let (control, control_stdin) = spawn_stubborn();
        let control_pid = control.id();
        drop(control_stdin);
        drop(control);
        thread::sleep(Duration::from_millis(1500));
        assert!(
            process_alive(control_pid),
            "对照组自己就死了 —— 是环境在收尸,本测试证明不了 abandon"
        );
        kill_tree(control_pid);

        // ── 实验组:同样的进程,交给 abandon。
        let (child, stdin) = spawn_stubborn();
        let pid = child.id();
        abandon(child, stdin);
        assert!(
            !process_alive(pid),
            "abandon 返回后 pid={pid} 仍在 —— 降级路径(Job 分配失败)会留无主进程"
        );
    }

    /// 造一个假 Host 入口。**故意都不自退**,让"进程最后消失了"必须来自 supervisor 一侧
    /// (是 `abandon` 还是 Job 析构由上面那条隔离测试区分)。
    #[cfg(windows)]
    fn fake_host_entry(name: &str, body: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("opencli-host-supervisor-tests");
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = dir.join(name);
        let source = format!(
            "import {{ writeFileSync }} from 'node:fs'\n\
             writeFileSync(process.argv[1] + '.pid', String(process.pid))\n\
             {body}\n"
        );
        std::fs::write(&path, source).expect("写假 Host");
        path
    }

    #[cfg(windows)]
    fn fake_host_pid(entry: &Path) -> u32 {
        let pid_file = format!("{}.pid", entry.display());
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = text.trim().parse() {
                    return pid;
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("假 Host 没写出 pid 文件: {pid_file}");
    }

    /// 进程退出不是瞬时的,给收尸留出窗口再判定。
    #[cfg(windows)]
    fn assert_reaped(pid: u32, context: &str) {
        for _ in 0..40 {
            if !process_alive(pid) {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        panic!("{context}:start_host 返回后 pid={pid} 仍在 —— 错误路径漏了收尸");
    }

    /// I-2:`start_host` 的三条失败分支,每条都断言"kind 正确 **且** 子进程已被收掉"。
    /// 此前 13 条测试全是纯函数,`start_host` 整个函数零覆盖。
    ///
    /// **诚实标注射程**:这三条守的是用户可见的不变式(错误路径不留无主进程)与分支归类,
    /// **不隔离收尸来源** —— Job Object 析构同样会收,实测变异确认过。
    /// 收尸机制本身由 `abandon_reaps_a_child_that_ignores_stdin_eof` 隔离守护。
    #[test]
    #[cfg(windows)]
    fn start_host_reaps_child_when_readiness_line_is_malformed() {
        let entry = fake_host_entry(
            "malformed.mjs",
            "process.stdout.write('opencliHostReady 但这不是 JSON\\n')\nsetInterval(() => {}, 1000)",
        );
        let error = start_host(&test_node(), &entry).err().expect("畸形判定行必须失败");
        assert_eq!(error.kind(), "process-failed");
        assert_reaped(fake_host_pid(&entry), "畸形判定行");
    }

    #[test]
    #[cfg(windows)]
    fn start_host_reports_process_failed_when_host_exits_early() {
        let entry = fake_host_entry("early-exit.mjs", "process.exit(3)");
        let error = start_host(&test_node(), &entry).err().expect("Host 提前退出必须失败");
        assert_eq!(error.kind(), "process-failed");
        // 这一支进程本就已经死了,但仍要确认 supervisor 没把它当活的留着。
        assert_reaped(fake_host_pid(&entry), "提前退出");
    }

    #[test]
    #[cfg(windows)]
    fn start_host_reaps_child_when_host_reports_failure() {
        let entry = fake_host_entry(
            "ready-false.mjs",
            "process.stdout.write(JSON.stringify({ opencliHostReady: false, error: { summary: 'boom', detail: 'd' } }) + '\\n')\n\
             setInterval(() => {}, 1000)",
        );
        let error = start_host(&test_node(), &entry).err().expect("协议内失败必须失败");
        assert_eq!(error.kind(), "host-reported-failure");
        // 真 Host 打完这行会自退;这个假 Host **故意赖着不走**,以此证明收尸是 supervisor 做的。
        assert_reaped(fake_host_pid(&entry), "协议内失败");
    }

    /// 真去问系统,不靠 `Child` 自己的记账 —— 验证"孙进程/被 taskkill 的进程"必须这样查。
    #[cfg(windows)]
    fn process_alive(pid: u32) -> bool {
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .expect("tasklist");
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    }
}
