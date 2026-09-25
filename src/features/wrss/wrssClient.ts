export type WrssView =
  | "latest"
  | "favorites"
  | "sources"
  | "authorization"
  | "exports"
  | `account:${string}`;
export type ArticleFilter =
  | "all"
  | "content"
  | "empty"
  | "updating"
  | "deleted";
export interface WrssArticle {
  id: string;
  title: string;
  mp_id: string;
  mp_name: string;
  publish_time: string;
  is_favorite: boolean;
  favorite_at?: number | null;
  summary?: string;
  link?: string;
  content?: string;
  has_content?: boolean;
  is_read?: boolean;
  status?: string | number;
}
export interface WrssSource {
  id: string;
  name: string;
  intro?: string;
  avatar?: string;
  enabled: boolean;
  article_count: number;
  fakerId?: string;
}
export interface WrssPage<T> {
  list: T[];
  total: number;
  page: number;
  limit: number;
}
export interface WrssAuthState {
  login: boolean;
  info?: Record<string, unknown>;
  expiry_time?: number;
}
export type WrssSyncStatus = "queued" | "running" | "succeeded" | "failed" | "blocked";
export interface WrssSyncTask {
  task_id: string;
  mp_id: string;
  status: WrssSyncStatus;
  code: number;
  message: string;
  cooldown_until: number;
  added?: number;
}
export interface WrssArticleSyncState {
  cooldown_until: number;
  recent_error_code?: number | null;
  recent_error_message?: string;
}
export interface WrssQrState {
  login_status: boolean;
  qr_code: boolean;
  scanned?: boolean;
  version?: number;
  expires_at?: number;
  code?: string;
}
export interface WrssExportRecord {
  filename: string;
  path?: string;
  size?: number;
  created_time?: string | number;
}
export interface ArticleQuery {
  view: WrssView;
  page?: number;
  limit?: number;
  search?: string;
  filter?: ArticleFilter;
  signal?: AbortSignal;
}

const DEFAULT_BASE = "http://127.0.0.1:43117",
  CACHE_MS = 300000;
const cache = new Map<string, { at: number; value: unknown }>();
const cacheVersion = new Map<string, number>();
const articleInflight = new Map<
  string,
  { promise: Promise<WrssPage<WrssArticle>>; signal?: AbortSignal }
>();
const articleVersion = new Map<string, number>();
export class WrssRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: number,
  ) {
    super(message);
  }
}
function syncTask(raw: any): WrssSyncTask {
  const task = payload(raw) as WrssSyncTask;
  if (task.code === 40101) {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("wrss:unauthorized"));
    throw new WrssRequestError(task.message || "公众号授权已失效", 401, task.code);
  }
  return {
    ...task,
    task_id: String(task.task_id || ""),
    mp_id: String(task.mp_id || ""),
    code: Number(task.code || 0),
    cooldown_until: Number(task.cooldown_until || 0),
  };
}
const endpoint = (base: string | undefined, path: string) =>
  `${(base || DEFAULT_BASE).replace(/\/$/, "")}/wrss/api${path}`;
async function request<T>(
  base: string | undefined,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(endpoint(base, path), {
    cache: "no-store",
    ...init,
  });
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    if (response.ok) throw new Error("公众号返回了无法解析的数据");
  }
  const code = body?.detail?.code ?? body?.code;
  if (response.status === 401 || code === 401 || code === 40101) {
    if (typeof window !== "undefined")
      window.dispatchEvent(new Event("wrss:unauthorized"));
    throw new WrssRequestError(
      body?.detail?.message || body?.message || "公众号授权已失效",
      response.status,
      code,
    );
  }
  if (!response.ok || (typeof code === "number" && code !== 0))
    throw new WrssRequestError(
      body?.detail?.message ||
        body?.error ||
        body?.message ||
        `公众号请求失败（${response.status}）`,
      response.status,
      code,
    );
  return body as T;
}
const payload = (v: any) => v?.data ?? v;
function pagePayload(v: any, page: number, limit: number) {
  const data = payload(v);
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !Array.isArray(data.list) ||
    !Number.isFinite(Number(data.total))
  )
    throw new Error("公众号列表响应格式错误");
  return { list: data.list, total: Number(data.total), page, limit };
}
function formatTime(v: unknown) {
  if (v instanceof Date) return v.toLocaleString("zh-CN", { hour12: false });
  if (
    typeof v === "number" ||
    (typeof v === "string" && /^\d{10,13}$/.test(v))
  ) {
    const n = Number(v);
    return new Date(n < 1e12 ? n * 1000 : n).toLocaleString("zh-CN", {
      hour12: false,
    });
  }
  const d = new Date(String(v ?? ""));
  return Number.isNaN(d.valueOf())
    ? String(v ?? "")
    : d.toLocaleString("zh-CN", { hour12: false });
}
function article(raw: any): WrssArticle {
  return {
    ...raw,
    id: String(raw.id ?? raw.doc_id ?? ""),
    title: String(raw.title ?? "未命名文章"),
    mp_id: String(raw.mp_id ?? ""),
    mp_name: String(raw.mp_name ?? raw.name ?? ""),
    publish_time: formatTime(raw.publish_time),
    is_favorite: raw.is_favorite === true || raw.is_favorite === 1,
    favorite_at: raw.favorite_at == null ? null : Number(raw.favorite_at),
    summary: raw.summary ?? raw.description,
    content: raw.content ?? raw.content_html,
    link: raw.link ?? raw.url,
    has_content: raw.has_content === true || raw.has_content === 1,
    is_read: raw.is_read === true || raw.is_read === 1,
  };
}
function source(raw: any): WrssSource {
  return {
    ...raw,
    id: String(raw.id ?? raw.mp_id ?? ""),
    name: String(raw.mp_name ?? raw.name ?? ""),
    intro: raw.mp_intro ?? raw.intro ?? "",
    avatar: raw.mp_cover ?? raw.avatar ?? "",
    enabled:
      raw.status === undefined
        ? raw.enabled !== false
        : Number(raw.status) !== 0,
    article_count: Number(raw.article_count ?? 0),
    fakerId: raw.faker_id,
  };
}
async function cached<T>(key: string, force: boolean, load: () => Promise<T>) {
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const version = (cacheVersion.get(key) ?? 0) + 1;
  cacheVersion.set(key, version);
  const value = await load();
  if (cacheVersion.get(key) === version)
    cache.set(key, { at: Date.now(), value });
  return value;
}
function invalidate(prefix: string) {
  const keys = new Set([
    ...cache.keys(),
    ...cacheVersion.keys(),
    ...articleInflight.keys(),
    ...articleVersion.keys(),
  ]);
  for (const key of keys)
    if (key.startsWith(prefix)) {
      cache.delete(key);
      cacheVersion.set(key, (cacheVersion.get(key) ?? 0) + 1);
      articleInflight.delete(key);
      articleVersion.set(key, (articleVersion.get(key) ?? 0) + 1);
    }
}
function invalidateArticlePending(prefix: string) {
  const keys = new Set([...articleInflight.keys(), ...articleVersion.keys()]);
  for (const key of keys)
    if (key.startsWith(prefix)) {
      articleInflight.delete(key);
      articleVersion.set(key, (articleVersion.get(key) ?? 0) + 1);
    }
}
const baseKey = (base?: string) => base || DEFAULT_BASE;
const articlePrefix = (base?: string) => `articles:${baseKey(base)}:`;
const sourcePrefix = (base?: string) => `sources:${baseKey(base)}:`;

export async function fetchWrssSources(
  base?: string,
  query = "",
  page = 1,
  limit = 10,
  force = false,
  status?: number,
  signal?: AbortSignal,
): Promise<WrssPage<WrssSource>> {
  const key = `sources:${baseKey(base)}:${query}:${page}:${limit}:${status ?? "all"}`;
  return cached(key, force, async () => {
    const q = new URLSearchParams({
      kw: query,
      offset: String((page - 1) * limit),
      limit: String(limit),
    });
    if (status !== undefined) q.set("status", String(status));
    const p = pagePayload(
      await request(base, `/mps?${q}`, { signal }),
      page,
      limit,
    );
    return { ...p, list: p.list.map(source) };
  });
}
export async function searchWrssSources(
  base: string | undefined,
  query: string,
  offset = 0,
  limit = 10,
) {
  const p = pagePayload(
    await request(
      base,
      `/mps/search/${encodeURIComponent(query)}?offset=${offset}&limit=${limit}`,
    ),
    Math.floor(offset / limit) + 1,
    limit,
  );
  return {
    ...p,
    list: p.list.map((raw: any) => ({
      ...source({
        mp_id: raw.fakeid,
        mp_name: raw.nickname,
        mp_cover: raw.round_head_img,
        mp_intro: raw.signature,
      }),
      fakerId: raw.fakeid,
    })),
  };
}
export async function fetchWrssArticles(
  base: string | undefined,
  viewOrQuery: WrssView | ArticleQuery,
  page = 1,
  limit = 10,
  query = "",
  force = false,
): Promise<WrssPage<WrssArticle>> {
  const opts =
      typeof viewOrQuery === "string"
        ? { view: viewOrQuery, page, limit, search: query }
        : viewOrQuery,
    actualPage = opts.page ?? 1,
    actualLimit = opts.limit ?? 10,
    search = opts.search ?? "";
  const q = new URLSearchParams({
    offset: String((actualPage - 1) * actualLimit),
    limit: String(actualLimit),
    search,
  });
  if (opts.view === "favorites") q.set("only_favorite", "true");
  if (opts.view.startsWith("account:")) q.set("mp_id", opts.view.slice(8));
  if (opts.filter === "content") q.set("has_content", "true");
  if (opts.filter === "empty") q.set("has_content", "false");
  if (opts.filter === "updating") q.set("status", "updating");
  if (opts.filter === "deleted") q.set("status", "deleted");
  const key = `articles:${baseKey(base)}:${opts.view}:${actualPage}:${actualLimit}:${search}:${opts.filter ?? "all"}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS)
    return hit.value as WrssPage<WrssArticle>;
  const running = articleInflight.get(key);
  if (!force && running && !running.signal?.aborted) return running.promise;
  if (running?.signal?.aborted) articleInflight.delete(key);
  const version = (articleVersion.get(key) ?? 0) + 1;
  articleVersion.set(key, version);
  const pending = (async () => {
    const p = pagePayload(
      await request(base, `/articles?${q}`, { signal: opts.signal }),
      actualPage,
      actualLimit,
    );
    const value = { ...p, list: p.list.map(article) };
    if (articleVersion.get(key) === version)
      cache.set(key, { at: Date.now(), value });
    return value;
  })().finally(() => {
    if (articleInflight.get(key)?.promise === pending)
      articleInflight.delete(key);
  });
  articleInflight.set(key, { promise: pending, signal: opts.signal });
  return pending;
}
function updateArticleCache(
  base: string | undefined,
  id: string,
  change: Partial<WrssArticle>,
) {
  for (const [key, entry] of cache) {
    if (!key.startsWith(articlePrefix(base))) continue;
    const current = entry.value as WrssPage<WrssArticle>;
    cache.set(key, {
      ...entry,
      value: {
        ...current,
        list: current.list.map((a) => (a.id === id ? { ...a, ...change } : a)),
      },
    });
  }
}
export async function setWrssFavorite(
  base: string | undefined,
  id: string,
  favorite: boolean,
) {
  await request(
    base,
    `/articles/${encodeURIComponent(id)}/favorite?is_favorite=${favorite}`,
    { method: "PUT" },
  );
  const favorite_at = favorite ? Math.floor(Date.now() / 1000) : null;
  invalidateArticlePending(articlePrefix(base));
  updateArticleCache(base, id, { is_favorite: favorite, favorite_at });
  invalidate(`${articlePrefix(base)}favorites:`);
  return { id, is_favorite: favorite, favorite_at };
}
export async function setWrssRead(
  base: string | undefined,
  id: string,
  isRead: boolean,
) {
  await request(
    base,
    `/articles/${encodeURIComponent(id)}/read?is_read=${isRead}`,
    { method: "PUT" },
  );
  invalidateArticlePending(articlePrefix(base));
  updateArticleCache(base, id, { is_read: isRead });
  return { id, is_read: isRead };
}
export async function fetchWrssArticle(
  base: string | undefined,
  id: string,
  direction?: "prev" | "next",
) {
  return article(
    payload(
      await request(
        base,
        `/articles/${encodeURIComponent(id)}${direction ? `/${direction}` : ""}?content=true`,
      ),
    ),
  );
}
export async function refreshWrssArticle(base: string | undefined, id: string) {
  const result = await request(
    base,
    `/articles/${encodeURIComponent(id)}/refresh`,
    { method: "POST" },
  );
  invalidate(articlePrefix(base));
  return payload(result);
}
export async function deleteWrssArticle(base: string | undefined, id: string) {
  const result = await request(base, `/articles/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  invalidate(articlePrefix(base));
  return result;
}
export async function cleanWrssArticles(
  base: string | undefined,
  kind: "orphan" | "duplicate" | "old",
  options: { days?: number; mp_id?: string; dry_run?: boolean } = {},
) {
  let path =
    kind === "orphan"
      ? "/articles/clean"
      : kind === "duplicate"
        ? "/articles/clean_duplicate_articles"
        : "/articles/clean-old";
  if (kind === "old") {
    const q = new URLSearchParams({
      days: String(options.days ?? 30),
      dry_run: String(options.dry_run ?? false),
    });
    if (options.mp_id) q.set("mp_id", options.mp_id);
    path += `?${q}`;
  }
  const result = await request(base, path, { method: "DELETE" });
  invalidate(articlePrefix(base));
  return result;
}
export async function fetchWrssAuth(
  base?: string,
  signal?: AbortSignal,
): Promise<WrssAuthState> {
  const r: any = await request(base, "/sys/info", { signal });
  return payload(r)?.wx ?? { login: false };
}
export async function fetchWrssArticleSyncState(
  base?: string,
  signal?: AbortSignal,
): Promise<WrssArticleSyncState> {
  const r: any = await request(base, "/sys/info", { signal });
  const state = payload(r)?.article_sync ?? {};
  return {
    cooldown_until: Number(state.cooldown_until || 0),
    recent_error_code: state.recent_error_code == null ? null : Number(state.recent_error_code),
    recent_error_message: String(state.recent_error_message || ""),
  };
}
export async function fetchQrState(
  base?: string,
  signal?: AbortSignal,
): Promise<WrssQrState> {
  return payload(
    await request(base, "/auth/qr/status", { signal }),
  ) as WrssQrState;
}
export async function createQr(base?: string, signal?: AbortSignal) {
  return request(base, "/auth/qr/code", { signal });
}
export async function refreshQr(base?: string, signal?: AbortSignal) {
  return request(base, "/auth/qr/refresh", { method: "POST", signal });
}
export async function closeQr(base?: string) {
  return request(base, "/auth/qr/over", { method: "POST" });
}
export async function logoutWechat(base?: string) {
  return request(base, "/auth/wechat/logout", { method: "POST" });
}
export async function mockWrssAuth(
  base: string | undefined,
  action: "scan" | "confirm",
  signal?: AbortSignal,
) {
  return payload(
    await request(base, "/mock/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
      signal,
    }),
  );
}
export function qrImageUrl(base?: string, version?: number) {
  return `${(base || DEFAULT_BASE).replace(/\/$/, "")}/wrss/qr-image?v=${version ?? Date.now()}`;
}
export async function fetchExportRecords(
  base?: string,
  mpId = "",
): Promise<WrssExportRecord[]> {
  const data = payload(
    await request(base, `/tools/export/list?mp_id=${encodeURIComponent(mpId)}`),
  );
  if (!Array.isArray(data)) throw new Error("导出记录响应格式错误");
  return data;
}
export async function exportArticles(
  base: string | undefined,
  body: Record<string, unknown>,
) {
  return request(base, "/tools/export/articles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
export function exportDownloadUrl(
  base: string | undefined,
  mpId: string,
  path: string,
) {
  return endpoint(
    base,
    `/tools/export/download?mp_id=${encodeURIComponent(mpId)}&filename=${encodeURIComponent(path)}`,
  );
}
export async function deleteExport(
  base: string | undefined,
  mpId: string,
  path: string,
) {
  return request(base, "/tools/export/delete", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mp_id: mpId, filename: path }),
  });
}
export async function addWrssSource(
  base: string | undefined,
  data: { mp_id: string; mp_name: string; avatar: string; mp_intro?: string },
) {
  const mp_id = data.mp_id.trim(),
    mp_name = data.mp_name.trim();
  if (!mp_id || !mp_name) throw new Error("请输入公众号 ID 和名称");
  try {
    if (mp_id === "MP_WXS_" || !atob(mp_id).trim()) throw new Error();
  } catch {
    throw new Error("公众号 ID 无效，请重新搜索或填写有效 ID");
  }
  const result: any = await request(base, "/mps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...data, mp_id, mp_name }),
  });
  invalidate(sourcePrefix(base));
  const source = payload(result);
  return {
    source,
    syncTask: source?.sync_task ? syncTask(source.sync_task) : undefined,
  };
}
export async function deleteWrssSource(base: string | undefined, id: string) {
  const result = await request(base, `/mps/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  invalidate(sourcePrefix(base));
  return result;
}
export async function updateWrssSource(
  base: string | undefined,
  id: string,
  signal?: AbortSignal,
) {
  return syncTask(await request(
    base,
    `/mps/update/${encodeURIComponent(id)}?start_page=0&end_page=1`,
    { signal },
  ));
}
export async function fetchWrssSyncTask(
  base: string | undefined,
  taskId: string,
  signal?: AbortSignal,
) {
  return syncTask(await request(
    base,
    `/mps/update/tasks/${encodeURIComponent(taskId)}`,
    { signal },
  ));
}
export async function updateAllWrssSources(
  base?: string,
  signal?: AbortSignal,
  onTask?: (task: WrssSyncTask) => void,
) {
  let page = 1,
    submitted = 0;
  const tasks: WrssSyncTask[] = [];
  const failures: { id: string; reason: string }[] = [];
  for (;;) {
    const result = await fetchWrssSources(base, "", page, 100, true, 1, signal);
    for (const source of result.list) {
      if (source.id === "MP_WXS_") {
        failures.push({
          id: source.id,
          reason: "公众号标识不完整，请重新添加",
        });
        continue;
      }
      try {
        const task = await updateWrssSource(base, source.id, signal);
        tasks.push(task);
        onTask?.(task);
        submitted++;
      } catch (error) {
        if (
          (error as Error).name === "AbortError" ||
          (error instanceof WrssRequestError &&
            (error.status === 401 ||
              error.code === 401 ||
              error.code === 40101))
        )
          throw error;
        failures.push({
          id: source.id,
          reason: error instanceof Error ? error.message : "提交失败",
        });
      }
    }
    if (page * 100 >= result.total) break;
    page++;
  }
  return { submitted, failed: failures.length, failures, tasks };
}
export async function toggleWrssSource(
  base: string | undefined,
  id: string,
  status: number,
) {
  const result = await request(base, `/mps/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  invalidate(sourcePrefix(base));
  return result;
}
export async function lookupWrssArticleSource(
  base: string | undefined,
  url: string,
) {
  return payload(
    await request(base, `/mps/by_article?url=${encodeURIComponent(url)}`, {
      method: "POST",
    }),
  );
}
export async function addFeaturedArticle(
  base: string | undefined,
  url: string,
  signal?: AbortSignal,
) {
  return payload(
    await request(base, "/mps/featured/article", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal,
    }),
  );
}
export async function fetchFeaturedTask(
  base: string | undefined,
  id: string,
  signal?: AbortSignal,
) {
  return payload(
    await request(
      base,
      `/mps/featured/article/tasks/${encodeURIComponent(id)}`,
      { signal },
    ),
  );
}
export function subscriptionExportUrl(
  base: string | undefined,
  format: "csv" | "opml",
) {
  return endpoint(
    base,
    format === "opml" ? "/export/mps/opml" : "/export/mps/export",
  );
}
export function sourceAvatarUrl(base: string | undefined, id: string) {
  return `${(base || DEFAULT_BASE).replace(/\/$/, "")}/wrss/source-avatar/${encodeURIComponent(id)}`;
}
export function articleImageUrl(base: string | undefined, url: string) {
  return `${(base || DEFAULT_BASE).replace(/\/$/, "")}/wrss/article-image?url=${encodeURIComponent(url)}`;
}
export async function importSubscriptions(
  base: string | undefined,
  file: File,
) {
  const form = new FormData();
  form.append("file", file);
  const result = await request(base, "/export/mps/import", {
    method: "POST",
    body: form,
  });
  invalidate(sourcePrefix(base));
  return result;
}
export function clearWrssCache() {
  cache.clear();
  for (const key of cacheVersion.keys())
    cacheVersion.set(key, (cacheVersion.get(key) ?? 0) + 1);
  for (const key of articleVersion.keys())
    articleVersion.set(key, (articleVersion.get(key) ?? 0) + 1);
  articleInflight.clear();
}
