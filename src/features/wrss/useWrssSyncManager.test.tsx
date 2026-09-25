import { forwardRef, useImperativeHandle } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WrssSyncTask } from "./wrssClient";

const api = vi.hoisted(() => ({
  fetchWrssArticleSyncState: vi.fn(),
  fetchWrssSyncTask: vi.fn(),
  updateAllWrssSources: vi.fn(),
  updateWrssSource: vi.fn(),
}));
vi.mock("./wrssClient", () => api);
import { useWrssSyncManager, type WrssSyncManager } from "./useWrssSyncManager";

const queued = (id = "task"): WrssSyncTask => ({
  task_id: id,
  mp_id: "source",
  status: "queued",
  code: 0,
  message: "任务已排队",
  cooldown_until: 0,
});

const Harness = forwardRef<WrssSyncManager, { baseUrl: string; active: boolean; session: number; onSucceeded: () => void }>(
  ({ baseUrl, active, session, onSucceeded }, ref) => {
    const manager = useWrssSyncManager(baseUrl, active, session, onSucceeded);
    useImperativeHandle(ref, () => manager, [manager]);
    return null;
  },
);

describe("useWrssSyncManager", () => {
  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
    api.fetchWrssArticleSyncState.mockResolvedValue({ cooldown_until: 0, recent_error_code: null });
    api.updateWrssSource.mockResolvedValue(queued());
    api.updateAllWrssSources.mockResolvedValue({ submitted: 1, failed: 0, failures: [], tasks: [queued()] });
    api.fetchWrssSyncTask.mockResolvedValue(queued());
  });
  afterEach(() => vi.useRealTimers());

  it("ignores a cooldown response from an old session", async () => {
    let resolveOld!: (value: unknown) => void;
    api.fetchWrssArticleSyncState
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ cooldown_until: 0, recent_error_code: null });
    const ref = { current: null as WrssSyncManager | null };
    const { rerender } = render(<Harness ref={ref} baseUrl="one" active session={1} onSucceeded={vi.fn()} />);
    rerender(<Harness ref={ref} baseUrl="two" active session={2} onSucceeded={vi.fn()} />);
    await waitFor(() => expect(ref.current?.ready).toBe(true));
    await act(async () => resolveOld({ cooldown_until: 9999999999, recent_error_code: 200013 }));
    expect(ref.current?.cooldownUntil).toBe(0);
    expect(ref.current?.autoSyncAllowed).toBe(true);
  });

  it("preserves tasks while inactive and resumes observation", async () => {
    vi.useFakeTimers();
    const ref = { current: null as WrssSyncManager | null };
    const { rerender } = render(<Harness ref={ref} baseUrl="host" active session={1} onSucceeded={vi.fn()} />);
    await act(async () => { await ref.current?.submitSource("source"); });
    expect(ref.current?.tasks).toHaveLength(1);
    rerender(<Harness ref={ref} baseUrl="host" active={false} session={1} onSucceeded={vi.fn()} />);
    expect(ref.current?.tasks).toHaveLength(1);
    rerender(<Harness ref={ref} baseUrl="host" active session={1} onSucceeded={vi.fn()} />);
    await act(async () => { vi.advanceTimersByTime(2500); await Promise.resolve(); });
    expect(api.fetchWrssSyncTask).toHaveBeenCalledWith("host", "task", expect.any(AbortSignal));
  });

  it("fires completion once for an immediately succeeded task", async () => {
    const succeeded = { ...queued(), status: "succeeded" as const, message: "抓取完成" };
    api.updateWrssSource.mockResolvedValue(succeeded);
    const done = vi.fn();
    const ref = { current: null as WrssSyncManager | null };
    render(<Harness ref={ref} baseUrl="host" active session={1} onSucceeded={done} />);
    await waitFor(() => expect(ref.current?.ready).toBe(true));
    await act(async () => { await ref.current?.submitSource("source"); await Promise.resolve(); });
    expect(done).toHaveBeenCalledOnce();
  });

  it("keeps automatic sync disabled after tracking a frequency-limit task", async () => {
    const ref = { current: null as WrssSyncManager | null };
    render(<Harness ref={ref} baseUrl="host" active session={1} onSucceeded={vi.fn()} />);
    await waitFor(() => expect(ref.current?.ready).toBe(true));
    act(() => ref.current?.trackSubmitted({ ...queued(), status: "blocked", code: 200013, cooldown_until: 1 }));
    expect(ref.current?.autoSyncAllowed).toBe(false);
  });

  it("recheck reloads sync state even when no task is pending", async () => {
    const ref = { current: null as WrssSyncManager | null };
    render(<Harness ref={ref} baseUrl="host" active session={1} onSucceeded={vi.fn()} />);
    await waitFor(() => expect(ref.current?.ready).toBe(true));
    act(() => ref.current?.recheck());
    await waitFor(() => expect(api.fetchWrssArticleSyncState).toHaveBeenCalledTimes(2));
  });

  it("keeps incrementally submitted tasks when leaving aborts the rest of a batch", async () => {
    api.updateAllWrssSources.mockImplementation((_base, signal, onTask) => new Promise((_resolve, reject) => {
      onTask(queued("first"));
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const ref = { current: null as WrssSyncManager | null };
    const { rerender } = render(<Harness ref={ref} baseUrl="host" active session={1} onSucceeded={vi.fn()} />);
    await waitFor(() => expect(ref.current?.ready).toBe(true));
    const submission = ref.current!.submitAll().catch((error) => error);
    await waitFor(() => expect(ref.current?.tasks.map((task) => task.task_id)).toEqual(["first"]));
    rerender(<Harness ref={ref} baseUrl="host" active={false} session={1} onSucceeded={vi.fn()} />);
    await expect(submission).resolves.toMatchObject({ name: "AbortError" });
    expect(ref.current?.tasks.map((task) => task.task_id)).toEqual(["first"]);
  });

  it("aborts a hanging status request at the observation deadline", async () => {
    vi.useFakeTimers();
    api.fetchWrssSyncTask.mockImplementation((_base, _id, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const ref = { current: null as WrssSyncManager | null };
    render(<Harness ref={ref} baseUrl="host" active session={1} onSucceeded={vi.fn()} />);
    await act(async () => { await ref.current?.submitSource("source"); });
    await act(async () => { vi.advanceTimersByTime(120000); await Promise.resolve(); });
    expect(ref.current?.error).toContain("观察已超时");
  });
});
