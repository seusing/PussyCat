import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { motion } from "motion/react";
import WrssArticleList from "./WrssArticleList";
import WrssSourceDeck from "./WrssSourceDeck";
import WrssAuthorization from "./WrssAuthorization";
import WrssExports from "./WrssExports";
import WrssMore from "./WrssMore";
import WrssGooeyNav from "./WrssGooeyNav";
import { useWrssSyncManager } from "./useWrssSyncManager";
import {
  clearWrssCache,
  fetchWrssAuth,
  type WrssAuthState,
  type WrssView,
} from "./wrssClient";
import "./WrssWorkspace.css";

const order = (view: WrssView) =>
  view.startsWith("account:")
    ? 3
    : view === "latest"
      ? 0
      : view === "favorites"
        ? 1
        : view === "sources"
          ? 2
          : view === "authorization"
            ? 4
            : 5;

export default function WrssWorkspace({
  baseUrl,
  mode = "real",
  active = true,
}: {
  baseUrl?: string;
  mode?: "preview" | "real";
  active?: boolean;
}) {
  const [view, setView] = useState<WrssView>("latest"),
    [visited, setVisited] = useState<Set<WrssView>>(() => new Set(["latest"])),
    [auth, setAuth] = useState<WrssAuthState | null>(null),
    [authError, setAuthError] = useState(""),
    [authCheckToken, setAuthCheckToken] = useState(0),
    [authSession, setAuthSession] = useState(0),
    [refreshToken, setRefreshToken] = useState(0),
    [addToken, setAddToken] = useState(0),
    [selectedExportIds, setSelectedExportIds] = useState<string[]>([]),
    [accountNames, setAccountNames] = useState<Record<string, string>>({}),
    [previousView, setPreviousView] = useState<WrssView | null>(null),
    [direction, setDirection] = useState(1),
    [reduceMotion, setReduceMotion] = useState(() =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    );
  const panes = useRef(new Map<string, HTMLDivElement>()),
    transitionTimer = useRef<number | null>(null),
    authGeneration = useRef(0),
    authRef = useRef<WrssAuthState | null>(null),
    viewRef = useRef<WrssView>("latest"),
    autoSyncAttempt = useRef(false);
  const syncManager = useWrssSyncManager(baseUrl, active && auth?.login === true, authSession, () => {
    clearWrssCache();
    setRefreshToken((value) => value + 1);
  });
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const change = () => {
      setReduceMotion(query.matches);
      if (query.matches) {
        if (transitionTimer.current !== null)
          window.clearTimeout(transitionTimer.current);
        transitionTimer.current = null;
        setPreviousView(null);
      }
    };
    change();
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const applyAuth = useCallback((next: WrssAuthState) => {
    const previous = authRef.current;
    authGeneration.current++;
    authRef.current = next;
    if (!next.login) {
      if (previous?.login) setAuthSession((value) => value + 1);
      clearWrssCache();
      autoSyncAttempt.current = false;
      const lostSession = previous?.login === true;
      const currentView = viewRef.current;
      const retained = new Set<WrssView>(["latest"]);
      if (!lostSession && ["authorization", "exports"].includes(currentView))
        retained.add(currentView);
      setVisited(retained);
      if (lostSession) {
        viewRef.current = "latest";
        setView("latest");
      }
      setPreviousView(null);
      setAccountNames({});
      setSelectedExportIds([]);
      setAddToken(0);
      setRefreshToken((value) => value + 1);
    } else if (!previous?.login) {
      setAuthSession((value) => value + 1);
      clearWrssCache();
      autoSyncAttempt.current = false;
      setVisited(new Set(["latest"]));
      viewRef.current = "latest";
      setView("latest");
      setPreviousView(null);
      setRefreshToken((value) => value + 1);
    }
    setAuth(next);
    setAuthError("");
  }, []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const generation = ++authGeneration.current;
    fetchWrssAuth(baseUrl, controller.signal)
      .then((next) => {
        if (generation !== authGeneration.current) return;
        applyAuth(next);
        setAuthError("");
      })
      .catch((error) => {
        if (
          generation === authGeneration.current &&
          !controller.signal.aborted &&
          (error as Error).name !== "AbortError"
        )
          setAuthError(
            error instanceof Error ? error.message : "授权状态加载失败",
          );
      });
    return () => controller.abort();
  }, [active, applyAuth, authCheckToken, baseUrl]);
  useEffect(() => {
    const unauthorized = () => {
      applyAuth({ login: false });
    };
    window.addEventListener("wrss:unauthorized", unauthorized);
    return () => window.removeEventListener("wrss:unauthorized", unauthorized);
  }, [applyAuth]);
  useEffect(
    () => () => {
      if (transitionTimer.current !== null)
        window.clearTimeout(transitionTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!active) {
      if (transitionTimer.current !== null)
        window.clearTimeout(transitionTimer.current);
      transitionTimer.current = null;
    }
  }, [active]);
  const open = useCallback(
    (next: WrssView) => {
      if (next === view) return;
      const nextDirection = order(next) >= order(view) ? 1 : -1;
      setDirection(nextDirection);
      setPreviousView(view);
      viewRef.current = next;
      setVisited((current) => new Set(current).add(next));
      setView(next);
      if (
        ["authorization", "exports"].includes(next) ||
        ["authorization", "exports"].includes(view)
      )
        return setPreviousView(null);
      if (transitionTimer.current !== null)
        window.clearTimeout(transitionTimer.current);
      if (reduceMotion) setPreviousView(null);
      else
        transitionTimer.current = window.setTimeout(() => {
          setPreviousView(null);
          transitionTimer.current = null;
        }, 320);
    },
    [reduceMotion, view],
  );
  const refreshAll = () => {
    clearWrssCache();
    setAuthCheckToken((value) => value + 1);
    setRefreshToken((value) => value + 1);
  };
  const openSource = (id: string, name: string) => {
    setAccountNames((current) => ({ ...current, [id]: name }));
    open(`account:${id}`);
  };
  const openAdd = () => {
    setAddToken((value) => value + 1);
    open("sources");
  };
  const exportSelected = (ids: string[]) => {
    setSelectedExportIds(ids);
    open("exports");
  };
  const pane = (name: WrssView, content: ReactNode) => {
    const animated = !["authorization", "exports"].includes(name);
    return visited.has(name) ? (
      <motion.div
        key={name}
        ref={(node) => {
          if (node) {
            panes.current.set(name, node);
            node.toggleAttribute("inert", view !== name);
          }
          else panes.current.delete(name);
        }}
        className={`wrss-view-pane${view === name ? " is-active" : ""}${previousView === name ? " is-leaving" : ""}`}
        aria-hidden={view !== name}
        initial={
          animated && !reduceMotion && !(name === "latest" && visited.size === 1)
            ? { opacity: 0, x: direction * 32 }
            : false
        }
        animate={
          reduceMotion
            ? { opacity: 1, x: 0 }
            : view === name
              ? { opacity: 1, x: 0 }
              : previousView === name
                ? { opacity: 0, x: -direction * 32 }
                : { opacity: 0, x: order(name) > order(view) ? 32 : -32 }
        }
        transition={{ duration: reduceMotion || !animated ? 0 : 0.32, ease: [0.32, 0.72, 0, 1] }}
      >
        {content}
      </motion.div>
    ) : null;
  };
  return (
    <div className="wrss-native" data-testid="wrss-native" data-mode={mode}>
      <div className="wrss-native-top">
        <div className="wrss-native-title">
          <strong>公众号</strong>
          <span className="wrss-native-mode">
            {mode === "preview" ? "预览数据" : "真实数据"}
          </span>
          <span>
            {auth === null
              ? " · 检查授权中"
              : auth.login
                ? " · 已授权"
                : " · 未授权"}
          </span>
        </div>
        <WrssGooeyNav view={view} onChange={open} reduced={reduceMotion} />
        <WrssMore
          baseUrl={baseUrl}
          mode={mode}
          auth={auth}
          onNavigate={open}
          onAddSource={openAdd}
          activeView={view}
          onAuthChange={applyAuth}
          onRefresh={refreshAll}
        />
      </div>
      {authError && (
        <div className="wrss-native-error" role="alert">
          {authError}
          <button onClick={() => setAuthCheckToken((value) => value + 1)}>
            重试授权状态
          </button>
        </div>
      )}
      <div className="wrss-native-view">
        {auth === null && !authError && view !== "authorization" && view !== "exports" && (
          <div className="wrss-native-loading" role="status">正在校验微信授权…</div>
        )}
        {auth !== null && !auth.login && view !== "authorization" && view !== "exports" && (
          <section className="wrss-unauthorized" data-testid="wrss-unauthorized">
            <strong>尚未授权微信公众号</strong>
            <span>完成微信授权后，这里会显示最新文章、收藏和已订阅公众号。</span>
            <button type="button" onClick={() => open("authorization")}>去授权</button>
          </section>
        )}
        {auth?.login && (
          <>
        {pane(
          "latest",
          <WrssArticleList
            baseUrl={baseUrl}
            view="latest"
            active={active && view === "latest"}
            onExportSelected={exportSelected}
            refreshToken={refreshToken}
            autoSyncAttempt={autoSyncAttempt as MutableRefObject<boolean>}
            syncManager={syncManager}
          />,
        )}
        {pane(
          "favorites",
          <WrssArticleList
            baseUrl={baseUrl}
            view="favorites"
            active={active && view === "favorites"}
            onExportSelected={exportSelected}
            refreshToken={refreshToken}
            syncManager={syncManager}
          />,
        )}
        {pane(
          "sources",
          <WrssSourceDeck
            baseUrl={baseUrl}
            active={active && view === "sources"}
            onOpen={openSource}
            refreshToken={refreshToken}
            addToken={addToken}
            syncManager={syncManager}
          />,
        )}
        {pane(
          "authorization",
          <WrssAuthorization
            baseUrl={baseUrl}
            mode={mode}
            active={active && view === "authorization"}
            initialAuth={auth}
            onAuthChange={applyAuth}
          />,
        )}
        {pane(
          "exports",
          <WrssExports
            baseUrl={baseUrl}
            active={active && view === "exports"}
            selectedIds={selectedExportIds}
          />,
        )}
        {[...visited]
          .filter((item) => item.startsWith("account:"))
          .map((account) => {
            const id = account.slice(8);
            return pane(
              account,
              <WrssArticleList
                baseUrl={baseUrl}
                view={account}
                title={accountNames[id] || id}
                active={active && view === account}
                onBack={() => open("sources")}
                onExportSelected={exportSelected}
                refreshToken={refreshToken}
                syncManager={syncManager}
              />,
            );
          })}
          </>
        )}
        {!auth?.login && pane(
          "authorization",
          <WrssAuthorization
            baseUrl={baseUrl}
            mode={mode}
            active={active && view === "authorization"}
            initialAuth={auth}
            onAuthChange={applyAuth}
          />,
        )}
        {!auth?.login && view === "exports" && pane(
          "exports",
          <WrssExports baseUrl={baseUrl} active={active} selectedIds={[]} />,
        )}
      </div>
    </div>
  );
}
