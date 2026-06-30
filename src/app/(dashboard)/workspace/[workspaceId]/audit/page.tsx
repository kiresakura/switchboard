"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter, useSearchParams, usePathname } from "next/navigation";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { formatAuditAction, sortActionsByLabel } from "@/lib/audit/action-labels";
import { PageHeader } from "@/components/ui/section";

type AuditEntry = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown> | null;
  createdAt: string;
  user: { displayName: string; username: string } | null;
};

function DetailViewer({ details }: { details: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-1.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-[var(--primary)] hover:underline"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {expanded ? "隱藏詳細" : "查看詳細"}
      </button>
      {expanded && (
        <pre className="mt-1.5 overflow-x-auto rounded-md bg-[var(--muted)] p-2 text-[11px] leading-relaxed text-[var(--muted-foreground)]">
          {JSON.stringify(details, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function AuditLogPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState("");

  // Filters derived from URL
  const page = parseInt(searchParams.get("page") || "1", 10);
  const actionFilter = searchParams.get("action") || "";
  const searchQuery = searchParams.get("q") || "";

  const setQueryParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    // Reset to page 1 when filter changes
    params.delete("page");
    router.push(`${pathname}?${params.toString()}`);
  };

  const setPage = (p: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(p));
    router.push(`${pathname}?${params.toString()}`);
  };

  const fetchLogs = useCallback(
    async (p: number) => {
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({ page: String(p), limit: "30" });
        if (actionFilter) params.set("action", actionFilter);
        if (searchQuery) params.set("q", searchQuery);

        const res = await fetch(
          `/api/workspaces/${workspaceId}/audit?${params.toString()}`
        );
        if (res.ok) {
          const data = await res.json();
          setLogs(data.logs);
          setTotalPages(data.pagination.totalPages);
        } else {
          setError("載入稽核紀錄失敗");
        }
      } catch {
        setError("網路錯誤");
      }
      setLoading(false);
    },
    [workspaceId, actionFilter, searchQuery]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchLogs(page);
  }, [fetchLogs, page]);

  // Collect unique actions from current logs for filter dropdown (sorted by Chinese label)
  const uniqueActions = sortActionsByLabel([
    ...new Set(logs.map((l) => l.action)),
  ]);

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader
        title="操作紀錄"
        description="檢視工作空間的系統操作與稽核日誌"
      />

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <input
            type="text"
            placeholder="搜尋操作者..."
            value={searchQuery}
            onChange={(e) => setQueryParam("q", e.target.value)}
            className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] py-1.5 pl-7 pr-3 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
          />
        </div>
        <select
          value={actionFilter}
          onChange={(e) => setQueryParam("action", e.target.value)}
          className="rounded-md border border-[var(--input)] bg-[var(--background)] px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
        >
          <option value="">所有操作</option>
          {uniqueActions.map((a) => (
            <option key={a} value={a}>
              {formatAuditAction(a)}
            </option>
          ))}
        </select>
        {(actionFilter || searchQuery) && (
          <button
            onClick={() => {
              const params = new URLSearchParams(searchParams.toString());
              params.delete("action");
              params.delete("q");
              params.delete("page");
              router.push(`${pathname}?${params.toString()}`);
            }}
            className="text-xs text-[var(--primary)] hover:underline"
          >
            清除篩選
          </button>
        )}
      </div>

      {error && (
        <p className="mb-4 text-sm text-[var(--destructive)]">{error}</p>
      )}

      {loading ? (
        <div className="text-sm text-[var(--muted-foreground)]">載入中...</div>
      ) : logs.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)]">
          {actionFilter || searchQuery ? "沒有符合條件的紀錄。" : "尚無紀錄。"}
        </p>
      ) : (
        <>
          <div className="space-y-2">
            {logs.map((log) => (
              <div
                key={log.id}
                className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-3"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium">{formatAuditAction(log.action)}</span>
                    <span
                      className="ml-2 text-xs text-[var(--muted-foreground)]"
                      title={log.action}
                    >
                      {log.entityType}
                    </span>
                  </div>
                  <span className="text-xs text-[var(--muted-foreground)]">
                    {new Date(log.createdAt).toLocaleString("zh-Hant")}
                  </span>
                </div>
                <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                  {log.user?.displayName || "System"} ({log.user?.username || "-"})
                </div>
                {log.details && Object.keys(log.details).length > 0 && (
                  <DetailViewer details={log.details} />
                )}
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
                className="rounded border border-[var(--border)] px-3 py-1 text-sm disabled:opacity-50"
              >
                上一頁
              </button>
              <span className="text-sm text-[var(--muted-foreground)]">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page === totalPages}
                className="rounded border border-[var(--border)] px-3 py-1 text-sm disabled:opacity-50"
              >
                下一頁
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}