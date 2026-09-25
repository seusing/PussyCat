import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addWrssSource,
  clearWrssCache,
  fetchWrssArticles,
  fetchWrssSources,
  setWrssFavorite,
  updateAllWrssSources,
} from "./wrssClient";
function reply(body: any) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}
afterEach(() => {
  clearWrssCache();
  vi.unstubAllGlobals();
});
describe("wrssClient", () => {
  it("uses the exact initial latest request and preserves server order", async () => {
    const fetchMock = vi.fn((..._args: any[]) =>
      reply({
        code: 0,
        data: {
          list: [
            {
              id: 2,
              title: "B",
              mp_id: "m",
              mp_name: "M",
              publish_time: 1700000000,
            },
            {
              id: 1,
              title: "A",
              mp_id: "m",
              mp_name: "M",
              publish_time: 1700000001,
            },
          ],
          total: 2,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const page = await fetchWrssArticles("http://host", {
      view: "latest",
      page: 1,
      limit: 10,
      search: "",
      filter: "all",
    });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/wrss/api/articles?offset=0&limit=10&search=");
    expect(url).not.toContain("mp_id=");
    expect(url).not.toContain("only_favorite=");
    expect(page.list.map((article) => article.id)).toEqual(["2", "1"]);
    expect(page.list[0].publish_time).not.toBe("1700000000");
  });
  it("normalizes real source fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        reply({
          code: 0,
          data: {
            list: [
              {
                mp_id: "m",
                mp_name: "Name",
                mp_intro: "Intro",
                mp_cover: "a",
                status: 0,
                article_count: 3,
              },
            ],
            total: 1,
          },
        }),
      ),
    );
    const page = await fetchWrssSources();
    expect(page.list[0]).toMatchObject({
      id: "m",
      name: "Name",
      intro: "Intro",
      avatar: "a",
      enabled: false,
    });
  });
  it("rejects a source without an ID or name before requesting the Host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      addWrssSource(undefined, {
        mp_id: "  ",
        mp_name: "Name",
        avatar: "",
      }),
    ).rejects.toThrow("请输入公众号 ID 和名称");
    await expect(
      addWrssSource(undefined, {
        mp_id: "fake-id",
        mp_name: "  ",
        avatar: "",
      }),
    ).rejects.toThrow("请输入公众号 ID 和名称");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("accepts favorite confirmation without replacing the article", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => reply({ code: 0, message: "ok", is_favorite: true })),
    );
    await expect(setWrssFavorite(undefined, "1", true)).resolves.toMatchObject({
      id: "1",
      is_favorite: true,
    });
  });
  it("rejects a successful HTTP response with backend error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => reply({ code: 40101, message: "未授权" })),
    );
    await expect(fetchWrssArticles(undefined, "latest")).rejects.toThrow(
      "未授权",
    );
  });
  it("reuses article cache unless force is requested", async () => {
    const fetchMock = vi.fn(() =>
      reply({ code: 0, data: { list: [], total: 0 } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await fetchWrssArticles("http://host", "latest");
    await fetchWrssArticles("http://host", "latest");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await fetchWrssArticles("http://host", "latest", 1, 10, "", true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("does not let an inflight request repopulate cache after clear", async () => {
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockImplementation(() =>
        reply({
          code: 0,
          data: { list: [{ id: "new", title: "New" }], total: 1 },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const stale = fetchWrssArticles("http://host", "latest");
    clearWrssCache();
    resolveFirst(
      new Response(
        JSON.stringify({
          code: 0,
          data: { list: [{ id: "old", title: "Old" }], total: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await stale;
    const current = await fetchWrssArticles("http://host", "latest");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(current.list[0].id).toBe("new");
  });
  it("does not reuse an inflight article request after its signal is aborted",async()=>{const first=new AbortController(),fetchMock=vi.fn((_url:string,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true})})).mockImplementationOnce((_url:string,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true})})).mockImplementationOnce(()=>reply({code:0,data:{list:[{id:'fresh',title:'Fresh'}],total:1}}));vi.stubGlobal('fetch',fetchMock);const stale=fetchWrssArticles('http://host',{view:'latest',signal:first.signal});first.abort();await expect(stale).rejects.toThrow('aborted');const current=await fetchWrssArticles('http://host',{view:'latest',signal:new AbortController().signal});expect(current.list[0].id).toBe('fresh');expect(fetchMock).toHaveBeenCalledTimes(2)})
  it("keeps article mutations scoped to one base URL",async()=>{const fetchMock=vi.fn((url:string)=>url.includes('/favorite')?reply({code:0}):reply({code:0,data:{list:[{id:'1',title:'A',is_favorite:false}],total:1}}));vi.stubGlobal('fetch',fetchMock);await fetchWrssArticles('http://one','latest');await fetchWrssArticles('http://two','latest');await setWrssFavorite('http://one','1',true);expect((await fetchWrssArticles('http://one','latest')).list[0].is_favorite).toBe(true);expect((await fetchWrssArticles('http://two','latest')).list[0].is_favorite).toBe(false);expect(fetchMock).toHaveBeenCalledTimes(3)})
  it("does not let an inflight source request repopulate cache after clear",async()=>{let resolveFirst!:(value:Response)=>void;const first=new Promise<Response>(resolve=>{resolveFirst=resolve});const fetchMock=vi.fn().mockReturnValueOnce(first).mockImplementation(()=>reply({code:0,data:{list:[{mp_id:'new',mp_name:'New'}],total:1}}));vi.stubGlobal('fetch',fetchMock);const stale=fetchWrssSources('http://host');clearWrssCache();resolveFirst(new Response(JSON.stringify({code:0,data:{list:[{mp_id:'old',mp_name:'Old'}],total:1}}),{status:200,headers:{'content-type':'application/json'}}));await stale;expect((await fetchWrssSources('http://host')).list[0].id).toBe('new');expect(fetchMock).toHaveBeenCalledTimes(2)})
  it("skips the known incomplete legacy source when updating all",async()=>{const fetchMock=vi.fn((url:string)=>url.includes('/mps?')?reply({code:0,data:{list:[{mp_id:'MP_WXS_',mp_name:'Legacy',status:1},{mp_id:'valid',mp_name:'Valid',status:1}],total:2}}):reply({code:0,data:{task_id:'task',mp_id:'valid',status:'queued'}}));vi.stubGlobal('fetch',fetchMock);const result=await updateAllWrssSources('http://host');expect(result).toEqual({submitted:1,failed:1,failures:[{id:'MP_WXS_',reason:'公众号标识不完整，请重新添加'}],tasks:[expect.objectContaining({task_id:'task',mp_id:'valid',status:'queued'})]});expect(fetchMock).toHaveBeenCalledTimes(2);expect(String(fetchMock.mock.calls[1][0])).toContain('/mps/update/valid')})
});
