import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchWrssArticleSyncState,
  fetchWrssSyncTask,
  updateAllWrssSources,
  updateWrssSource,
  type WrssSyncTask,
} from "./wrssClient";

const POLL_INTERVAL = 2500;
const POLL_WINDOW = 120000;
const terminal = (status: WrssSyncTask["status"]) =>
  status === "succeeded" || status === "failed" || status === "blocked";

export interface WrssSyncManager {
  tasks: WrssSyncTask[];
  cooldownUntil: number;
  ready: boolean;
  autoSyncAllowed: boolean;
  error: string;
  trackSubmitted: (task: WrssSyncTask) => void;
  submitSource: (mpId: string) => Promise<WrssSyncTask>;
  submitAll: () => Promise<Awaited<ReturnType<typeof updateAllWrssSources>>>;
  recheck: () => void;
}

export function useWrssSyncManager(
  baseUrl: string | undefined,
  active: boolean,
  sessionKey: number,
  onSucceeded: () => void,
): WrssSyncManager {
  const [tasks, setTasks] = useState<WrssSyncTask[]>([]);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [ready, setReady] = useState(false);
  const [historicalRateLimit, setHistoricalRateLimit] = useState(false);
  const [error, setError] = useState("");
  const [pollEpoch, setPollEpoch] = useState(0);
  const generation = useRef(0);
  const sessionController = useRef<AbortController | null>(null);
  const startedAt = useRef(new Map<string, number>());
  const completed = useRef(new Set<string>());
  const callback = useRef(onSucceeded);
  callback.current = onSucceeded;

  const isCurrent = useCallback(
    (expected: number) =>
      active && generation.current === expected && !sessionController.current?.signal.aborted,
    [active],
  );

  const track = useCallback((incoming: WrssSyncTask[], expected: number) => {
    if (!isCurrent(expected)) return;
    const now = Date.now();
    let completedNow = false;
    for (const task of incoming) {
      if (!startedAt.current.has(task.task_id)) startedAt.current.set(task.task_id, now);
      if (task.status === "succeeded" && !completed.current.has(task.task_id)) {
        completed.current.add(task.task_id);
        completedNow = true;
      }
    }
    setTasks((current) => {
      const retained = current.filter((existing) =>
        !incoming.some((task) =>
          task.mp_id === existing.mp_id && task.task_id !== existing.task_id && terminal(existing.status),
        ),
      );
      const next = new Map(retained.map((task) => [task.task_id, task]));
      for (const task of incoming) next.set(task.task_id, task);
      return [...next.values()];
    });
    const newestCooldown = Math.max(0, ...incoming.map((task) => task.cooldown_until || 0));
    if (newestCooldown) setCooldownUntil((current) => Math.max(current, newestCooldown));
    if (incoming.some((task) => task.code === 200013)) setHistoricalRateLimit(true);
    if (completedNow) queueMicrotask(() => {
      if (isCurrent(expected)) callback.current();
    });
  }, [isCurrent]);

  useEffect(() => {
    generation.current++;
    sessionController.current?.abort();
    sessionController.current = null;
    setTasks([]);
    setReady(false);
    setCooldownUntil(0);
    setHistoricalRateLimit(false);
    setError("");
    startedAt.current.clear();
    completed.current.clear();
  }, [baseUrl, sessionKey]);

  useEffect(() => {
    const expected = ++generation.current;
    sessionController.current?.abort();
    if (!active) {
      sessionController.current = null;
      return;
    }
    const controller = new AbortController();
    sessionController.current = controller;
    setReady(false);
    const now = Date.now();
    setTasks((current) => {
      for (const task of current) if (!terminal(task.status)) startedAt.current.set(task.task_id, now);
      return current;
    });
    void fetchWrssArticleSyncState(baseUrl, controller.signal)
      .then((state) => {
        if (!isCurrent(expected)) return;
        setCooldownUntil(state.cooldown_until);
        setHistoricalRateLimit(state.recent_error_code === 200013);
        setReady(true);
        setError("");
      })
      .catch((cause) => {
        if ((cause as Error).name === "AbortError" || !isCurrent(expected)) return;
        setReady(true);
        setError(cause instanceof Error ? cause.message : "同步状态加载失败");
      });
    return () => controller.abort();
  }, [active, baseUrl, isCurrent, pollEpoch, sessionKey]);

  useEffect(() => {
    const expected = generation.current;
    const pending = tasks.filter((task) => !terminal(task.status));
    if (!active || !pending.length) return;
    const controller = new AbortController();
    let timer = 0;
    const deadline = Math.min(...pending.map((task) => (startedAt.current.get(task.task_id) ?? Date.now()) + POLL_WINDOW));
    const deadlineTimer = window.setTimeout(() => {
      controller.abort();
      if (isCurrent(expected)) setError("同步状态观察已超时，可重新检查当前任务");
    }, Math.max(0, deadline - Date.now()));
    const poll = async () => {
      const updates: WrssSyncTask[] = [];
      const errors: string[] = [];
      let pollable = false;
      for (const task of pending) {
        if (Date.now() - (startedAt.current.get(task.task_id) ?? Date.now()) >= POLL_WINDOW)
          continue;
        pollable = true;
        try {
          updates.push(await fetchWrssSyncTask(baseUrl, task.task_id, controller.signal));
        } catch (cause) {
          if ((cause as Error).name === "AbortError" || !isCurrent(expected)) return;
          errors.push(cause instanceof Error ? cause.message : "同步任务状态查询失败");
        }
      }
      if (!isCurrent(expected)) return;
      if (updates.length) track(updates, expected);
      if (errors.length) setError(errors.join("；"));
      else if (updates.length) setError("");
      if (!pollable) setError("同步状态观察已超时，可重新检查当前任务");
      else timer = window.setTimeout(poll, POLL_INTERVAL);
    };
    timer = window.setTimeout(poll, POLL_INTERVAL);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      window.clearTimeout(deadlineTimer);
    };
  }, [active, baseUrl, isCurrent, pollEpoch, tasks, track]);

  const submitSource = useCallback(async (mpId: string) => {
    const expected = generation.current;
    const task = await updateWrssSource(baseUrl, mpId, sessionController.current?.signal);
    if (!isCurrent(expected)) throw new DOMException("同步会话已结束", "AbortError");
    track([task], expected);
    return task;
  }, [baseUrl, isCurrent, track]);

  const submitAll = useCallback(async () => {
    const expected = generation.current;
    const result = await updateAllWrssSources(
      baseUrl,
      sessionController.current?.signal,
      (task) => track([task], expected),
    );
    if (!isCurrent(expected)) throw new DOMException("同步会话已结束", "AbortError");
    track(result.tasks, expected);
    return result;
  }, [baseUrl, isCurrent, track]);

  return {
    tasks,
    cooldownUntil,
    ready,
    autoSyncAllowed:
      ready && !error && !historicalRateLimit && cooldownUntil <= Math.floor(Date.now() / 1000),
    error,
    trackSubmitted: (task) => track([task], generation.current),
    submitSource,
    submitAll,
    recheck: () => {
      const now = Date.now();
      for (const task of tasks) if (!terminal(task.status)) startedAt.current.set(task.task_id, now);
      setError("");
      setPollEpoch((value) => value + 1);
    },
  };
}
