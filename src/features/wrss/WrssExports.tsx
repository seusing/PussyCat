import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { GlassSelect } from "../../components/GlassMenu";
import {
  deleteExport,
  exportArticles,
  exportDownloadUrl,
  fetchExportRecords,
  fetchWrssSources,
  type WrssExportRecord,
  type WrssSource,
} from "./wrssClient";
import { saveWrssBlob } from "./wrssExternal";

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export default function WrssExports({
  baseUrl,
  onError,
  active = true,
  selectedIds = [],
}: {
  baseUrl?: string;
  onError?: (error: unknown) => void;
  active?: boolean;
  selectedIds?: string[];
}) {
  const [records, setRecords] = useState<WrssExportRecord[]>([]),
    [loading, setLoading] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [scope, setScope] = useState<"latest" | "source" | "selected">(
      selectedIds.length ? "selected" : "latest",
    ),
    [sourceId, setSourceId] = useState(""),
    [recordMpId, setRecordMpId] = useState(""),
    [sources, setSources] = useState<WrssSource[]>([]),
    [sourcePage, setSourcePage] = useState(1),
    [sourceTotal, setSourceTotal] = useState(0),
    [formats, setFormats] = useState({
      md: true,
      docx: false,
      json: false,
      csv: false,
      pdf: false,
    });
  const retry = useRef<null | (() => Promise<void>)>(null),
    requestId = useRef(0);
  useEffect(() => {
    if (selectedIds.length) setScope("selected");
  }, [selectedIds]);
  const fail = useCallback(
    (cause: unknown, fallback: string, operation: () => Promise<void>) => {
      setError(errorText(cause, fallback));
      retry.current = operation;
      onError?.(cause);
    },
    [onError],
  );
  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const next = await fetchExportRecords(baseUrl, recordMpId);
      if (id !== requestId.current) return;
      setRecords(next);
      setError("");
      retry.current = null;
    } catch (cause) {
      if (id === requestId.current) fail(cause, "加载失败", load);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [baseUrl, fail, recordMpId]);
  const loadSources = useCallback(
    async (page: number) => {
      try {
        const result = await fetchWrssSources(baseUrl, "", page, 20);
        setSources((current) =>
          page === 1
            ? result.list
            : [
                ...current,
                ...result.list.filter(
                  (next) => !current.some((item) => item.id === next.id),
                ),
              ],
        );
        setSourcePage(page);
        setSourceTotal(result.total);
        if (!sourceId && result.list[0]) setSourceId(result.list[0].id);
      } catch (cause) {
        fail(cause, "来源加载失败", () => loadSources(page));
      }
    },
    [baseUrl, fail, sourceId],
  );
  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  useEffect(() => {
    if (active && scope === "source" && sources.length === 0)
      void loadSources(1);
  }, [active, loadSources, scope, sources.length]);
  const run = async () => {
    setLoading(true);
    try {
      await exportArticles(baseUrl, {
        mp_id: scope === "source" ? sourceId : "",
        doc_id: scope === "selected" ? selectedIds : [],
        page_size: 10,
        page_count: 1,
        add_title: true,
        remove_images: false,
        remove_links: false,
        export_md: formats.md,
        export_docx: formats.docx,
        export_json: formats.json,
        export_csv: formats.csv,
        export_pdf: formats.pdf,
        zip_filename: "",
      });
      setMessage("导出任务已创建，请稍后刷新记录");
      setError("");
      retry.current = null;
    } catch (cause) {
      fail(cause, "导出失败", run);
    } finally {
      setLoading(false);
    }
  };
  const download = async (record: WrssExportRecord) => {
    try {
      const response = await fetch(
        exportDownloadUrl(baseUrl, recordMpId, record.path ?? record.filename),
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error("下载失败");
      await saveWrssBlob(record.filename, await response.blob());
      setError("");
      retry.current = null;
    } catch (cause) {
      fail(cause, "下载失败", () => download(record));
    }
  };
  const remove = async (record: WrssExportRecord) => {
    if (!window.confirm(`确认删除 ${record.filename}？`)) return;
    try {
      await deleteExport(baseUrl, recordMpId, record.path ?? record.filename);
      setRecords((current) => current.filter((item) => item !== record));
      setMessage("导出记录已删除");
      setError("");
      retry.current = null;
    } catch (cause) {
      fail(cause, "删除失败", () => remove(record));
    }
  };
  return (
    <section className="wrss-native-exports">
      <header className="wrss-native-toolbar">
        <h2>导出</h2>
        <GlassSelect
          aria-label="导出范围"
          value={scope}
          onChange={(value) => setScope(value as typeof scope)}
          options={[
            { value: "latest", label: "最新文章" },
            { value: "source", label: "指定来源" },
            { value: "selected", label: `选中文章（${selectedIds.length}）`, disabled: selectedIds.length === 0 },
          ]}
        />
        {scope === "source" && (
          <>
            <GlassSelect
              aria-label="选择公众号"
              value={sourceId}
              onChange={setSourceId}
              options={sources.map((source) => ({ value: source.id, label: source.name }))}
            />
            {sources.length < sourceTotal && (
              <button onClick={() => void loadSources(sourcePage + 1)}>
                加载更多来源
              </button>
            )}
          </>
        )}
        {Object.entries(formats).map(([name, checked]) => (
          <label key={name}>
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) =>
                setFormats((value) => ({
                  ...value,
                  [name]: event.target.checked,
                }))
              }
            />
            {name.toUpperCase()}
          </label>
        ))}
        <button
          disabled={
            loading ||
            !Object.values(formats).some(Boolean) ||
            (scope === "selected" && !selectedIds.length) ||
            (scope === "source" && !sourceId)
          }
          onClick={() => void run()}
        >
          创建导出
        </button>
      </header>
      <div className="wrss-native-toolbar">
        <label>
          记录范围{" "}
          <GlassSelect
            aria-label="导出记录公众号"
            value={recordMpId}
            onChange={setRecordMpId}
            options={[{ value: "", label: "全部公众号" }, ...sources.map((source) => ({ value: source.id, label: source.name }))]}
          />
        </label>
        <button disabled={loading} onClick={() => void load()}>
          刷新记录
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      {error && (
        <div role="alert" className="wrss-native-error">
          {error}
          <button onClick={() => void retry.current?.()}>重试</button>
        </div>
      )}
      {!loading && !error && records.length === 0 ? (
        <EmptyState
          icon="⇩"
          title="暂无导出记录"
          description="创建导出后可在此下载"
        />
      ) : (
        <div className="wrss-export-list">
          {records.map((record) => (
            <article key={`${record.path ?? ""}:${record.filename}`}>
              <div>
                <strong>{record.filename}</strong>
                <small>
                  {record.created_time
                    ? new Date(record.created_time).toLocaleString("zh-CN")
                    : ""}
                </small>
              </div>
              <button onClick={() => void download(record)}>下载</button>
              <button onClick={() => void remove(record)}>删除</button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
