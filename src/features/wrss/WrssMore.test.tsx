import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const api = vi.hoisted(() => ({
  addFeaturedArticle: vi.fn(),
  cleanWrssArticles: vi.fn(),
  clearWrssCache: vi.fn(),
  fetchFeaturedTask: vi.fn(),
  importSubscriptions: vi.fn(),
  logoutWechat: vi.fn(),
  subscriptionExportUrl: vi.fn(),
}));
const host = vi.hoisted(() => ({ fetchVkWrssManagedStatus: vi.fn() }));
vi.mock("./wrssClient", () => api);
vi.mock("../../host/vkClient", () => host);
vi.mock("./wrssExternal", () => ({ downloadWrssFile: vi.fn() }));
import WrssMore from "./WrssMore";

const props = {
  mode: "preview" as const,
  auth: { login: false },
  activeView: "latest" as const,
  onNavigate: vi.fn(),
  onAddSource: vi.fn(),
  onAuthChange: vi.fn(),
  onRefresh: vi.fn(),
};

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  host.fetchVkWrssManagedStatus.mockReset();
  host.fetchVkWrssManagedStatus.mockResolvedValue({
    state: "running",
    summary: "ready",
    progress_log: ["a very long diagnostic line"],
  });
});

describe("WrssMore", () => {
  it("closes on Escape and when the active view changes", () => {
    const { rerender } = render(<WrssMore {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    const menu = screen.getByRole("menu");
    expect(menu).toBeVisible();
    expect(menu).toHaveClass("glass-menu-effect");
    expect(menu.parentElement).toBe(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    rerender(<WrssMore {...props} activeView="favorites" />);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes for outside pointer input without changing a command", () => {
    render(<WrssMore {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it("loads diagnostics only after its collapsed group opens", async () => {
    render(<WrssMore {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(host.fetchVkWrssManagedStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("设置与诊断"));
    await waitFor(() => expect(host.fetchVkWrssManagedStatus).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("诊断日志")).toHaveTextContent("a very long diagnostic line");
  });
});
