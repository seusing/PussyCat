import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addInspirationFolder,
  loadInspirationLibrary,
} from "../inspiration/inspirationLibrary";
import { clearWrssCache } from "./wrssClient";
import {
  collectWechatArticle,
  saveWrssArticleToInspiration,
  wechatArticleUrl,
} from "./wrssInspiration";

function reply(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function stubEngine(task: Record<string, unknown> = { status: "success", id: "FEATURED_ARTICLES-abc" }) {
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/wrss/api/mps/featured/article"))
      return reply({ code: 0, data: { task_id: "t1" } });
    if (url.endsWith("/wrss/api/mps/featured/article/tasks/t1"))
      return reply({ code: 0, data: task });
    if (url.includes("/wrss/api/articles/FEATURED_ARTICLES-abc"))
      return reply({
        code: 0,
        data: {
          id: "FEATURED_ARTICLES-abc",
          title: "收藏的文章",
          mp_id: "MP_WXS_FEATURED_ARTICLES",
          mp_name: "精选文章",
          publish_time: 1700000000,
          url: "https://mp.weixin.qq.com/s/abc",
          content: '<p>正文内容</p><p><img src="https://mmbiz.qpic.cn/x/640"></p>',
        },
      });
    return reply({ error: `unexpected ${url}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  clearWrssCache();
  vi.unstubAllGlobals();
});

describe("wechatArticleUrl", () => {
  it("normalizes short and long article links", () => {
    expect(wechatArticleUrl("https://mp.weixin.qq.com/s/abc-_1?scene=1#rd")).toBe(
      "https://mp.weixin.qq.com/s/abc-_1",
    );
    expect(
      wechatArticleUrl(
        "https://mp.weixin.qq.com/s?__biz=MzA3==&mid=1&idx=2&sn=f00&chksm=aa&scene=21#wechat_redirect",
      ),
    ).toBe("https://mp.weixin.qq.com/s?__biz=MzA3%3D%3D&mid=1&idx=2&sn=f00");
  });

  it("extracts the link from shared text and rejects other pages", () => {
    expect(wechatArticleUrl("推荐一篇：https://mp.weixin.qq.com/s/abc 值得看")).toBe(
      "https://mp.weixin.qq.com/s/abc",
    );
    expect(wechatArticleUrl("https://mp.weixin.qq.com/s?src=11&timestamp=1")).toBe("");
    expect(wechatArticleUrl("https://example.com/s/abc")).toBe("");
  });
});

describe("collectWechatArticle", () => {
  it("collects an article through the engine and saves it as Markdown", async () => {
    const fetchMock = stubEngine();
    const result = await collectWechatArticle(
      undefined,
      "https://mp.weixin.qq.com/s/abc?scene=1",
    );

    expect(result.created).toBe(true);
    expect(result.item).toMatchObject({
      title: "收藏的文章",
      kind: "article",
      format: "md",
      source: "https://mp.weixin.qq.com/s/abc",
    });
    expect(result.item.content).toContain("# 收藏的文章");
    expect(result.item.content).not.toContain("精选文章");
    expect(result.item.content).toContain("[原文链接](https://mp.weixin.qq.com/s/abc)");
    expect(result.item.content).toContain("正文内容");
    expect(result.item.content).toContain("![](https://mmbiz.qpic.cn/x/640)");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      url: "https://mp.weixin.qq.com/s/abc",
    });
    expect(loadInspirationLibrary().items).toHaveLength(1);
  });

  it("saves into the folder the user is browsing", async () => {
    stubEngine();
    const folder = addInspirationFolder("资料")!;
    const { item } = await collectWechatArticle(
      undefined,
      "https://mp.weixin.qq.com/s/abc",
      undefined,
      folder.id,
    );
    expect(item.folderId).toBe(folder.id);
  });

  it("returns the existing item without refetching a saved article", async () => {
    const fetchMock = stubEngine();
    const first = await collectWechatArticle(undefined, "https://mp.weixin.qq.com/s/abc");
    fetchMock.mockClear();

    const second = await collectWechatArticle(undefined, "https://mp.weixin.qq.com/s/abc#rd");
    expect(second).toEqual({ item: first.item, created: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports failed collection tasks", async () => {
    stubEngine({ status: "failed", message: "该文章暂不可访问或已删除" });
    await expect(
      collectWechatArticle(undefined, "https://mp.weixin.qq.com/s/abc"),
    ).rejects.toThrow("该文章暂不可访问或已删除");
    expect(loadInspirationLibrary().items).toHaveLength(0);
  });

  it("explains when the engine is not ready", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => reply({ error: "公众号运行环境尚未就绪" }, 503)),
    );
    await expect(
      collectWechatArticle(undefined, "https://mp.weixin.qq.com/s/abc"),
    ).rejects.toThrow("公众号引擎未就绪，请先在公众号模块中完成安装，或稍后再试");
  });

  it("rejects text without a WeChat article link", async () => {
    const fetchMock = stubEngine();
    await expect(collectWechatArticle(undefined, "随便一段文字")).rejects.toThrow(
      "请粘贴公众号文章链接（mp.weixin.qq.com）",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("saveWrssArticleToInspiration", () => {
  it("keeps the real account name for subscription articles", () => {
    const { item } = saveWrssArticleToInspiration({
      id: "a1",
      title: "订阅文章",
      mp_id: "MP_WXS_123",
      mp_name: "某公众号",
      publish_time: "2026/9/20 16:47:41",
      is_favorite: false,
      link: "https://mp.weixin.qq.com/s/xyz?scene=1",
      content: "<p>内容</p>",
    });
    expect(item.source).toBe("https://mp.weixin.qq.com/s/xyz");
    expect(item.content).toContain("> 公众号：某公众号 · 发布时间：2026/9/20 16:47:41");
  });
});
