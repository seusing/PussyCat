import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import { EmptyState } from "../../components/EmptyState";
import { GlassSelect } from "../../components/GlassMenu";
import {
  addWrssSource,
  deleteWrssSource,
  fetchWrssSources,
  importSubscriptions,
  lookupWrssArticleSource,
  searchWrssSources,
  sourceAvatarUrl,
  subscriptionExportUrl,
  toggleWrssSource,
  updateAllWrssSources,
  updateWrssSource,
  type WrssSource,
} from "./wrssClient";
import { downloadWrssFile } from "./wrssExternal";
import type { WrssSyncManager } from "./useWrssSyncManager";

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败";
const avatarCache = new Map<string, string>();

function SourceAvatar({
  baseUrl,
  source,
  active,
}: {
  baseUrl?: string;
  source: WrssSource;
  active: boolean;
}) {
  const key = `${baseUrl ?? ""}:${source.id}:${source.avatar ?? ""}`,
    [image, setImage] = useState(() => avatarCache.get(key) ?? "");
  useEffect(() => {
    setImage(avatarCache.get(key) ?? "");
    if (!active || !source.avatar || avatarCache.has(key)) return;
    const controller = new AbortController();
    let disposed = false;
    fetch(sourceAvatarUrl(baseUrl, source.id), {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("头像加载失败");
        return response.blob();
      })
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          }),
      )
      .then((value) => {
        if (disposed) return;
        avatarCache.set(key, value);
        setImage(value);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [active, baseUrl, key, source.avatar, source.id]);
  return image ? (
    <img src={image} alt="" onError={() => setImage("")} />
  ) : (
    <span className="wrss-source-avatar" aria-hidden="true">
      {source.name.slice(0, 1)}
    </span>
  );
}

export default function WrssSourceDeck({
  baseUrl,
  active: activeView = true,
  onOpen,
  onError,
  refreshToken = 0,
  addToken = 0,
  syncManager,
}: {
  baseUrl?: string;
  active?: boolean;
  onOpen: (id: string, name: string) => void;
  onError?: (error: unknown) => void;
  refreshToken?: number;
  addToken?: number;
  syncManager?: WrssSyncManager;
}) {
  const [sources, setSources] = useState<WrssSource[]>([]),
    [active, setActive] = useState(0),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [failedPage, setFailedPage] = useState<number | null>(null),
    [status, setStatus] = useState<"all" | "enabled" | "disabled">("all"),
    [addOpen, setAddOpen] = useState(false),
    [manual, setManual] = useState({
      mp_id: "",
      mp_name: "",
      avatar: "",
      mp_intro: "",
    }),
    [remoteQuery, setRemoteQuery] = useState(""),
    [remote, setRemote] = useState<WrssSource[]>([]),
    [articleUrl, setArticleUrl] = useState(""),
    [message, setMessage] = useState(""),
    [syncIssue, setSyncIssue] = useState(""),
    [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const limit = 10,
    requestId = useRef(0),
    requestController = useRef<AbortController | null>(null),
    lastWheel = useRef(0),
    deckRef = useRef<HTMLDivElement>(null),
    lastRefreshToken = useRef(refreshToken),
    lastAddToken = useRef(0);
  const statusValue =
    status === "all" ? undefined : status === "enabled" ? 1 : 0;
  const syncCooldownSeconds = Math.max(0, (syncManager?.cooldownUntil ?? 0) - now);
  const syncBusy = !!syncManager?.tasks.some((task) => task.status === "queued" || task.status === "running");
  useEffect(() => {
    if (!syncManager?.tasks.length) return;
    const relevant = syncManager.tasks;
    const blocked = relevant.find((task) => task.status === "blocked");
    const failed = relevant.find((task) => task.status === "failed");
    const running = relevant.find((task) => task.status === "running" || task.status === "queued");
    const succeeded = [...relevant].reverse().find((task) => task.status === "succeeded");
    const task = blocked ?? failed ?? running ?? succeeded;
    if (!task) return;
    if (task.status === "blocked" || task.status === "failed") {
      setMessage("");
      setSyncIssue(task.message);
    } else if (task.status === "succeeded") {
      setSyncIssue("");
      setMessage(task.added ? `抓取完成，新增 ${task.added} 篇文章` : "抓取完成，没有新增文章");
    } else {
      setSyncIssue("");
      setMessage(task.message || "正在更新公众号文章");
    }
  }, [syncManager?.tasks]);
  useEffect(() => () => avatarCache.clear(), []);
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    if ((syncManager?.cooldownUntil ?? 0) <= Math.floor(Date.now() / 1000)) return;
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [syncManager?.cooldownUntil]);
  const loadPage = useCallback(
    async (targetPage: number, force = false) => {
      const id = ++requestId.current;
      requestController.current?.abort();
      const controller = new AbortController();
      requestController.current = controller;
      setLoading(true);
      try {
        const value = await fetchWrssSources(
          baseUrl,
          query,
          targetPage,
          limit,
          force,
          statusValue,
          controller.signal,
        );
        if (id !== requestId.current) return;
        setSources((current) =>
          targetPage === 1
            ? value.list
            : [
                ...current,
                ...value.list.filter(
                  (next) => !current.some((item) => item.id === next.id),
                ),
              ],
        );
        setPage(targetPage);
        setTotal(value.total);
        setError(null);
        setFailedPage(null);
      } catch (cause) {
        if ((cause as Error).name === "AbortError") return;
        if (id !== requestId.current) return;
        setError(messageOf(cause));
        setFailedPage(targetPage);
        onError?.(cause);
      } finally {
        if (requestController.current === controller)
          requestController.current = null;
        if (id === requestId.current) setLoading(false);
      }
    },
    [baseUrl, onError, query, statusValue],
  );
  const reloadFirst = useCallback(
    (force = true) => {
      setActive(0);
      return loadPage(1, force);
    },
    [loadPage],
  );
  useEffect(() => {
    if (!activeView) {
      requestId.current++;
      requestController.current?.abort();
      return;
    }
    const force = lastRefreshToken.current !== refreshToken;
    lastRefreshToken.current = refreshToken;
    if (sources.length === 0 || force) void loadPage(1, force);
    return () => {
      requestId.current++;
      requestController.current?.abort();
    };
  }, [activeView, loadPage, refreshToken, sources.length]);
  useEffect(() => {
    if (addToken !== lastAddToken.current) {
      lastAddToken.current = addToken;
      setAddOpen(true);
    }
  }, [addToken]);
  useEffect(() => {
    if (
      activeView &&
      !error &&
      active >= sources.length - 2 &&
      sources.length < total &&
      !loading
    )
      void loadPage(page + 1);
  }, [
    active,
    activeView,
    error,
    loadPage,
    loading,
    page,
    sources.length,
    total,
  ]);
  useEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;
    const wheel = (event: WheelEvent) => {
      const delta =
        Math.abs(event.deltaY) >= Math.abs(event.deltaX)
          ? event.deltaY
          : event.deltaX;
      if (Math.abs(delta) < 8) return;
      event.preventDefault();
      const now = Date.now();
      if (now - lastWheel.current < 180) return;
      lastWheel.current = now;
      setActive((value) =>
        Math.max(0, Math.min(sources.length - 1, value + (delta > 0 ? 1 : -1))),
      );
    };
    deck.addEventListener("wheel", wheel, { passive: false });
    return () => deck.removeEventListener("wheel", wheel);
  }, [sources.length]);
  const visible = useMemo(
    () =>
      sources.map((source, index) => ({
        source,
        index,
        distance: index - active,
      })),
    [sources, active],
  );
  const move = (change: number) =>
    setActive((value) =>
      Math.max(0, Math.min(sources.length - 1, value + change)),
    );
  const changeQuery = (value: string) => {
    requestId.current++;
    setQuery(value);
    setSources([]);
    setTotal(0);
    setPage(1);
    setActive(0);
  };
  const changeStatus = (value: typeof status) => {
    requestId.current++;
    setStatus(value);
    setSources([]);
    setTotal(0);
    setPage(1);
    setActive(0);
  };
  const submitAll = async () => {
    try {
      const result = syncManager ? await syncManager.submitAll() : await updateAllWrssSources(baseUrl);
      setMessage(
        result.failed
          ? `已提交 ${result.submitted} 个更新任务，${result.failed} 个失败`
          : `已提交 ${result.submitted} 个更新任务`,
      );
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
      onError?.(cause);
    }
  };
  const add = async (data: {
    mp_id: string;
    mp_name: string;
    avatar: string;
    mp_intro?: string;
  }) => {
    try {
      const result = await addWrssSource(baseUrl, data);
      if (result.syncTask) syncManager?.trackSubmitted(result.syncTask);
      setMessage(result.syncTask ? "公众号已添加，文章更新任务已提交" : "公众号已添加");
      setError(null);
      await reloadFirst();
    } catch (cause) {
      setError(messageOf(cause));
      onError?.(cause);
    }
  };
  const searchRemote = async () => {
    try {
      setRemote((await searchWrssSources(baseUrl, remoteQuery)).list);
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
      onError?.(cause);
    }
  };
  const addByArticle = async () => {
    try {
      const found: any = await lookupWrssArticleSource(baseUrl, articleUrl),
        info = found?.mp_info,
        biz = info?.biz;
      if (found?.fetch_error || !biz)
        throw new Error(found?.fetch_error || "未从文章中识别到公众号");
      await add({
        mp_id: biz,
        mp_name: info.mp_name || "",
        avatar: info.logo || "",
        mp_intro: "",
      });
    } catch (cause) {
      setError(messageOf(cause));
      onError?.(cause);
    }
  };
  const remove = async (source: WrssSource) => {
    if (!window.confirm(`确认删除 ${source.name}？`)) return;
    try {
      await deleteWrssSource(baseUrl, source.id);
      setSources((current) => current.filter((item) => item.id !== source.id));
      setTotal((value) => Math.max(0, value - 1));
      setActive((value) => Math.max(0, Math.min(value, sources.length - 2)));
      setMessage("公众号已删除");
      setError(null);
      if (sources.length - 1 < total - 1) await reloadFirst();
    } catch (cause) {
      setError(messageOf(cause));
      onError?.(cause);
    }
  };
  const toggle = async (source: WrssSource) => {
    try {
      await toggleWrssSource(baseUrl, source.id, source.enabled ? 0 : 1);
      const remains =
        status === "all" ||
        (status === "enabled" && !source.enabled) ||
        (status === "disabled" && source.enabled);
      setSources((current) =>
        remains
          ? current.map((item) =>
              item.id === source.id
                ? { ...item, enabled: !source.enabled }
                : item,
            )
          : current.filter((item) => item.id !== source.id),
      );
      if (!remains) {
        setTotal((value) => Math.max(0, value - 1));
        setActive((value) => Math.max(0, Math.min(value, sources.length - 2)));
      }
      setMessage(source.enabled ? "已停用" : "已启用");
      setError(null);
      if (!remains && sources.length - 1 < total - 1) await reloadFirst();
    } catch (cause) {
      setError(messageOf(cause));
      onError?.(cause);
    }
  };
  const update = async (source: WrssSource) => {
    try {
      const task = syncManager ? await syncManager.submitSource(source.id) : await updateWrssSource(baseUrl, source.id);
      setMessage(task.status === "blocked" || task.status === "failed" ? task.message : `${source.name} 更新任务已提交`);
      setError(task.status === "blocked" || task.status === "failed" ? task.message : null);
    } catch (cause) {
      setError(messageOf(cause));
      onError?.(cause);
    }
  };
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await importSubscriptions(baseUrl, file);
      setMessage("订阅已导入");
      setError(null);
      await reloadFirst();
    } catch (cause) {
      setError(messageOf(cause));
      onError?.(cause);
    } finally {
      event.target.value = "";
    }
  };
  const exportSubscriptions = async (format: "csv" | "opml") => {
    try {
      await downloadWrssFile(
        subscriptionExportUrl(baseUrl, format),
        `subscriptions.${format}`,
      );
      setMessage(`订阅 ${format.toUpperCase()} 已保存`);
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
      onError?.(cause);
    }
  };
  return (
    <section className="wrss-native-sources">
      <header className="wrss-native-toolbar">
        <h2>已订阅公众号</h2>
        <input
          aria-label="搜索公众号"
          placeholder="搜索公众号名称"
          value={query}
          onChange={(event) => changeQuery(event.target.value)}
        />
        <GlassSelect
          aria-label="启用状态"
          value={status}
          onChange={(value) => changeStatus(value as typeof status)}
          options={[
            { value: "all", label: "全部" },
            { value: "enabled", label: "启用" },
            { value: "disabled", label: "停用" },
          ]}
        />
        <button onClick={() => void reloadFirst()}>刷新列表</button>
        <button onClick={() => setAddOpen((value) => !value)}>添加</button>
        <button onClick={() => void submitAll()} disabled={syncBusy || syncCooldownSeconds > 0}>
          {syncCooldownSeconds > 0 ? `更新全部（${syncCooldownSeconds} 秒）` : "更新全部"}
        </button>
      </header>
      {message && <p role="status">{message}</p>}
      {syncIssue && <div className="wrss-native-error" role="alert">{syncIssue}</div>}
      {syncManager?.error && <div className="wrss-native-error" role="alert">{syncManager.error}<button onClick={syncManager.recheck}>重新检查</button></div>}
      {addOpen && (
        <div className="wrss-source-add">
          <input
            aria-label="微信公众号 fakeid"
            placeholder="微信公众号 fakeid（不是 MP_WXS_内部ID）"
            value={manual.mp_id}
            onChange={(event) =>
              setManual((value) => ({ ...value, mp_id: event.target.value }))
            }
          />
          <input
            aria-label="公众号名称"
            placeholder="公众号名称"
            value={manual.mp_name}
            onChange={(event) =>
              setManual((value) => ({ ...value, mp_name: event.target.value }))
            }
          />
          <input
            aria-label="头像地址"
            placeholder="头像地址"
            value={manual.avatar}
            onChange={(event) =>
              setManual((value) => ({ ...value, avatar: event.target.value }))
            }
          />
          <input
            aria-label="公众号简介"
            placeholder="公众号简介"
            value={manual.mp_intro}
            onChange={(event) =>
              setManual((value) => ({ ...value, mp_intro: event.target.value }))
            }
          />
          <button onClick={() => void add(manual)}>手动添加</button>
          <input
            aria-label="搜索可添加公众号"
            value={remoteQuery}
            onChange={(event) => setRemoteQuery(event.target.value)}
            placeholder="搜索可添加公众号"
          />
          <button onClick={() => void searchRemote()}>搜索可添加公众号</button>
          {remote.map((source) => (
            <button
              key={source.id}
              onClick={() =>
                void add({
                  mp_id: source.fakerId || source.id,
                  mp_name: source.name,
                  avatar: source.avatar || "",
                  mp_intro: source.intro,
                })
              }
            >
              添加 {source.name}
            </button>
          ))}
          <input
            aria-label="公众号文章链接"
            placeholder="公众号文章链接"
            value={articleUrl}
            onChange={(event) => setArticleUrl(event.target.value)}
          />
          <button onClick={() => void addByArticle()}>从文章添加公众号</button>
          <label>
            导入订阅{" "}
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => void importFile(event)}
            />
          </label>
          <button onClick={() => void exportSubscriptions("csv")}>导出 CSV</button>
          <button onClick={() => void exportSubscriptions("opml")}>导出 OPML</button>
        </div>
      )}
      {error && (
        <div className="wrss-native-error" role="alert">
          {error}
          <button onClick={() => void loadPage(failedPage ?? page, true)}>
            重试
          </button>
        </div>
      )}
      <div
        ref={deckRef}
        className="wrss-source-deck"
        tabIndex={0}
        aria-label="公众号叠卡"
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            move(-1);
          }
          if (["ArrowRight", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            move(1);
          }
        }}
      >
        {loading && sources.length === 0 ? (
          <div className="wrss-native-loading" role="status">
            正在加载公众号…
          </div>
        ) : !error && visible.length === 0 ? (
          <EmptyState
            icon="⌕"
            title="没有匹配的公众号"
            description="更换关键词后重试"
            className="wrss-native-empty"
          />
        ) : (
          visible.map(({ source, index, distance }) => {
            const hidden = distance < -1 || distance > 3;
            return (
              <div
                key={source.id}
                className={`wrss-source-card ${hidden ? "is-hidden" : ""}`}
                aria-hidden={hidden}
                style={
                  {
                    "--depth": Math.abs(distance),
                    "--offset": distance,
                  } as CSSProperties
                }
              >
                <button
                  tabIndex={hidden ? -1 : 0}
                  className="wrss-source-main"
                  onClick={() =>
                    index === active
                      ? onOpen(source.id, source.name)
                      : setActive(index)
                  }
                  aria-current={index === active}
                >
                  <SourceAvatar
                    baseUrl={baseUrl}
                    source={source}
                    active={activeView && !hidden}
                  />
                  <h3>{source.name}</h3>
                  <p>{source.intro || "已订阅公众号"}</p>
                  <small>
                    {Number.isFinite(source.article_count)
                      ? `${source.article_count} 篇文章 · `
                      : ""}
                    {source.enabled ? "启用" : "停用"}
                  </small>
                  {source.id === "MP_WXS_" && <strong className="wrss-source-warning">标识不完整，请重新添加</strong>}
                </button>
                {index === active && (
                  <div className="wrss-source-actions">
                    <button onClick={() => void toggle(source)}>
                      {source.enabled ? "停用" : "启用"}
                    </button>
                    <button
                      onClick={() => void update(source)}
                      disabled={source.id === "MP_WXS_" || !!syncManager?.tasks.some((task) => task.mp_id === source.id && (task.status === "queued" || task.status === "running")) || syncCooldownSeconds > 0}
                      title={source.id === "MP_WXS_" ? "公众号标识不完整，请重新添加" : undefined}
                    >
                      更新文章
                    </button>
                    <button onClick={() => void remove(source)}>删除</button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="wrss-deck-controls">
        <button onClick={() => move(-1)} disabled={active === 0}>
          ‹
        </button>
        <span>
          {sources.length ? active + 1 : 0} / {total}
        </span>
        <button onClick={() => move(1)} disabled={active >= sources.length - 1}>
          ›
        </button>
      </div>
    </section>
  );
}
