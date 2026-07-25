mod host_supervisor;

use std::sync::Mutex;

use tauri::Manager;

use host_supervisor::{HostHandle, HostStartError};

/// Host 的启动结果。成功时握着句柄(退出时要 shutdown),失败时留着错误(T6 渲染错误视图)。
#[derive(Default)]
pub struct HostState {
    handle: Mutex<Option<HostHandle>>,
    boot_error: Mutex<Option<HostStartError>>,
}

impl HostState {
    /// 前端 boot 注入用的唯一事实源(T6)。
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

    /// 借出启动错误做渲染(T6),不移动所有权。
    pub fn with_boot_error<R>(&self, f: impl FnOnce(Option<&HostStartError>) -> R) -> R {
        let guard = self.boot_error.lock().unwrap_or_else(|e| e.into_inner());
        f(guard.as_ref())
    }
}

/// 预探测 node → 拉起 Host。两步的错误都落在同一个五(+1)分支枚举上(I5)。
fn boot_host(app: &tauri::AppHandle) -> Result<HostHandle, HostStartError> {
    let node_version = host_supervisor::probe_node()?;
    log::info!("[supervisor] node {node_version}");
    let resource_dir =
        app.path()
            .resource_dir()
            .map_err(|e| HostStartError::SupervisionUnavailable {
                detail: format!("无法解析 resource_dir: {e}"),
            })?;
    host_supervisor::start_host(&resource_dir)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // 单实例插件挂在 **Builder** 上:插件的 initialize 在 `Builder::build()` 里跑完,
        // 才轮到下面的 `.setup()` 钩子 —— 而 `boot_host` 在 setup 里。所以第二个实例
        // 一定在拉起第二个 Node 之前就被劝退,不会留下抢端口的孤儿(spec §5)。
        // (顺序保证来自"插件初始化早于 setup 钩子",**不是**来自 `.plugin()` 之间的先后。)
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // 日志**无条件注册**(release 也要):supervisor 把 Host 的 stdout/stderr 全量排空
        // 后转成 log 记录(spec §4),没有 logger 的话这些 `log::` 调用全是空操作 ——
        // 发布版一旦出问题就彻底没有诊断信息,而发布版恰恰是最需要它的地方。
        // 同样挂在 Builder 上,保证它先于 setup 里的 boot_host 就位。
        .plugin(
            tauri_plugin_log::Builder::default()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    // 落文件:发布版没有控制台,日志目录是唯一能事后翻的地方。
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
        .manage(HostState::default())
        .setup(|app| {
            // T6 接手这里:成功 → 用 state.port() 注入 boot 配置并建主窗;
            // 失败 → 按 error.kind() 路由到对应错误视图。本 task 只保证判定与托管正确。
            let state = app.state::<HostState>();
            match boot_host(app.handle()) {
                Ok(handle) => {
                    log::info!(
                        "[supervisor] Host 就绪:http://127.0.0.1:{} (pid={}, 通道1={}, 通道2={})",
                        handle.port,
                        handle.pid,
                        handle.job_attached(),
                        handle.parent_watch_attached()
                    );
                    state.set_handle(handle);
                }
                Err(error) => {
                    log::error!("[supervisor] Host 启动失败[{}]: {error}", error.kind());
                    state.set_boot_error(error);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        // 正常退出路径:关 stdin → 等 2s → taskkill → 放 Job 句柄。
        // 崩溃/强杀路径不走这里,由 Job Object 连坐兜底(I1)。
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            if let Some(handle) = app_handle.state::<HostState>().take_handle() {
                host_supervisor::shutdown(handle);
            }
        }
        _ => {}
    });
}
