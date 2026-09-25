import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import DOMPurify from "dompurify";
import Markdown from "react-markdown";
import { EmptyState } from "../../components/EmptyState";
import { GlassSelect } from "../../components/GlassMenu";
import { openWrssExternal } from "./wrssExternal";
import {
  articleImageUrl,
  deleteWrssArticle,
  fetchWrssArticle,
  fetchWrssArticles,
  fetchWrssAuth,
  refreshWrssArticle,
  setWrssFavorite,
  setWrssRead,
  type ArticleFilter,
  type WrssArticle,
  type WrssPage,
  type WrssView,
} from "./wrssClient";
import type { WrssSyncManager } from "./useWrssSyncManager";

const REFRESH_COOLDOWN = 300000;
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : "公众号请求失败";

function ArticleHtml({
  baseUrl,
  content,
  active,
}: {
  baseUrl?: string;
  content: string;
  active: boolean;
}) {
  const [html, setHtml] = useState(() =>
    DOMPurify.sanitize(content, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["iframe"],
    }),
  );
  useEffect(() => {
    const sanitized = DOMPurify.sanitize(content, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["iframe"],
    });
    setHtml(sanitized);
    if (!active) return;
    const document = new DOMParser().parseFromString(sanitized, "text/html"),
      images = [...document.querySelectorAll("img")],
      controller = new AbortController();
    let disposed = false;
    const load = async (image: HTMLImageElement) => {
      const lazy = image.getAttribute("data-src") || "",
        source = image.getAttribute("src") || "";
      let remote =
        lazy.startsWith("http://") || lazy.startsWith("https://")
          ? lazy
          : source.startsWith("/static/res/logo/")
            ? decodeURIComponent(source.slice("/static/res/logo/".length))
            : "";
      if (!remote) return;
      try {
        const url = new URL(remote);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          !["mmbiz.qpic.cn", "mmbiz.qlogo.cn", "mmecoa.qpic.cn"].includes(
            url.hostname,
          )
        )
          return;
        const response = await fetch(articleImageUrl(baseUrl, url.href), {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("文章图片加载失败");
        const blob = await response.blob(),
          data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        if (disposed) return;
        image.setAttribute("src", data);
        image.removeAttribute("data-src");
        image.removeAttribute("srcset");
        setHtml(document.body.innerHTML);
      } catch (error) {
        if ((error as Error).name !== "AbortError")
          image.removeAttribute("src");
      }
    };
    void Promise.all(images.map(load));
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [active, baseUrl, content]);
  return (
    <div
      onClick={(event) => {
        const link = (event.target as HTMLElement).closest(
          "a[href]",
        ) as HTMLAnchorElement | null;
        if (!link || link.getAttribute("href")?.startsWith("#")) return;
        try {
          const url = new URL(link.href);
          if (["http:", "https:"].includes(url.protocol)) {
            event.preventDefault();
            void openWrssExternal(url.href);
          }
        } catch {}
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default function WrssArticleList({
  baseUrl,
  view,
  active = true,
  title: customTitle,
  onBack,
  onError,
  onExportSelected,
  refreshToken = 0,
  autoSyncAttempt: sharedAutoSyncAttempt,
  syncManager,
}: {
  baseUrl?: string;
  view: WrssView;
  active?: boolean;
  title?: string;
  onBack?: () => void;
  onError?: (e: unknown) => void;
  onExportSelected?: (ids: string[]) => void;
  refreshToken?: number;
  autoSyncAttempt?: MutableRefObject<boolean>;
  syncManager?: WrssSyncManager;
}) {
  const [rows, setRows] = useState<WrssArticle[]>([]),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState<ArticleFilter>("all"),
    [limit, setLimit] = useState(10),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [detail, setDetail] = useState<WrssArticle | null>(null),
    [columns, setColumns] = useState({
      source: true,
      time: true,
      summary: true,
    }),
    [message, setMessage] = useState(""),
    [syncTaskError, setSyncTaskError] = useState(""),
    [needsRecheck, setNeedsRecheck] = useState(false),
    [inAppRead, setInAppRead] = useState(true),
    [cooldownUntil, setCooldownUntil] = useState(0),
    [now, setNow] = useState(() => Date.now());
  const requestId = useRef(0),
    detailRequestId = useRef(0),
    localAutoSyncAttempt = useRef(false),
    lastRefreshToken = useRef(refreshToken),
    readController = useRef<AbortController | null>(null);
  const autoSyncAttempt = sharedAutoSyncAttempt ?? localAutoSyncAttempt;
  const cancelPending = useCallback(() => {
    requestId.current++;
    detailRequestId.current++;
    readController.current?.abort();
    readController.current = null;
  }, []);
  const isCurrent = useCallback(
    (id: number) => active && id === requestId.current,
    [active],
  );
  const readArticles = useCallback(
    (force: boolean, signal?: AbortSignal) =>
      fetchWrssArticles(
        baseUrl,
        { view, page, limit, search: query, filter, signal },
        1,
        10,
        "",
        force,
      ),
    [baseUrl, view, page, limit, query, filter],
  );
  const ensureAuthorized = useCallback(
    async (signal?: AbortSignal) => {
      const auth = await fetchWrssAuth(baseUrl, signal);
      if (auth.login) return;
      window.dispatchEvent(new Event("wrss:unauthorized"));
      throw new Error("微信公众号授权已失效，请重新扫码授权");
    },
    [baseUrl],
  );
  const load = useCallback(
    async (force = false): Promise<WrssPage<WrssArticle> | null> => {
      const id = ++requestId.current;
      readController.current?.abort();
      const syncController = new AbortController();
      readController.current = syncController;
      setLoading(true);
      try {
        const result = await readArticles(force, syncController.signal);
        if (!isCurrent(id)) return null;
        setError(null);
        if (!isCurrent(id)) return null;
        const lastPage = Math.max(1, Math.ceil(result.total / limit));
        if (page > lastPage) {
          setPage(lastPage);
          return result;
        }
        setRows(result.list);
        setTotal(result.total);
        setSelected(
          (current) =>
            new Set(
              [...current].filter((selectedId) =>
                result.list.some((article) => article.id === selectedId),
              ),
            ),
        );
        return result;
      } catch (cause) {
        if ((cause as Error).name === "AbortError") return null;
        if (!isCurrent(id)) return null;
        setError(errorText(cause));
        onError?.(cause);
        return null;
      } finally {
        if (readController.current === syncController)
          readController.current = null;
        if (isCurrent(id)) setLoading(false);
      }
    },
    [
      isCurrent,
      limit,
      onError,
      page,
      query,
      readArticles,
    ],
  );
  useEffect(() => {
    if (!active) {
      cancelPending();
      return;
    }
    const force = lastRefreshToken.current !== refreshToken;
    lastRefreshToken.current = refreshToken;
    void load(force);
    return cancelPending;
  }, [active, cancelPending, load, refreshToken]);
  useEffect(() => {
    const defaultLatest =
      active && view === "latest" && page === 1 && limit === 10 && query === "" && filter === "all";
    if (!defaultLatest || loading || error || total > 0 || rows.length > 0 || !syncManager?.autoSyncAllowed || autoSyncAttempt.current)
      return;
    autoSyncAttempt.current = true;
    setNeedsRecheck(false);
    setMessage("尚无文章，正在提交公众号更新任务…");
    void syncManager.submitAll().then((sync) => {
      const blocked = sync.tasks.find((task) => task.status === "blocked");
      const failed = sync.tasks.find((task) => task.status === "failed");
      if (blocked || failed || sync.failed) {
        const reason = blocked?.message || failed?.message || sync.failures.map((item) => item.reason).join("；");
        setMessage("");
        setSyncTaskError(reason || "更新任务提交失败");
      } else if (sync.submitted > 0) {
        setSyncTaskError("");
        setMessage(`已提交 ${sync.submitted} 个更新任务，抓取期间继续显示已有数据`);
      } else {
        setMessage("没有启用的公众号可提交更新");
      }
    }).catch((cause) => {
      if ((cause as Error).name === "AbortError") return;
      setError(errorText(cause));
      onError?.(cause);
    });
  }, [active, autoSyncAttempt, error, filter, limit, loading, onError, page, query, rows.length, syncManager, total, view]);
  useEffect(() => {
    setNow(Date.now());
    if (cooldownUntil <= Date.now() && (syncManager?.cooldownUntil ?? 0) <= Math.floor(Date.now() / 1000)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil, syncManager?.cooldownUntil]);
  useEffect(() => {
    if (!active || !syncManager) return;
    const relevant = syncManager.tasks.filter((task) =>
      view.startsWith("account:") ? task.mp_id === view.slice(8) : true,
    );
    if (syncManager.error) {
      setNeedsRecheck(syncManager.error.includes("观察已超时"));
    }
    const blocked = relevant.find((task) => task.status === "blocked");
    const failed = relevant.find((task) => task.status === "failed");
    if (blocked) {
      setMessage("");
      setSyncTaskError(blocked.message);
    } else if (failed) {
      setMessage("");
      setSyncTaskError(failed.message);
    } else if (relevant.some((task) => task.status === "running")) {
      setSyncTaskError("");
      setMessage("正在抓取公众号文章，已有数据仍可浏览");
    } else if (relevant.some((task) => task.status === "queued")) {
      setSyncTaskError("");
      setMessage("公众号文章抓取任务正在排队");
    } else {
      const succeeded = relevant.find((task) => task.status === "succeeded");
      if (succeeded) {
        setSyncTaskError("");
        setMessage(succeeded.added ? `抓取完成，新增 ${succeeded.added} 篇文章` : "抓取完成，没有新增文章");
      }
    }
  }, [active, syncManager, view]);
  const refresh = async () => {
    try {
      await ensureAuthorized();
      const result = await load(true);
      if (result) {
        setCooldownUntil(Date.now() + REFRESH_COOLDOWN);
        setNow(Date.now());
      }
    } catch (cause) {
      if ((cause as Error).name !== "AbortError") setError(errorText(cause));
    }
  };
  const recheck = async () => {
    try {
      await ensureAuthorized();
      syncManager?.recheck();
      setNeedsRecheck(false);
      setMessage("正在重新检查当前同步任务…");
    } catch (cause) {
      if ((cause as Error).name !== "AbortError") setError(errorText(cause));
    }
  };
  const submitEmpty = async () => {
    try {
      if (!syncManager) throw new Error("同步服务尚未就绪");
      const result = view.startsWith("account:")
        ? ({ submitted: 1, failed: 0, failures: [], tasks: [await syncManager.submitSource(view.slice(8))] })
        : await syncManager.submitAll();
      const reasons = result.failures
        .map((item) => `${item.id}：${item.reason}`)
        .join("；");
      setMessage(
        result.failed
          ? `已提交 ${result.submitted} 个更新任务，${result.failed} 个失败（${reasons}）`
          : `已提交 ${result.submitted} 个更新任务`,
      );
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
      onError?.(cause);
    }
  };
  const mutate = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      setMessage(success);
      await load(true);
    } catch (cause) {
      setError(errorText(cause));
      onError?.(cause);
    }
  };
  const remove = async (id: string) => {
    if (window.confirm("确认删除这篇文章？"))
      await mutate(() => deleteWrssArticle(baseUrl, id), "文章已删除");
  };
  const batchDelete = async () => {
    if (
      !selected.size ||
      !window.confirm(`确认删除选中的 ${selected.size} 篇文章？`)
    )
      return;
    const failed: string[] = [];
    let succeeded = 0;
    for (const id of [...selected])
      try {
        await deleteWrssArticle(baseUrl, id);
        succeeded++;
        setSelected((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        setRows((current) => current.filter((article) => article.id !== id));
        setTotal((current) => Math.max(0, current - 1));
      } catch (cause) {
        failed.push(`${id}：${errorText(cause)}`);
      }
    if (failed.length) {
      const cause = new Error(
        `${failed.length} 篇删除失败：${failed.join("；")}`,
      );
      setError(cause.message);
      setMessage(`已删除 ${succeeded} 篇，${failed.length} 篇失败`);
      onError?.(cause);
    } else {
      setError(null);
      setMessage(`已删除 ${succeeded} 篇`);
      await load(true);
    }
  };
  const openDetail = async (id: string, direction?: "prev" | "next") => {
    const request = ++detailRequestId.current;
    try {
      const next = await fetchWrssArticle(baseUrl, id, direction);
      if (request !== detailRequestId.current || !active) return;
      setDetail(next);
      setError(null);
      try {
        await setWrssRead(baseUrl, next.id, true);
        if (request === detailRequestId.current)
          setRows((current) =>
            current.map((article) =>
              article.id === next.id ? { ...article, is_read: true } : article,
            ),
          );
      } catch (cause) {
        if (request === detailRequestId.current) {
          setError(errorText(cause));
          onError?.(cause);
        }
      }
    } catch (cause) {
      if (request === detailRequestId.current && active) {
        setError(errorText(cause));
        onError?.(cause);
      }
    }
  };
  const openArticle = async (article: WrssArticle) => {
    if (inAppRead) await openDetail(article.id);
    else if (article.link) await openWrssExternal(article.link);
  };
  const toggleFavorite = async (article: WrssArticle) => {
    try {
      const next = await setWrssFavorite(
        baseUrl,
        article.id,
        !article.is_favorite,
      );
      if (view === "favorites" && !next.is_favorite) {
        setRows((current) => current.filter((value) => value.id !== next.id));
        setTotal((current) => {
          const totalNext = Math.max(0, current - 1),
            lastPage = Math.max(1, Math.ceil(totalNext / limit));
          if (page > lastPage) setPage(lastPage);
          return totalNext;
        });
      } else
        setRows((current) =>
          current.map((value) =>
            value.id === next.id
              ? {
                  ...value,
                  is_favorite: next.is_favorite,
                  favorite_at: next.favorite_at,
                }
              : value,
          ),
        );
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
      onError?.(cause);
    }
  };
  const closeDetail = () => {
    detailRequestId.current++;
    setDetail(null);
    setError(null);
  };
  const toggleAll = () =>
    setSelected((current) =>
      rows.length > 0 && rows.every((article) => current.has(article.id))
        ? new Set()
        : new Set(rows.map((article) => article.id)),
    );
  const title =
      customTitle ??
      (view === "latest"
        ? "最新文章"
        : view === "favorites"
          ? "我的收藏"
          : view.slice(8)),
    pages = Math.max(1, Math.ceil(total / limit)),
    displayError = syncManager?.error || error,
    canRecheck = needsRecheck || !!syncManager?.error.includes("观察已超时"),
    cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000)),
    syncCooldownSeconds = Math.max(0, (syncManager?.cooldownUntil ?? 0) - Math.floor(now / 1000)),
    syncBusy = !!syncManager?.tasks.some((task) => task.status === "queued" || task.status === "running"),
    allSelected =
      rows.length > 0 && rows.every((article) => selected.has(article.id)),
    isPlainEmpty = !query && filter === "all",
    emptyTitle =
      query || filter !== "all"
        ? "没有匹配的文章"
        : view === "favorites"
          ? "暂无收藏"
          : view.startsWith("account:")
            ? "该公众号暂无文章"
            : "尚未同步文章",
    detailContent = detail?.content || detail?.summary || "暂无正文",
    detailIsHtml = /<[a-z][\s\S]*>/i.test(detailContent);
  if (detail)
    return (
      <section className="wrss-native-content wrss-article-detail">
        <header className="wrss-native-toolbar">
          <button onClick={closeDetail}>← 返回列表</button>
          <button onClick={() => void openDetail(detail.id, "prev")}>
            上一篇
          </button>
          <button onClick={() => void openDetail(detail.id, "next")}>
            下一篇
          </button>
          {detail.link && (
            <button onClick={() => void openWrssExternal(detail.link!)}>
              查看原文
            </button>
          )}
        </header>
        {error && (
          <div className="wrss-native-error" role="alert">
            {error}
          </div>
        )}
        <article>
          <h2>{detail.title}</h2>
          <p>
            {detail.mp_name} · {detail.publish_time}
          </p>
          <div className="wrss-article-content">
            {detailIsHtml ? (
              <ArticleHtml
                baseUrl={baseUrl}
                content={detailContent}
                active={active}
              />
            ) : (
              <Markdown
                components={{
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      onClick={(event) => {
                        if (!href || href.startsWith("#")) return;
                        try {
                          const url = new URL(href);
                          if (["http:", "https:"].includes(url.protocol)) {
                            event.preventDefault();
                            void openWrssExternal(url.href);
                          }
                        } catch {}
                      }}
                    >
                      {children}
                    </a>
                  ),
                }}
              >
                {detailContent}
              </Markdown>
            )}
          </div>
        </article>
      </section>
    );
  return (
    <section className="wrss-native-content" data-testid="wrss-article-list">
      <header className="wrss-native-toolbar">
        {onBack && <button onClick={onBack}>← 返回</button>}
        <h2>{title}</h2>
        <label className="wrss-inline-check">
          <input
            type="checkbox"
            checked={inAppRead}
            onChange={(event) => setInAppRead(event.target.checked)}
          />
          在应用内阅读
        </label>
        <input
          aria-label="搜索文章"
          placeholder="搜索文章标题"
          value={query}
          onChange={(event) => {
            setPage(1);
            setQuery(event.target.value);
          }}
        />
        <GlassSelect
          aria-label="文章筛选"
          value={filter}
          onChange={(value) => {
            setPage(1);
            setFilter(value as ArticleFilter);
          }}
          options={[
            { value: "all", label: "全部" },
            { value: "content", label: "有正文" },
            { value: "empty", label: "无正文" },
            { value: "updating", label: "更新中" },
            { value: "deleted", label: "已删除" },
          ]}
        />
        <GlassSelect
          aria-label="每页条数"
          value={String(limit)}
          onChange={(value) => {
            setPage(1);
            setLimit(Number(value));
          }}
          options={[10, 20, 30, 50].map((value) => ({ value: String(value), label: String(value) }))}
        />
        <button
          aria-label="刷新文章列表"
          onClick={() => void refresh()}
          disabled={cooldownSeconds > 0}
        >
          {cooldownSeconds > 0 ? `刷新（${cooldownSeconds} 秒）` : "刷新"}
        </button>
        <details>
          <summary>列设置</summary>
          {Object.entries(columns).map(([key, value]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={value}
                onChange={(event) =>
                  setColumns((current) => ({
                    ...current,
                    [key]: event.target.checked,
                  }))
                }
              />
              {key === "source" ? "来源" : key === "time" ? "时间" : "摘要"}
            </label>
          ))}
        </details>
      </header>
      {rows.length > 0 && (
        <div className="wrss-batch-bar">
          <label>
            <input
              aria-label="选择本页文章"
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
            />
            选择本页
          </label>
          {selected.size > 0 && (
            <>
              {" "}
              已选 {selected.size} 篇{" "}
              {onExportSelected && (
                <button onClick={() => onExportSelected([...selected])}>
                  导出所选
                </button>
              )}
              <button onClick={() => void batchDelete()}>批量删除</button>
            </>
          )}
        </div>
      )}
      {message && (
        <p role="status">
          {message}{" "}
          {canRecheck && (
            <button onClick={() => void recheck()}>重新检查</button>
          )}
        </p>
      )}
      {syncTaskError && (
        <div className="wrss-native-error" role="alert">
          {syncTaskError}
          {isPlainEmpty && (view === "latest" || view.startsWith("account:")) && (
            <button onClick={() => void submitEmpty()} disabled={syncBusy || syncCooldownSeconds > 0}>
              {syncCooldownSeconds > 0 ? `更新公众号文章（${syncCooldownSeconds} 秒）` : "重新更新文章"}
            </button>
          )}
        </div>
      )}
      {displayError && (
        <div className="wrss-native-error" role="alert">
          {displayError}
          {canRecheck ? (
            <button onClick={() => void recheck()}>重新检查</button>
          ) : (
            <button onClick={() => void load(true)}>重试</button>
          )}
        </div>
      )}
      {loading && rows.length === 0 ? (
        <div className="wrss-native-loading" role="status">
          正在加载…
        </div>
      ) : !displayError && rows.length === 0 ? (
        <EmptyState
          icon="⌕"
          title={emptyTitle}
          description={
            isPlainEmpty ? "暂时没有可显示的文章。" : "请调整搜索或筛选条件。"
          }
          className="wrss-native-empty"
        >
          {isPlainEmpty &&
            (view === "latest" || view.startsWith("account:")) && (
              <button
                onClick={() => void submitEmpty()}
                disabled={syncBusy || syncCooldownSeconds > 0}
              >
                {syncCooldownSeconds > 0 ? `更新公众号文章（${syncCooldownSeconds} 秒）` : "更新公众号文章"}
              </button>
            )}
        </EmptyState>
      ) : (
        <div className="wrss-native-articles">
          {rows.map((article) => (
            <article
              key={article.id}
              className={article.is_read ? "is-read" : ""}
            >
              <input
                aria-label={`选择 ${article.title}`}
                type="checkbox"
                checked={selected.has(article.id)}
                onChange={(event) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    event.target.checked
                      ? next.add(article.id)
                      : next.delete(article.id);
                    return next;
                  })
                }
              />
              <div>
                <button
                  className="wrss-article-title"
                  onClick={() => void openArticle(article)}
                >
                  {article.title}
                </button>
                {columns.source && <p>{article.mp_name}</p>}
                {columns.time && <p>{article.publish_time}</p>}
                {columns.summary && article.summary && <p>{article.summary}</p>}
              </div>
              <div className="wrss-row-actions">
                <button
                  onClick={() => void toggleFavorite(article)}
                  aria-label={article.is_favorite ? "取消收藏" : "收藏"}
                >
                  {article.is_favorite ? "★" : "☆"}
                </button>
                <button
                  onClick={() =>
                    setWrssRead(baseUrl, article.id, !article.is_read)
                      .then(() =>
                        setRows((current) =>
                          current.map((value) =>
                            value.id === article.id
                              ? { ...value, is_read: !article.is_read }
                              : value,
                          ),
                        ),
                      )
                      .catch((cause) => {
                        setError(errorText(cause));
                        onError?.(cause);
                      })
                  }
                >
                  {article.is_read ? "标为未读" : "标为已读"}
                </button>
                {article.link && (
                  <button onClick={() => void openWrssExternal(article.link!)}>
                    原文
                  </button>
                )}
                <button
                  onClick={() =>
                    void mutate(
                      () => refreshWrssArticle(baseUrl, article.id),
                      "刷新任务已提交",
                    )
                  }
                >
                  刷新
                </button>
                <button onClick={() => void remove(article.id)}>删除</button>
              </div>
            </article>
          ))}
        </div>
      )}
      <footer className="wrss-pagination">
        <button
          disabled={page <= 1}
          onClick={() => setPage((value) => value - 1)}
        >
          上一页
        </button>
        <span>
          第 {page} / {pages} 页，共 {total} 篇
        </span>
        <button
          disabled={page >= pages}
          onClick={() => setPage((value) => value + 1)}
        >
          下一页
        </button>
      </footer>
    </section>
  );
}
