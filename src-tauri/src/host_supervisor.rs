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

use std::collections::VecDeque;
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

#[cfg(not(windows))]
mod job {
    /// 非 Windows 没有 Job Object 语义;保持类型存在以便调用点无需 cfg 分叉。
    /// 通道 1 在这些平台恒不可用,托管完全落在通道 2(stdin EOF)上。
    pub struct KillOnCloseJob;

    impl KillOnCloseJob {
        pub fn create() -> Result<Self, String> {
            Err("Job Object 仅 Windows 可用".to_string())
        }
        pub fn assign(&self, _process: *mut core::ffi::c_void) -> Result<(), String> {
            Err("Job Object 仅 Windows 可用".to_string())
        }
    }
}

#[cfg(windows)]
fn raw_process_handle(child: &Child) -> *mut core::ffi::c_void {
    use std::os::windows::io::AsRawHandle;
    child.as_raw_handle()
}

#[cfg(not(windows))]
fn raw_process_handle(_child: &Child) -> *mut core::ffi::c_void {
    core::ptr::null_mut()
}

// ---------------------------------------------------------------------------
// 句柄
// ---------------------------------------------------------------------------

/// 已就绪的 Host。**字段顺序即析构顺序**:先 stdin(通道 2)、再 child、最后 job 句柄
/// (通道 1 作最终保险)。即便调用方忘了 `shutdown`,drop 也不会留下无主进程。
pub struct HostHandle {
    pub port: u16,
    pub pid: u32,
    pub opencli_version: Option<String>,
    pub policy_commands: Option<u64>,
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

/// 打包后 Host 入口的约定位置。`dist-host/` 镜像仓内相对拓扑,整棵树原样放进 `<resources>/host/`。
pub fn host_entry(resource_dir: &Path) -> PathBuf {
    resource_dir.join("host").join("server").join("index.mjs")
}

/// 预探测 `node --version`(分支①②)。
///
/// 返回探测到的版本串(计划里写的是 `Result<(), _>`;返回版本是无损超集,启动日志与
/// T6 的诊断都要它)。
pub fn probe_node() -> Result<String, HostStartError> {
    let mut cmd = Command::new("node");
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().map_err(|e| HostStartError::NodeMissing {
        detail: format!("`node --version` 无法执行: {e}"),
    })?;
    if !output.status.success() {
        return Err(HostStartError::NodeMissing {
            detail: format!(
                "`node --version` 退出码 {:?}: {}",
                output.status.code(),
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        });
    }

    let found = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let major = parse_major(&found).ok_or_else(|| HostStartError::NodeMissing {
        detail: format!("无法解析 node 版本输出: {found:?}"),
    })?;
    if major < NODE_MIN_MAJOR {
        return Err(HostStartError::NodeTooOld {
            found,
            required: NODE_REQUIRED,
        });
    }
    Ok(found)
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
pub fn start_host(resource_dir: &Path) -> Result<HostHandle, HostStartError> {
    let entry = host_entry(resource_dir);
    log::info!("[supervisor] 启动 Host: node {}", entry.display());

    let mut cmd = Command::new("node");
    cmd.arg(&entry)
        .env("OPENCLI_HOST_PORT", "0")
        // 通道 2 开关(I2):Host 见到它才装 stdin EOF 看门狗;不设时行为与 npm run dev:server 一致。
        .env("OPENCLI_HOST_PARENT_WATCH", "1")
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

    // ── I2/I3:两条通道至少要有一条,否则 fail-closed —— 宁可不启动,也不留无主子进程。
    let stdin = child.stdin.take();
    if job.is_none() && stdin.is_none() {
        let detail = "Job Object 与 stdin 管道双双不可用：主进程一旦消亡将留下无主的 node 子进程"
            .to_string();
        log::error!("[supervisor] fail-closed: {detail}");
        abandon(child, None);
        return Err(HostStartError::SupervisionUnavailable { detail });
    }
    if job.is_none() {
        log::warn!("[supervisor] 已降级为单通道(stdin EOF);主进程被强杀时 Host 仍会自退,但不再有内核连坐");
    }

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
        } => {
            if reported_pid.is_some_and(|reported| reported != pid) {
                log::warn!("[supervisor] Host 自报 pid {reported_pid:?} 与 spawn 得到的 {pid} 不一致");
            }
            log::info!(
                "[supervisor] Host 就绪 port={port} pid={pid} opencli={opencli_version:?} 通道1={}",
                job.is_some()
            );
            Ok(HostHandle {
                port,
                pid,
                opencli_version,
                policy_commands,
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
            let code = wait_for_exit(&mut child, SHUTDOWN_GRACE).and_then(|s| s.code());
            abandon(child, stdin);
            Err(HostStartError::ProcessFailed {
                code,
                stderr_tail: format!("{reason}\n> {line}\n{}", stderr_tail.snapshot()),
            })
        }
        Verdict::StdoutClosed => {
            let code = wait_for_exit(&mut child, SHUTDOWN_GRACE).and_then(|s| s.code());
            abandon(child, stdin);
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
    match wait_for_exit(&mut child, SHUTDOWN_GRACE) {
        Some(status) => log::info!("[supervisor] Host pid={pid} 已优雅退出({status})"),
        None => {
            // 3) 只有"主进程还活着"的正常退出路径才轮得到 taskkill —— 它从来不是崩溃兜底。
            log::warn!(
                "[supervisor] Host pid={pid} 未在 {}ms 内退出,taskkill /T /F",
                SHUTDOWN_GRACE.as_millis()
            );
            kill_tree(pid);
            let _ = child.kill();
            let _ = child.wait();
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

fn wait_for_exit(child: &mut Child, budget: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + budget;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {}
            Err(e) => {
                log::warn!("[supervisor] try_wait 失败: {e}");
                return None;
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(Duration::from_millis(25));
    }
}

/// 错误路径的统一收尾。`Child` 的 drop **不**杀进程,任何提前 return 都必须先走这里,
/// 否则就正好制造出 I3 要杜绝的无主子进程。
fn abandon(mut child: Child, stdin: Option<ChildStdin>) {
    let pid = child.id();
    drop(stdin);
    if wait_for_exit(&mut child, SHUTDOWN_GRACE).is_none() {
        kill_tree(pid);
        let _ = child.kill();
    }
    let _ = child.wait();
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let status = Command::new("taskkill")
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

#[cfg(not(windows))]
fn kill_tree(_pid: u32) {}

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
            r#"{"opencliHostReady":true,"port":54321,"pid":1234,"opencliVersion":"1.8.6","policyCommands":277}"#,
        );
        match ready {
            Verdict::Ready { port, policy_commands, .. } => {
                assert_eq!(port, 54321);
                assert_eq!(policy_commands, Some(277));
            }
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

        let terminated = wait_for_exit(&mut child, Duration::from_secs(5)).is_some();
        // 连坐没生效时这个 node 会一直活着,`child.wait()` 就会**永久悬挂**——
        // 断言失败必须失败得干脆,不能变成挂死的假绿(先收尸再断言)。
        if !terminated {
            let _ = child.kill();
        }
        let _ = child.wait();
        assert!(
            terminated,
            "job 句柄关闭后 5s 内子进程仍在跑 —— KILL_ON_JOB_CLOSE 没生效,I1 是假的"
        );
    }

    /// dist-host 必须镜像仓内相对拓扑(server 用相对 import,拍平必断)。
    #[test]
    fn host_entry_mirrors_dist_host_topology() {
        let entry = host_entry(Path::new("C:/app/resources"));
        let text = entry.to_string_lossy().replace('\\', "/");
        assert!(text.ends_with("host/server/index.mjs"), "got {text}");
    }
}
