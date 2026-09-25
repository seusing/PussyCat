import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeQr,
  createQr,
  fetchQrState,
  fetchWrssAuth,
  logoutWechat,
  mockWrssAuth,
  qrImageUrl,
  refreshQr,
  type WrssAuthState,
  type WrssQrState,
} from "./wrssClient";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "授权操作失败";
const waitSecond = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const cancel = () => {
        clearTimeout(timer);
        reject(new DOMException("已取消", "AbortError"));
      },
      timer = window.setTimeout(() => {
        signal.removeEventListener("abort", cancel);
        resolve();
      }, 1000);
    signal.addEventListener("abort", cancel, { once: true });
  });
export default function WrssAuthorization({
  baseUrl,
  mode,
  active,
  onError,
  onAuthChange,
  initialAuth,
}: {
  baseUrl?: string;
  mode: "preview" | "real";
  active: boolean;
  onError?: (e: unknown) => void;
  onAuthChange?: (state: WrssAuthState) => void;
  initialAuth?: WrssAuthState | null;
}) {
  const [auth, setAuth] = useState<WrssAuthState | null>(initialAuth ?? null),
    [qr, setQr] = useState<WrssQrState | null>(null),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [seconds, setSeconds] = useState(60),
    [image, setImage] = useState(""),
    [error, setError] = useState(""),
    [sessionId, setSessionId] = useState(0);
  const operation = useRef<AbortController | null>(null),
    session = useRef<AbortController | null>(null),
    expiresAt = useRef(0),
    qrRef = useRef<WrssQrState | null>(null),
    polling = useRef(false),
    renewing = useRef(false),
    authGeneration = useRef(0);
  useEffect(() => {
    qrRef.current = qr;
  }, [qr]);
  useEffect(() => {
    if (initialAuth) setAuth(initialAuth);
  }, [initialAuth]);
  const report = useCallback(
    (cause: unknown) => {
      if ((cause as Error).name === "AbortError") return;
      setError(errorText(cause));
      onError?.(cause);
    },
    [onError],
  );
  const storeAuth = useCallback(
    (next: WrssAuthState) => {
      setAuth(next);
      onAuthChange?.(next);
    },
    [onAuthChange],
  );
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const generation = ++authGeneration.current;
      const next = await fetchWrssAuth(baseUrl, signal);
      if (generation === authGeneration.current) storeAuth(next);
      return next;
    },
    [baseUrl, storeAuth],
  );
  const applyQr = useCallback((next: WrssQrState) => {
    qrRef.current = next;
    setQr(next);
    if (next.expires_at && Number(next.expires_at) > 0)
      expiresAt.current = Number(next.expires_at);
    setSeconds(Math.max(0, Math.ceil(expiresAt.current - Date.now() / 1000)));
  }, []);
  const waitForNewQr = useCallback(
    async (signal: AbortSignal, oldVersion: number) => {
      for (let attempt = 0; attempt < 45; attempt++) {
        const next = await fetchQrState(baseUrl, signal);
        if (
          next.qr_code &&
          Number.isFinite(Number(next.version)) &&
          Number(next.version) > oldVersion
        ) {
          applyQr(next);
          return next;
        }
        await waitSecond(signal);
      }
      throw new Error("二维码刷新超时，请重试");
    },
    [applyQr, baseUrl],
  );
  useEffect(() => {
    if (!active) {
      operation.current?.abort();
      session.current?.abort();
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    void load(controller.signal).catch(report);
    return () => {
      controller.abort();
      session.current?.abort();
      if (operation.current === controller) operation.current = null;
    };
  }, [active, load, report]);
  useEffect(() => {
    const unauthorized = () => {
      authGeneration.current++;
      storeAuth({ login: false });
    };
    window.addEventListener("wrss:unauthorized", unauthorized);
    return () => window.removeEventListener("wrss:unauthorized", unauthorized);
  }, [storeAuth]);
  useEffect(() => {
    if (!open || !active) return;
    const controller = new AbortController();
    session.current = controller;
    expiresAt.current = 0;
    qrRef.current = null;
    setSeconds(60);
    setQr(null);
    setImage("");
    let ticks = 0;
    const poll = async () => {
      if (polling.current || renewing.current || controller.signal.aborted)
        return;
      polling.current = true;
      try {
        const next = await fetchQrState(baseUrl, controller.signal);
        applyQr(next);
        if (next.login_status) {
          storeAuth(await fetchWrssAuth(baseUrl, controller.signal));
          setOpen(false);
        }
      } catch (cause) {
        report(cause);
      } finally {
        polling.current = false;
      }
    };
    const renewSession = async () => {
      if (
        renewing.current ||
        qrRef.current?.scanned ||
        controller.signal.aborted
      )
        return;
      renewing.current = true;
      setBusy(true);
      try {
        const oldVersion = Number(qrRef.current?.version ?? 0);
        await refreshQr(baseUrl, controller.signal);
        await waitForNewQr(controller.signal, oldVersion);
        setError("");
      } catch (cause) {
        report(cause);
      } finally {
        renewing.current = false;
        setBusy(false);
      }
    };
    const start = async () => {
      setBusy(true);
      try {
        const response: any = await createQr(baseUrl, controller.signal),
          data = response?.data ?? response;
        if (data?.expires_at) expiresAt.current = Number(data.expires_at);
        await poll();
        setError("");
      } catch (cause) {
        report(cause);
      } finally {
        setBusy(false);
      }
    };
    void start();
    const timer = window.setInterval(() => {
      const ready = Boolean(qrRef.current?.qr_code && expiresAt.current);
      const left = ready
        ? Math.max(0, Math.ceil(expiresAt.current - Date.now() / 1000))
        : 60;
      setSeconds(left);
      ticks++;
      if (ticks % 2 === 0) void poll();
      if (ready && left === 0 && !qrRef.current?.scanned) void renewSession();
    }, 1000);
    return () => {
      const scanned = qrRef.current?.scanned;
      controller.abort();
      clearInterval(timer);
      polling.current = false;
      renewing.current = false;
      if (session.current === controller) session.current = null;
      if (!scanned) void closeQr(baseUrl).catch(() => {});
    };
  }, [open, active, sessionId, baseUrl, applyQr, storeAuth, report, load, waitForNewQr]);
  useEffect(() => {
    if (
      !open ||
      !active ||
      !qr?.qr_code ||
      !Number.isFinite(Number(qr.version))
    )
      return;
    const controller = new AbortController();
    let disposed = false;
    setImage("");
    fetch(qrImageUrl(baseUrl, qr.version), {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("二维码加载失败");
        return response.blob();
      })
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          }),
      )
      .then((value) => {
        if (!disposed) setImage(value);
      })
      .catch(report);
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [open, active, baseUrl, qr?.qr_code, qr?.version, report]);
  const begin = () => {
    operation.current?.abort();
    setError("");
    setOpen(true);
    setSessionId((value) => value + 1);
  };
  const manualRenew = async () => {
    const controller = session.current;
    if (!controller || qrRef.current?.scanned || renewing.current) return;
    renewing.current = true;
    setBusy(true);
    try {
      const oldVersion = Number(qrRef.current?.version ?? 0);
      await refreshQr(baseUrl, controller.signal);
      await waitForNewQr(controller.signal, oldVersion);
      setError("");
    } catch (cause) {
      report(cause);
    } finally {
      renewing.current = false;
      setBusy(false);
    }
  };
  const logout = async () => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    try {
      await logoutWechat(baseUrl);
      storeAuth({ login: false });
      setOpen(false);
    } catch (cause) {
      report(cause);
    } finally {
      if (operation.current === controller) operation.current = null;
      setBusy(false);
    }
  };
  const previewAction = async (action: "scan" | "confirm") => {
    const controller = session.current;
    if (!controller) return;
    setBusy(true);
    try {
      const next: any = await mockWrssAuth(baseUrl, action, controller.signal);
      if (action === "scan") applyQr(next);
      else {
        await load(controller.signal);
        setOpen(false);
      }
      setError("");
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="wrss-native-account">
      <header className="wrss-native-toolbar">
        <h2>微信授权</h2>
        <button
          onClick={() => {
            const controller = new AbortController();
            operation.current?.abort();
            operation.current = controller;
            setBusy(true);
            void load(controller.signal)
              .then(() => setError(""))
              .catch(report)
              .finally(() => setBusy(false));
          }}
        >
          刷新状态
        </button>
      </header>
      {error && (
        <div className="wrss-native-error" role="alert">
          {error}
          <button
            onClick={() => {
              setError("");
              if (open) setSessionId((value) => value + 1);
              else {
                const controller = new AbortController();
                operation.current?.abort();
                operation.current = controller;
                void load(controller.signal).catch(report);
              }
            }}
          >
            重试
          </button>
        </div>
      )}
      {auth === null && <div role="status">正在检查授权状态…</div>}
      {mode === "preview" && (
        <p className="wrss-preview-note">
          当前为模拟授权，不连接真实微信账号，二维码仅用于预览交互。
        </p>
      )}
      {auth?.login ? (
        <div className="wrss-account-card">
          <strong>已授权</strong>
          <p>
            {String(
              auth.info?.nickname ??
                auth.info?.name ??
                (mode === "preview" ? "模拟微信账号" : "微信账号"),
            )}
          </p>
          <button disabled={busy} onClick={() => void logout()}>
            {mode === "preview" ? "退出模拟授权" : "退出授权"}
          </button>
        </div>
      ) : (
        auth && (
          <div className="wrss-account-card">
            <strong>未授权</strong>
            <p>扫码后可同步公众号订阅与文章。</p>
            <button disabled={busy} onClick={begin}>
              {mode === "preview" ? "开始模拟授权" : "扫码授权"}
            </button>
          </div>
        )
      )}
      {open && (
        <div className="wrss-qr-dialog" role="dialog" aria-label="微信扫码授权">
          <div className="wrss-qr-frame">
            {image ? (
              <img src={image} alt="微信授权二维码" />
            ) : (
              <div className="wrss-qr-loading" role="status">
                正在生成二维码…
              </div>
            )}
            {qr?.scanned && (
              <div className="wrss-qr-scanned">已扫码，请在手机确认</div>
            )}
          </div>
          <p>{qr?.scanned ? "二维码已锁定" : `二维码剩余 ${seconds} 秒`}</p>
          {mode === "preview" && (
            <>
              <button
                disabled={busy || Boolean(qr?.scanned)}
                onClick={() => void previewAction("scan")}
              >
                模拟扫码
              </button>
              <button
                disabled={busy || !qr?.scanned}
                onClick={() => void previewAction("confirm")}
              >
                模拟确认
              </button>
            </>
          )}
          <button
            disabled={busy || qr?.scanned}
            onClick={() => void manualRenew()}
          >
            刷新二维码
          </button>
          <button onClick={() => setOpen(false)}>关闭</button>
        </div>
      )}
    </section>
  );
}
