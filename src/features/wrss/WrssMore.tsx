import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useGlassMenuSurface } from "../../components/GlassMenu";
import {
  fetchVkWrssManagedStatus,
  type WrssManagedStatus,
} from "../../host/vkClient";
import {
  addFeaturedArticle,
  cleanWrssArticles,
  clearWrssCache,
  fetchFeaturedTask,
  importSubscriptions,
  logoutWechat,
  subscriptionExportUrl,
  type WrssAuthState,
  type WrssView,
} from "./wrssClient";
import { downloadWrssFile } from "./wrssExternal";

const text = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败";
const wait = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        resolve();
      },
      cancel = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        reject(new DOMException("已取消", "AbortError"));
      },
      timer = window.setTimeout(done, 1000);
    signal.addEventListener("abort", cancel, { once: true });
  });

export default function WrssMore({
  baseUrl,
  mode,
  auth,
  activeView,
  onNavigate,
  onAddSource,
  onAuthChange,
  onRefresh,
  onError,
}: {
  baseUrl?: string;
  mode: "preview" | "real";
  auth: WrssAuthState | null;
  activeView: WrssView;
  onNavigate: (view: WrssView) => void;
  onAddSource: () => void;
  onAuthChange: (state: WrssAuthState) => void;
  onRefresh: () => void;
  onError?: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false),
    [articleOpen, setArticleOpen] = useState(false),
    [url, setUrl] = useState(""),
    [task, setTask] = useState(""),
    [taskPending, setTaskPending] = useState(false),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [diagnostics, setDiagnostics] = useState<WrssManagedStatus | null>(null),
    [diagnosticError, setDiagnosticError] = useState(""),
    [diagnosticOpen, setDiagnosticOpen] = useState(false),
    [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const poll = useRef<AbortController | null>(null),
    root = useRef<HTMLDivElement>(null),
    menu = useRef<HTMLDivElement>(null);
  useGlassMenuSurface(menu, open);
  useEffect(() => () => poll.current?.abort(), []);
  useEffect(() => setOpen(false), [activeView]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = root.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(300, window.innerWidth - 28),
        left = Math.max(
          14,
          Math.min(rect.right - width, window.innerWidth - width - 14),
        ),
        menuHeight = menu.current?.getBoundingClientRect().height ?? 0,
        below = window.innerHeight - rect.bottom - 22,
        above = rect.top - 22,
        top = below < Math.min(menuHeight, 240) && above > below
          ? Math.max(14, rect.top - menuHeight - 8)
          : rect.bottom + 8;
      setMenuStyle({
        width,
        left,
        top,
        maxHeight: Math.max(160, window.innerHeight - top - 14),
      });
    };
    place();
    const pointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  const fail = (error: unknown) => {
    setMessage(text(error));
    onError?.(error);
  };
  const loadDiagnostics = useCallback(async () => {
    try {
      setDiagnostics(await fetchVkWrssManagedStatus(baseUrl));
      setDiagnosticError("");
    } catch (error) {
      setDiagnosticError(text(error));
    }
  }, [baseUrl]);
  useEffect(() => {
    if (open && diagnosticOpen) void loadDiagnostics();
  }, [diagnosticOpen, loadDiagnostics, open]);
  const pollTask = async (taskId: string, controller: AbortController) => {
    let current: any = { status: "pending" };
    for (let i = 0; i < 60 && !controller.signal.aborted; i++) {
      current = await fetchFeaturedTask(baseUrl, taskId, controller.signal);
      if (["success", "completed", "failed"].includes(current?.status)) break;
      await wait(controller.signal);
    }
    if (controller.signal.aborted) return;
    if (current?.status === "failed") {
      setTaskPending(false);
      throw new Error(current.message || "单篇收录失败");
    }
    if (current?.status === "success" || current?.status === "completed") {
      setTaskPending(false);
      setMessage("单篇收录完成");
      onRefresh();
    } else {
      setTaskPending(true);
      setMessage("任务仍在处理中，可重试查询");
    }
  };
  const collect = async () => {
    poll.current?.abort();
    const controller = new AbortController();
    poll.current = controller;
    setBusy(true);
    try {
      let taskId = task;
      if (!taskPending || !taskId) {
        setMessage("正在提交单篇收录…");
        const created: any = await addFeaturedArticle(
          baseUrl,
          url,
          controller.signal,
        );
        taskId = created?.task_id || "";
        setTask(taskId);
        setTaskPending(Boolean(taskId));
        if (!taskId) throw new Error("收录任务未返回任务编号");
      } else setMessage("正在继续查询收录任务…");
      await pollTask(taskId, controller);
    } catch (error) {
      if ((error as Error).name !== "AbortError") fail(error);
    } finally {
      if (poll.current === controller) poll.current = null;
      setBusy(false);
    }
  };
  const cleanup = async (kind: "orphan" | "duplicate" | "old") => {
    const label =
      kind === "orphan"
        ? "失效文章"
        : kind === "duplicate"
          ? "重复文章"
          : "30 天前的旧文章";
    if (!window.confirm(`确认清理${label}？`)) return;
    setBusy(true);
    try {
      const result: any = await cleanWrssArticles(
        baseUrl,
        kind,
        kind === "old" ? { days: 30 } : {},
      );
      setMessage(result?.message || `${label}清理完成`);
      onRefresh();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      await importSubscriptions(baseUrl, file);
      setMessage("订阅已导入");
      onRefresh();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  };
  const logout = async () => {
    setBusy(true);
    try {
      await logoutWechat(baseUrl);
      clearWrssCache();
      onAuthChange({ login: false });
      setMessage("已退出微信授权");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  const exportSubscriptions = async (format: "csv" | "opml") => {
    try {
      await downloadWrssFile(
        subscriptionExportUrl(baseUrl, format),
        `subscriptions.${format}`,
      );
      setMessage(`订阅 ${format.toUpperCase()} 已保存`);
    } catch (error) {
      fail(error);
    }
  };
  const closeArticle = () => {
    poll.current?.abort();
    setArticleOpen(false);
  };
  return (
    <div className="wrss-more" ref={root}>
      <button aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        更多
      </button>
      {open && createPortal(
        <div ref={menu} className="wrss-more-menu glass-menu-effect" role="menu" style={menuStyle}>
          <section className="wrss-more-group" aria-label="账户与数据">
          <strong>账户与数据</strong>
          <button
            onClick={() => {
              onNavigate("authorization");
              setOpen(false);
            }}
          >
            授权管理
          </button>
          <button
            onClick={() => {
              onNavigate("exports");
              setOpen(false);
            }}
          >
            导出记录
          </button>
          <button
            onClick={() => {
              onAddSource();
              setOpen(false);
            }}
          >
            添加公众号
          </button>
          <button
            onClick={() => {
              onRefresh();
              setMessage("已刷新公众号数据");
              setOpen(false);
            }}
          >
            刷新公众号数据
          </button>
          </section>
          <section className="wrss-more-group" aria-label="内容工具">
          <strong>内容工具</strong>
          <button
            onClick={() => {
              setArticleOpen(true);
              setOpen(false);
            }}
          >
            单篇收录
          </button>
          <details>
            <summary>文章清理</summary>
            <button disabled={busy} onClick={() => void cleanup("orphan")}>
              清理失效文章
            </button>
            <button disabled={busy} onClick={() => void cleanup("duplicate")}>
              清理重复文章
            </button>
            <button disabled={busy} onClick={() => void cleanup("old")}>
              清理 30 天前文章
            </button>
          </details>
          </section>
          <section className="wrss-more-group" aria-label="订阅管理">
          <strong>订阅管理</strong>
          <details>
            <summary>订阅导入/导出</summary>
            <label>
              导入 CSV
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => void importFile(event)}
              />
            </label>
            <button onClick={() => void exportSubscriptions("csv")}>导出 CSV</button>
            <button onClick={() => void exportSubscriptions("opml")}>导出 OPML</button>
          </details>
          </section>
          <details
            className="wrss-diagnostics"
            open={diagnosticOpen}
            onToggle={(event) =>
              setDiagnosticOpen((event.currentTarget as HTMLDetailsElement).open)
            }
          >
            <summary>设置与诊断</summary>
            <dl>
              <dt>模式</dt>
              <dd>{mode === "preview" ? "预览数据" : "真实数据"}</dd>
              <dt>Host</dt>
              <dd>{baseUrl || "http://127.0.0.1:43117"}</dd>
              {diagnostics && (
                <>
                  <dt>状态</dt>
                  <dd>{diagnostics.state}</dd>
                  <dt>摘要</dt>
                  <dd>{diagnostics.summary}</dd>
                </>
              )}
            </dl>
            {diagnostics?.progress_log.length ? (
              <pre aria-label="诊断日志">
                {diagnostics.progress_log.slice(-3).join("\n")}
              </pre>
            ) : null}
            {diagnosticError && <span role="alert">{diagnosticError}</span>}
            <button onClick={() => void loadDiagnostics()}>刷新诊断</button>
          </details>
          {auth?.login && (
            <button disabled={busy} onClick={() => void logout()}>
              退出登录
            </button>
          )}
        </div>,
        document.body,
      )}
      {articleOpen && (
        <div className="wrss-modal" role="dialog" aria-label="单篇收录">
          <h3>单篇收录</h3>
          <input
            aria-label="公众号文章链接"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              if (event.target.value !== url) {
                setTask("");
                setTaskPending(false);
              }
            }}
            placeholder="粘贴公众号文章链接"
          />
          <button disabled={busy || !url.trim()} onClick={() => void collect()}>
            {taskPending ? "继续查询" : "提交收录"}
          </button>
          {task && <p>任务：{task}</p>}
          {message && <p role="status">{message}</p>}
          <button onClick={closeArticle}>关闭</button>
        </div>
      )}
      {!articleOpen && message && (
        <p className="wrss-more-message" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
