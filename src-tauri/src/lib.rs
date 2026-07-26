mod host_supervisor;

use std::sync::Mutex;

use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

use host_supervisor::{HostHandle, HostStartError};

const MAIN_WINDOW_LABEL: &str = "main";
const ERROR_WINDOW_LABEL: &str = "error";

/// 错误页专用的 URI scheme。Windows 上 WebView2 不支持非标准 scheme,wry 会把
/// `opencli-error://localhost/x` 改写成 `http://opencli-error.localhost/x` 再交回我们的 handler。
const ERROR_SCHEME: &str = "opencli-error";

/// 错误页**编译进 exe**,既不走 `frontendDist` 也不走 `resources`:
/// 它要显示的失败里就包含「resource 目录解析失败」,让错误页自己依赖资源,
/// 等于在最需要它的那条路径上白屏。
const ERROR_PAGE_HTML: &str = include_str!("../error.html");

/// 错误页的 CSP 由我们自己发 —— 自定义 scheme 的响应**不经过** Tauri 的 CSP 注入
/// (那条只作用于内置 asset 协议)。页面唯一的脚本就是它自带的那段内联脚本,
/// 除此之外不许加载、不许连接任何东西。
const ERROR_PAGE_CSP: &str =
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

/// 错误详情进 query 的字符上限。stderr 尾部有 40 行的上限,但**单行**可以任意长
/// (一条巨大的 JS 栈就够),百分号编码后还要再涨几倍。截断只影响页面这一份 ——
/// 全文一直在日志里(supervisor 把每一行 stderr 都转成了 log)。
const DETAIL_MAX_CHARS: usize = 4000;

/// Host 的启动结果。成功时握着句柄(退出时要 shutdown),失败时留着错误(渲染错误视图)。
#[derive(Default)]
pub struct HostState {
    handle: Mutex<Option<HostHandle>>,
    boot_error: Mutex<Option<HostStartError>>,
}

impl HostState {
    /// 前端 boot 注入用的唯一事实源。
    pub fn port(&self) -> Option<u16> {
        self.handle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|handle| handle.port)
    }

    fn set_handle(&self, handle: HostHandle) {
        *self.handle.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
    }

    /// 取走句柄(退出收尾用)。取过一次即为 None,重复的退出事件不会二次收尾。
    pub fn take_handle(&self) -> Option<HostHandle> {
        self.handle.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    fn set_boot_error(&self, error: HostStartError) {
        *self.boot_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(error);
    }

    /// 借出启动错误做渲染/诊断,不移动所有权。
    pub fn with_boot_error<R>(&self, f: impl FnOnce(Option<&HostStartError>) -> R) -> R {
        let guard = self.boot_error.lock().unwrap_or_else(|e| e.into_inner());
        f(guard.as_ref())
    }
}

/// 预探测 node → 拉起 Host。两步的错误都落在同一个五(+1)分支枚举上(I5)。
fn boot_host(app: &tauri::AppHandle) -> Result<HostHandle, HostStartError> {
    let node_version = host_supervisor::probe_node()?;
    log::info!("[supervisor] node {node_version}");
    // 用 BaseDirectory::Resource 解析,不手工拼 resource 路径(spec §8)——
    // resource 根在 dev / 打包下位置不同,自己 join 迟早在某个形态上错。
    let entry = app
        .path()
        .resolve(
            host_supervisor::HOST_ENTRY_RESOURCE,
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| HostStartError::SupervisionUnavailable {
            detail: format!(
                "无法解析 Host 入口资源 {}: {e}",
                host_supervisor::HOST_ENTRY_RESOURCE
            ),
        })?;
    host_supervisor::start_host(&node_friendly(entry))
}

/// tauri 的 resource 解析交回来的是 Windows **verbatim 路径**(`\\?\C:\…`),而 node 的模块
/// 解析器不认这个前缀 —— 真机实测:`node \\?\C:\…\server\index.mjs` 会把 `\\?\C:` 当成 UNC 根,
/// 当场 `Error: EISDIR: illegal operation on a directory, lstat 'C:'` 并以 1 退出。
/// 现象是"Host 异常退出",看着像 Host 的问题,实际是**路径形状**的问题;不还原就等于
/// 打包后的应用永远起不来 Host。
///
/// 用 dunce 而不是手撕前缀:它只在能安全还原时才动手(真 UNC / 超长路径会原样返回)。
fn node_friendly(path: std::path::PathBuf) -> std::path::PathBuf {
    dunce::simplified(&path).to_path_buf()
}

/// 启动流程整体搬离主线程 —— spec §10 的头一条风险。
///
/// 上游实证(tauri-2.11.5 `app.rs`):配置里声明的窗口**先于**用户 `setup` 创建,而 `setup`
/// 由 `Ready` 事件在**主线程事件循环内**触发。于是"配置建窗 + setup 里同步 boot"这套组合,
/// 在失败路径上必然给出一个 20s 量级不响应的冻结白窗(probe 5s + readiness 15s,Windows 会
/// 直接给它标上"未响应")—— 而那恰恰是错误视图该出场的路径。所以两件事一起做,缺一不可:
///
/// * `tauri.conf.json` 的 `app.windows` 置空 —— 谁都别替我们提前建窗;
/// * boot 扔到后台线程 —— 主线程只管泵事件循环,判定出来了再回头建窗。
///
/// 跨线程建窗是 tauri 明确支持的用法:builder 把请求派回主线程,调用方阻塞等结果 ——
/// 阻塞的是这条后台线程,主线程始终在泵事件。
fn spawn_boot(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || match boot_host(&app) {
        Ok(handle) => {
            let (port, pid) = (handle.port, handle.pid);
            app.state::<HostState>().set_handle(handle);
            log::info!("[boot] Host 就绪(port={port} pid={pid}),建主窗并注入 boot 配置");
            if let Err(e) = open_main_window(&app, port, pid) {
                // 没有窗口的活进程 = 用户只能去任务管理器杀的隐形态,比退出更糟。
                // 退出会走 RunEvent::Exit → shutdown(handle),Host 一并收掉。
                log::error!("[boot] 主窗创建失败,退出: {e}");
                app.exit(1);
            }
        }
        Err(error) => {
            log::error!("[boot] Host 启动失败[{}]: {error}", error.kind());
            let log_dir = app
                .path()
                .app_log_dir()
                .ok()
                .map(|dir| dir.to_string_lossy().into_owned());
            let url = error_view_url(&error, log_dir.as_deref());
            app.state::<HostState>().set_boot_error(error);
            if let Err(e) = open_error_window(&app, url) {
                log::error!("[boot] 错误视图创建失败,退出: {e}");
                app.exit(1);
            }
        }
    });
}

/// 注入给前端的唯一事实源:`window.__OPENCLI_BOOT__`(T7 消费)。
///
/// 用 serde_json 序列化而不是手拼字符串 —— 手拼出来的是"看着像 JSON 的 JS 源码",
/// 值里任何一个引号都能越狱成可执行代码。这里的 port/pid 是数字、本就无从注入,
/// 但注入脚本这条路必须默认按不可信处理,别给后面加字段的人留坑。
fn boot_script(port: u16, pid: u32) -> String {
    let boot = serde_json::json!({
        "baseUrl": format!("http://127.0.0.1:{port}"),
        "hostPid": pid,
    });
    // Value 的 Display 就是紧凑序列化,不会失败(所以这里没有 Result 要 unwrap)。
    format!("window.__OPENCLI_BOOT__ = {boot};")
}

fn open_main_window(app: &tauri::AppHandle, port: u16, pid: u32) -> tauri::Result<()> {
    WebviewWindowBuilder::new(
        app,
        MAIN_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("OpenCLI App Clone")
    .inner_size(1280.0, 800.0)
    .min_inner_size(960.0, 600.0)
    .center()
    // **页面加载前**执行:晚一步前端就已经读过 window.__OPENCLI_BOOT__ 了。
    .initialization_script(boot_script(port, pid))
    .build()?;
    Ok(())
}

/// 错误页要显示的动态部分。固定文案(标题 / 怎么修)在 `error.html` 里按 kind 分派,
/// 这边只供"这一次到底发生了什么"。
struct ErrorView {
    summary: String,
    detail: Option<String>,
}

/// 六个分支各自的用户可见文案。**穷尽 match**:`HostStartError` 以后加变体,这里直接
/// 编译不过 —— 比"记得去补一个分支"可靠得多,漏分支的代价是那条失败路径没有视图。
fn error_view(error: &HostStartError) -> ErrorView {
    match error {
        HostStartError::NodeMissing { detail } => ErrorView {
            summary: format!(
                "没能执行 node（需要 {}）",
                host_supervisor::NODE_REQUIRED
            ),
            detail: detail_of(detail),
        },
        HostStartError::NodeTooOld { found, required } => ErrorView {
            summary: format!("检测到 {found}，需要 {required}"),
            detail: None,
        },
        // 协议内失败:文案直接用 Host 自己给的,不加工 —— 它比我们更清楚发生了什么。
        HostStartError::HostReportedFailure { summary, detail } => ErrorView {
            summary: summary.clone(),
            detail: detail.as_deref().and_then(detail_of),
        },
        HostStartError::ReadinessTimeout { stderr_tail } => ErrorView {
            summary: "Host 进程还在运行，但一直没有报告就绪".to_string(),
            detail: detail_of(stderr_tail),
        },
        HostStartError::ProcessFailed { code, stderr_tail } => ErrorView {
            summary: match code {
                Some(code) => format!("Host 进程已退出（退出码 {code}）"),
                None => "Host 进程已退出（退出码未知）".to_string(),
            },
            detail: detail_of(stderr_tail),
        },
        HostStartError::SupervisionUnavailable { detail } => ErrorView {
            summary: "两条进程回收通道都不可用，应用主动拒绝了启动".to_string(),
            detail: detail_of(detail),
        },
    }
}

/// 空的 stderr 尾部不值得占一块面板;超长的截断掉(全文见日志)。
fn detail_of(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(clamp(trimmed, DETAIL_MAX_CHARS))
}

/// 按**字符**截断,不是字节:中文 stderr 按字节切会切出半个字。
fn clamp(text: &str, max_chars: usize) -> String {
    let mut out: String = text.chars().take(max_chars).collect();
    if text.chars().nth(max_chars).is_some() {
        out.push_str("\n…（已截断，完整内容见日志）");
    }
    out
}

/// 组装错误视图 URL。`log_dir` 由调用方传入,这样这个函数是纯的、可以单测。
fn error_view_url(error: &HostStartError, log_dir: Option<&str>) -> Url {
    let view = error_view(error);
    let mut url = Url::parse(&format!("{ERROR_SCHEME}://localhost/index.html"))
        .expect("错误页 URL 由常量拼成,解析不会失败");
    {
        // `append_pair` 负责百分号编码:detail 装的是 Host 的 stderr,里面出现
        // `&` `#` `=` 换行是常态,不编码就会把 query 拆散、甚至伪造出别的字段。
        // 页面侧再一律用 textContent 渲染 —— 两头合起来才叫"安全地显示不可信文本"。
        let mut query = url.query_pairs_mut();
        query.append_pair("kind", error.kind());
        query.append_pair("summary", &view.summary);
        if let Some(detail) = &view.detail {
            query.append_pair("detail", detail);
        }
        if let Some(log_dir) = log_dir {
            query.append_pair("logDir", log_dir);
        }
    }
    url
}

fn open_error_window(app: &tauri::AppHandle, url: Url) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, ERROR_WINDOW_LABEL, WebviewUrl::CustomProtocol(url))
        .title("OpenCLI App Clone — 启动失败")
        .inner_size(780.0, 560.0)
        .center()
        .build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // 单实例插件挂在 **Builder** 上:插件的 initialize 在 `Builder::build()` 里跑完,
        // 才轮到下面的 `.setup()` 钩子 —— 而 boot 在 setup 里起线程。所以第二个实例
        // 一定在拉起第二个 Node 之前就被劝退,不会留下抢端口的孤儿(spec §5)。
        // (顺序保证来自"插件初始化早于 setup 钩子",**不是**来自 `.plugin()` 之间的先后。)
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 主窗**或**错误窗:启动失败时压根没有 "main",只认 main 的话第二次点图标毫无反应。
            for label in [MAIN_WINDOW_LABEL, ERROR_WINDOW_LABEL] {
                if let Some(window) = app.get_webview_window(label) {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                    break;
                }
            }
        }))
        // 日志**无条件注册**(release 也要):supervisor 把 Host 的 stdout/stderr 全量排空
        // 后转成 log 记录(spec §4),没有 logger 的话这些 `log::` 调用全是空操作 ——
        // 发布版一旦出问题就彻底没有诊断信息,而发布版恰恰是最需要它的地方。
        // 同样挂在 Builder 上,保证它先于 setup 里的 boot 就位。
        .plugin(
            tauri_plugin_log::Builder::default()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    // 落文件:发布版没有控制台,日志目录是唯一能事后翻的地方
                    // (错误页会把这个目录显示给用户)。
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .build(),
        )
        // 错误页的供给通道:内容内嵌在 exe 里,一个字节都不依赖 frontendDist / resources。
        .register_uri_scheme_protocol(ERROR_SCHEME, |_ctx, _request| {
            tauri::http::Response::builder()
                .header(
                    tauri::http::header::CONTENT_TYPE,
                    "text/html; charset=utf-8",
                )
                .header("Content-Security-Policy", ERROR_PAGE_CSP)
                .body(ERROR_PAGE_HTML.as_bytes())
                .expect("错误页响应由常量构成,构造不会失败")
        })
        .manage(HostState::default())
        .setup(|app| {
            // 只负责点火。判定、建窗全在后台线程里,主线程立刻回去泵事件循环
            // —— 这就是"失败路径不再冻结白窗"的全部机制。
            spawn_boot(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        // 正常退出路径:关 stdin → 等 2s → taskkill → 放 Job 句柄。
        // 崩溃/强杀路径不走这里,由 Job Object 连坐兜底(I1);boot 线程还没交出句柄时
        // 退出也一样 —— 句柄在那条线程的栈上,进程一没,内核照样连坐。
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            if let Some(handle) = app_handle.state::<HostState>().take_handle() {
                host_supervisor::shutdown(handle);
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 六个分支各造一个样本。**新增变体不会被这里漏掉**:`error_view` 是穷尽 match,
    /// 加变体先在编译期红,补完分支自然会想起来补这里和 error.html。
    fn samples() -> Vec<HostStartError> {
        vec![
            HostStartError::NodeMissing {
                detail: "`node --version` 无法执行".to_string(),
            },
            HostStartError::NodeTooOld {
                found: "v18.20.4".to_string(),
                required: host_supervisor::NODE_REQUIRED,
            },
            HostStartError::HostReportedFailure {
                summary: "catalog 快照缺失".to_string(),
                detail: Some("public/catalog.snapshot.json 不存在".to_string()),
            },
            HostStartError::ReadinessTimeout {
                stderr_tail: "still loading".to_string(),
            },
            HostStartError::ProcessFailed {
                code: Some(1),
                stderr_tail: "Error: EADDRINUSE".to_string(),
            },
            HostStartError::SupervisionUnavailable {
                detail: "两条清理通道都不成立".to_string(),
            },
        ]
    }

    /// **六个 kind 一个都不能漏**(spec §4 脚注:漏 `supervision-unavailable`
    /// 会让 fail-closed 直接变白屏)。断言对象就是内嵌的 error.html ——
    /// 每个 kind 必须是页面分派表里的一个 key,而不只是文档里的一句承诺。
    #[test]
    fn every_error_kind_is_routed_by_the_error_page() {
        for error in samples() {
            let key = format!("'{}':", error.kind());
            assert!(
                ERROR_PAGE_HTML.contains(&key),
                "error.html 的 VIEWS 里没有 {key} —— 这条失败路径只能落到兜底文案上"
            );
            assert!(
                !error_view(&error).summary.trim().is_empty(),
                "{} 的 summary 是空的,页面上会只剩标题",
                error.kind()
            );
        }
    }

    // 兜底视图(未登记的 kind 也得有东西可看)的守卫**不在这里**:
    // 原先这里断言 `ERROR_PAGE_HTML.contains("var UNKNOWN")`,守的是源码字面量而非行为——
    // 把 `var` 改成 `const` 会误红,保留 `var UNKNOWN` 但不再使用它则会假绿。两头都不对。
    // 真正执行页面脚本的守卫在 `src/errorPage.test.ts`(jsdom `runScripts`),
    // 兜底、原型链键、detail/logDir 显隐、文本转义都在那里按行为断言。
    //
    // 上面那条 `every_error_kind_is_routed_by_the_error_page` 保留:它守的是**跨语言配对**
    // (Rust 的 kind() 字面量 ↔ HTML 的 VIEWS 键),这一层 JS 侧看不到,只能在 Rust 侧断。

    /// query 里装的是 Host 的 stderr —— 出现 `&` `#` `=` 换行是常态。
    /// 编码没做对,detail 就能把 query 拆散、伪造出第二个 `kind`,页面读到的是被污染的信息。
    #[test]
    fn untrusted_text_survives_the_query_round_trip() {
        let nasty = "a&kind=spoofed#frag=1\n<script>alert(1)</script> 中文 100%";
        let error = HostStartError::HostReportedFailure {
            summary: nasty.to_string(),
            detail: Some(nasty.to_string()),
        };
        let url = error_view_url(&error, Some(r"C:\Users\x\logs"));
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let get = |key: &str| {
            pairs
                .iter()
                .filter(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
                .collect::<Vec<_>>()
        };

        assert_eq!(url.scheme(), ERROR_SCHEME);
        assert!(url.fragment().is_none(), "`#` 必须被编码,不能变成 fragment");
        assert_eq!(
            get("kind"),
            vec!["host-reported-failure".to_string()],
            "kind 只能有一份 —— 出现第二份就说明 detail 把 query 拆散了"
        );
        assert_eq!(get("summary"), vec![nasty.to_string()]);
        assert_eq!(get("detail"), vec![nasty.to_string()]);
        assert_eq!(get("logDir"), vec![r"C:\Users\x\logs".to_string()]);
    }

    /// 注入进页面的 boot 配置必须是 **JSON 字面量**,且形状固定(T7 的前端按这个契约读)。
    #[test]
    fn boot_script_injects_a_json_literal() {
        let script = boot_script(54321, 4242);
        let json = script
            .strip_prefix("window.__OPENCLI_BOOT__ = ")
            .and_then(|s| s.strip_suffix(';'))
            .expect("形状必须是 `window.__OPENCLI_BOOT__ = <json>;`");
        let value: serde_json::Value =
            serde_json::from_str(json).expect("注入的必须是合法 JSON,不是手拼的 JS");
        assert_eq!(value["baseUrl"], "http://127.0.0.1:54321");
        assert_eq!(value["hostPid"], 4242);
    }

    /// 回归钉:交给 node 的入口路径**不能**带 verbatim 前缀。
    /// 这不是理论洁癖 —— 带 `\\?\` 的路径会让 Host 以 EISDIR 秒退(真机实测),
    /// 而错误面上显示的是"Host 异常退出",足以让人去查 Host 而不是查路径。
    #[test]
    fn resource_path_is_handed_to_node_without_the_verbatim_prefix() {
        assert_eq!(
            node_friendly(std::path::PathBuf::from(
                r"\\?\C:\app\host\server\index.mjs"
            )),
            std::path::PathBuf::from(r"C:\app\host\server\index.mjs")
        );
    }

    /// 空 stderr 不占面板;超长 stderr 截断(URL 有长度上限,全文在日志里)。
    #[test]
    fn detail_is_dropped_when_empty_and_clamped_when_huge() {
        assert!(detail_of("   \n  ").is_none());
        assert_eq!(detail_of(" boom \n").as_deref(), Some("boom"));

        let huge = "字".repeat(DETAIL_MAX_CHARS + 100);
        let clamped = detail_of(&huge).expect("非空");
        assert!(clamped.chars().count() < huge.chars().count());
        assert!(clamped.contains("已截断"));
    }
}
