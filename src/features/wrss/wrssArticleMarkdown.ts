import DOMPurify from "dompurify";
import TurndownService from "turndown";
import { wrssImageRemote, type WrssArticle } from "./wrssClient";

// 单篇收录的文章都挂在这个固定的"精选文章"订阅下,它的名字不是真实公众号名。
const FEATURED_MP_ID = "MP_WXS_FEATURED_ARTICLES";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
});
turndown.addRule("wechatImage", {
  filter: "img",
  replacement: (_content, node) => {
    const image = node as HTMLImageElement,
      remote = wrssImageRemote(
        image.getAttribute("src"),
        image.getAttribute("data-src"),
      );
    if (!remote) return "";
    const alt = (image.getAttribute("alt") || "").replace(/[[\]]/g, "");
    return `![${alt}](${remote})`;
  },
});

export function wrssArticleBodyToMarkdown(html: string) {
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["iframe", "style"],
  });
  return turndown
    .turndown(sanitized)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function wrssArticleToMarkdown(article: WrssArticle) {
  const raw = article.content || "",
    body = /<[a-z][\s\S]*>/i.test(raw)
      ? wrssArticleBodyToMarkdown(raw)
      : (raw || article.summary || "").trim(),
    meta = [
      article.mp_id !== FEATURED_MP_ID && article.mp_name
        ? `公众号：${article.mp_name}`
        : "",
      article.publish_time ? `发布时间：${article.publish_time}` : "",
      article.link ? `[原文链接](${article.link})` : "",
    ].filter(Boolean);
  return `${[
    `# ${article.title.replace(/\s+/g, " ").trim()}`,
    meta.length ? `> ${meta.join(" · ")}` : "",
    body,
  ]
    .filter(Boolean)
    .join("\n\n")}\n`;
}
