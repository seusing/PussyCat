import {
  addInspirationItem,
  findInspirationItemBySource,
  type InspirationItem,
} from "../inspiration/inspirationLibrary";
import { wrssArticleToMarkdown } from "./wrssArticleMarkdown";
import {
  WrssRequestError,
  addFeaturedArticle,
  fetchWrssArticle,
  waitFeaturedTask,
  type WrssArticle,
} from "./wrssClient";

export interface WrssInspirationResult {
  item: InspirationItem;
  created: boolean;
}

const ARTICLE_URL = /https?:\/\/mp\.weixin\.qq\.com\/s[^\s"'<>，。）)]*/i;
const ARTICLE_KEYS = ["__biz", "mid", "idx", "sn"];

// 同一篇文章会以短链、带追踪参数的长链等不同形式出现,去掉无关参数后才能按链接去重。
export function wechatArticleUrl(text: string) {
  const match = text.match(ARTICLE_URL);
  if (!match) return "";
  try {
    const url = new URL(match[0]);
    if (url.hostname !== "mp.weixin.qq.com") return "";
    if (url.pathname.startsWith("/s/") && url.pathname.length > 3)
      return `https://mp.weixin.qq.com${url.pathname}`;
    if (url.pathname !== "/s") return "";
    const query = new URLSearchParams();
    for (const key of ARTICLE_KEYS) {
      const value = url.searchParams.get(key);
      if (value) query.set(key, value);
    }
    return ARTICLE_KEYS.every((key) => query.has(key))
      ? `https://mp.weixin.qq.com/s?${query}`
      : "";
  } catch {
    return "";
  }
}

export function saveWrssArticleToInspiration(
  article: WrssArticle,
  folderId: string | null = null,
): WrssInspirationResult {
  const source = wechatArticleUrl(article.link || "") || article.link || "";
  const existing = source ? findInspirationItemBySource(source) : null;
  if (existing) return { item: existing, created: false };
  const item = addInspirationItem({
    title: article.title,
    content: wrssArticleToMarkdown(source ? { ...article, link: source } : article),
    kind: "article",
    format: "md",
    folderId,
    ...(source ? { source } : {}),
  });
  if (!item) throw new Error("保存到灵感库失败，请检查本地存储空间");
  return { item, created: true };
}

export async function collectWechatArticle(
  base: string | undefined,
  text: string,
  signal?: AbortSignal,
  folderId: string | null = null,
): Promise<WrssInspirationResult> {
  const url = wechatArticleUrl(text);
  if (!url) throw new Error("请粘贴公众号文章链接（mp.weixin.qq.com）");
  const existing = findInspirationItemBySource(url);
  if (existing) return { item: existing, created: false };
  try {
    const created = await addFeaturedArticle(base, url, signal),
      taskId = String(created?.task_id || "");
    if (!taskId) throw new Error("收录任务未返回任务编号");
    const task = await waitFeaturedTask(base, taskId, signal);
    if (task.status === "failed")
      throw new Error(task.message || "文章抓取失败");
    if (task.status !== "success" && task.status !== "completed")
      throw new Error("文章抓取超时，请稍后重试");
    if (!task.id) throw new Error("收录任务未返回文章编号");
    const article = await fetchWrssArticle(base, task.id);
    return saveWrssArticleToInspiration({ ...article, link: url }, folderId);
  } catch (error) {
    if (error instanceof TypeError)
      throw new Error("无法连接爪爪本地服务，请稍后重试");
    if (error instanceof WrssRequestError && error.status === 503)
      throw new Error("公众号引擎未就绪，请先在公众号模块中完成安装，或稍后再试");
    throw error;
  }
}
