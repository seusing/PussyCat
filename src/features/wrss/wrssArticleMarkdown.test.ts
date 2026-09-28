import { describe, expect, it } from "vitest";
import {
  wrssArticleBodyToMarkdown,
  wrssArticleToMarkdown,
} from "./wrssArticleMarkdown";
import type { WrssArticle } from "./wrssClient";

const body = `
<section style="margin: 0px 8px;">
  <section style="text-align: center;">
    <p style="font-size: 17px;">
      <span leaf="">第一段</span>
      <strong><span leaf="">重点</span></strong>
    </p>
  </section>
  <section style="display: none;"></section>
  <p style="text-align: center;">
    <img style="width: 100%;" src="https://mmbiz.qpic.cn/mmbiz_jpg/a/640?wx_fmt=jpeg" />
  </p>
  <p><img data-src="https://mmbiz.qpic.cn/mmbiz_png/b/640?wx_fmt=png" src="data:image/svg+xml,placeholder" /></p>
  <p><img src="https://example.com/tracker.gif" /></p>
  <p><a href="https://mp.weixin.qq.com/s/next"><img src="https://mmbiz.qpic.cn/c/640" /></a></p>
  <h2><span>小标题</span></h2>
  <ul><li>要点一</li><li>要点二</li></ul>
  <script>alert(1)</script>
</section>`;

function article(over: Partial<WrssArticle> = {}): WrssArticle {
  return {
    id: "a1",
    title: "一篇文章",
    mp_id: "MP_WXS_123",
    mp_name: "某公众号",
    publish_time: "2026/9/20 16:47:41",
    is_favorite: false,
    link: "https://mp.weixin.qq.com/s/abc",
    content: body,
    ...over,
  };
}

describe("wrssArticleMarkdown", () => {
  it("converts WeChat article HTML into readable Markdown", () => {
    expect(wrssArticleBodyToMarkdown(body)).toBe(
      [
        "第一段 **重点**",
        "![](https://mmbiz.qpic.cn/mmbiz_jpg/a/640?wx_fmt=jpeg)",
        "![](https://mmbiz.qpic.cn/mmbiz_png/b/640?wx_fmt=png)",
        "[![](https://mmbiz.qpic.cn/c/640)](https://mp.weixin.qq.com/s/next)",
        "## 小标题",
        "-   要点一\n-   要点二",
      ].join("\n\n"),
    );
  });

  it("adds a header with the account, publish time and original link", () => {
    const markdown = wrssArticleToMarkdown(article());
    expect(
      markdown.startsWith(
        "# 一篇文章\n\n> 公众号：某公众号 · 发布时间：2026/9/20 16:47:41 · [原文链接](https://mp.weixin.qq.com/s/abc)\n\n",
      ),
    ).toBe(true);
    expect(markdown).toContain("**重点**");
  });

  it("omits the placeholder featured feed name", () => {
    const markdown = wrssArticleToMarkdown(
      article({ mp_id: "MP_WXS_FEATURED_ARTICLES", mp_name: "精选文章" }),
    );
    expect(markdown).not.toContain("精选文章");
    expect(markdown).toContain("> 发布时间：2026/9/20 16:47:41 · [原文链接]");
  });

  it("falls back to the summary when there is no HTML body", () => {
    expect(
      wrssArticleToMarkdown(
        article({ content: "", summary: "摘要", link: undefined, publish_time: "" }),
      ),
    ).toBe("# 一篇文章\n\n> 公众号：某公众号\n\n摘要\n");
  });
});
