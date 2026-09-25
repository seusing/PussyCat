import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { WrssSyncManager } from "./useWrssSyncManager";

const api = vi.hoisted(() => ({
  articleImageUrl: vi.fn((_base: string | undefined, url: string) => url),
  deleteWrssArticle: vi.fn(),
  fetchWrssArticle: vi.fn(),
  fetchWrssArticles: vi.fn(),
  fetchWrssAuth: vi.fn(),
  refreshWrssArticle: vi.fn(),
  setWrssFavorite: vi.fn(),
  setWrssRead: vi.fn(),
}));
vi.mock("./wrssClient", () => api);
import WrssArticleList from "./WrssArticleList";

const article = (id = "1", title = "Article") => ({
  id,
  title,
  mp_id: "m",
  mp_name: "Source",
  publish_time: "now",
  is_favorite: false,
});
const page = (list = [article()]) => ({ list, total: list.length, page: 1, limit: 10 });
const manager: WrssSyncManager = {
  tasks: [],
  cooldownUntil: 0,
  ready: true,
  autoSyncAllowed: true,
  error: "",
  trackSubmitted: vi.fn(),
  submitSource: vi.fn(),
  submitAll: vi.fn(),
  recheck: vi.fn(),
};
const props = { view: "latest" as const, active: true, onError: vi.fn(), syncManager: manager };

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  props.onError.mockReset();
  manager.tasks = [];
  manager.ready = true;
  manager.autoSyncAllowed = true;
  manager.error = "";
  vi.mocked(manager.trackSubmitted).mockReset();
  vi.mocked(manager.submitSource).mockReset().mockResolvedValue({ task_id: "one", mp_id: "m", status: "queued", code: 0, message: "任务已排队", cooldown_until: 0 });
  vi.mocked(manager.submitAll).mockReset().mockResolvedValue({ submitted: 1, failed: 0, failures: [], tasks: [{ task_id: "all", mp_id: "m", status: "queued", code: 0, message: "任务已排队", cooldown_until: 0 }] });
  vi.mocked(manager.recheck).mockReset();
  api.fetchWrssArticles.mockResolvedValue(page());
  api.fetchWrssAuth.mockResolvedValue({ login: true });
  api.setWrssRead.mockResolvedValue({ id: "1", is_read: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("WrssArticleList", () => {
  it("requests the initial latest page without filters", async () => {
    render(<WrssArticleList {...props} />);
    await screen.findByText("Article");
    expect(api.fetchWrssArticles).toHaveBeenCalledWith(
      undefined,
      { view: "latest", page: 1, limit: 10, search: "", filter: "all", signal: expect.any(AbortSignal) },
      1,
      10,
      "",
      false,
    );
  });

  it("submits one managed sync for an empty default latest page in StrictMode", async () => {
    api.fetchWrssArticles.mockResolvedValue(page([]));
    render(<StrictMode><WrssArticleList {...props} /></StrictMode>);
    await waitFor(() => expect(manager.submitAll).toHaveBeenCalledOnce());
    expect(screen.getByText(/已提交 1 个更新任务/)).toBeVisible();
  });

  it("does not auto-sync when the initial latest request fails", async () => {
    api.fetchWrssArticles.mockRejectedValueOnce(new Error("initial read failed"));
    render(<WrssArticleList {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("initial read failed");
    expect(manager.submitAll).not.toHaveBeenCalled();
  });

  it("waits for sync state and respects a historical frequency limit", async () => {
    api.fetchWrssArticles.mockResolvedValue(page([]));
    const unavailable = { ...manager, ready: false, autoSyncAllowed: false };
    const { rerender } = render(<WrssArticleList {...props} syncManager={unavailable} />);
    await waitFor(() => expect(api.fetchWrssArticles).toHaveBeenCalled());
    expect(manager.submitAll).not.toHaveBeenCalled();
    rerender(<WrssArticleList {...props} syncManager={{ ...unavailable, ready: true }} />);
    await act(async () => Promise.resolve());
    expect(manager.submitAll).not.toHaveBeenCalled();
  });

  it("never auto-syncs an empty non-latest view", async () => {
    api.fetchWrssArticles.mockResolvedValue(page([]));
    render(<WrssArticleList {...props} view="favorites" />);
    await waitFor(() => expect(api.fetchWrssArticles).toHaveBeenCalled());
    expect(manager.submitAll).not.toHaveBeenCalled();
  });

  it("shows managed task failure and rechecks the same task", async () => {
    api.fetchWrssArticles.mockResolvedValue(page([]));
    const failed = { ...manager, autoSyncAllowed: false, error: "同步状态观察已超时，可重新检查当前任务" };
    render(<WrssArticleList {...props} syncManager={failed} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("观察已超时");
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    await waitFor(() => expect(manager.recheck).toHaveBeenCalledOnce());
    expect(manager.submitAll).not.toHaveBeenCalled();
  });

  it("retains successful rows on failure and clears the error on a successful empty load", async () => {
    const { rerender } = render(<WrssArticleList {...props} view="favorites" refreshToken={0} />);
    expect(await screen.findByText("Article")).toBeVisible();
    api.fetchWrssArticles.mockRejectedValueOnce(new Error("load failed"));
    rerender(<WrssArticleList {...props} view="favorites" refreshToken={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("load failed");
    expect(screen.getByText("Article")).toBeVisible();
    api.fetchWrssArticles.mockResolvedValueOnce(page([]));
    rerender(<WrssArticleList {...props} view="favorites" refreshToken={2} />);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.queryByText("Article")).not.toBeInTheDocument();
  });

  it("ignores a stale response from the previous view", async () => {
    let resolveOld!: (value: ReturnType<typeof page>) => void;
    api.fetchWrssArticles
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(page([article("2", "Current")]));
    const { rerender } = render(<WrssArticleList {...props} />);
    rerender(<WrssArticleList {...props} view="account:m" />);
    expect(await screen.findByText("Current")).toBeVisible();
    await act(async () => resolveOld(page([article("1", "Stale")])));
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
  });

  it("starts cooldown only after a successful manual refresh", async () => {
    render(<WrssArticleList {...props} />);
    expect(await screen.findByText("Article")).toBeVisible();
    api.fetchWrssArticles.mockRejectedValueOnce(new Error("refresh failed"));
    fireEvent.click(screen.getByRole("button", { name: "刷新文章列表" }));
    await screen.findByText("refresh failed");
    expect(screen.getByRole("button", { name: "刷新文章列表" })).toBeEnabled();
    api.fetchWrssArticles.mockResolvedValueOnce(page());
    fireEvent.click(screen.getByRole("button", { name: "刷新文章列表" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新文章列表" })).toBeDisabled());
  });

  it("sanitizes HTML article bodies", async () => {
    api.fetchWrssArticle.mockResolvedValue({ ...article(), content: '<h2>Heading</h2><p onclick="bad()">Body</p><script>bad()</script><iframe src="https://bad.test"></iframe>' });
    render(<WrssArticleList {...props} />);
    fireEvent.click(await screen.findByText("Article"));
    expect(await screen.findByRole("heading", { name: "Heading" })).toBeVisible();
    expect(screen.getByText("Body")).not.toHaveAttribute("onclick");
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("keeps failed batch items selected and removes successful IDs", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    api.fetchWrssArticles.mockResolvedValue(page([article("1", "One"), article("2", "Two")]));
    api.deleteWrssArticle.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("delete failed"));
    render(<WrssArticleList {...props} view="favorites" />);
    await screen.findByText("One");
    fireEvent.click(screen.getByLabelText("选择本页文章"));
    fireEvent.click(screen.getByRole("button", { name: "批量删除" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("delete failed");
    expect(screen.queryByText("One")).not.toBeInTheDocument();
    expect(screen.getByLabelText("选择 Two")).toBeChecked();
  });
});
