"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Bug, Copy, Check, X, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getRecentClientErrors,
  installClientErrorCollector,
} from "@/lib/client-errors";

type Props = {
  userName: string;
  workspaceId?: string;
  workspaceName?: string;
  userRoles?: string[];
  collapsed?: boolean;
};

export function ErrorReportButton({
  userName,
  workspaceId,
  workspaceName,
  userRoles,
  collapsed,
}: Props) {
  const [open, setOpen] = useState(false);

  // Install the window error listeners once — any JS errors that happen
  // before the user opens the dialog are captured from this point on.
  useEffect(() => {
    installClientErrorCollector();
  }, []);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-[var(--muted-foreground)] hover:bg-[var(--bg-secondary)]",
          collapsed && "justify-center",
        )}
        title={collapsed ? "系統異常回報" : undefined}
      >
        <Bug size={14} className="shrink-0" />
        {!collapsed && "異常回報"}
      </button>
      {open && (
        <ErrorReportDialog
          userName={userName}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          userRoles={userRoles}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ErrorReportDialog({
  userName,
  workspaceId,
  workspaceName,
  userRoles,
  onClose,
}: Omit<Props, "collapsed"> & { onClose: () => void }) {
  const pathname = usePathname();
  const [description, setDescription] = useState("");
  const [copied, setCopied] = useState(false);
  // Snapshot the errors once so re-renders while typing don't reshuffle.
  const snapshotRef = useRef<ReturnType<typeof getRecentClientErrors> | null>(null);
  if (snapshotRef.current === null) {
    snapshotRef.current = getRecentClientErrors();
  }
  const errors = snapshotRef.current;

  // ESC to close, lock body scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const report = useMemo(() => {
    const viewport =
      typeof window !== "undefined"
        ? `${window.innerWidth}x${window.innerHeight}`
        : "—";
    const screen =
      typeof window !== "undefined" && window.screen
        ? `${window.screen.width}x${window.screen.height}`
        : "—";
    const url = typeof window !== "undefined" ? window.location.href : "—";
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "—";
    const lang = typeof navigator !== "undefined" ? navigator.language : "—";
    const tz =
      typeof Intl !== "undefined"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : "—";
    const online = typeof navigator !== "undefined" ? navigator.onLine : true;

    const errorBlock = errors.length === 0
      ? "（無攔截到的 JS 錯誤）"
      : errors
          .map((e, i) => {
            const parts = [
              `${i + 1}. [${e.timestamp}] ${e.message}`,
              e.source ? `   位置：${e.source}` : null,
              e.stack ? "   Stack:\n```\n" + e.stack + "\n```" : null,
            ].filter(Boolean);
            return parts.join("\n");
          })
          .join("\n\n");

    return [
      "# 系統異常回報",
      "",
      "## 使用者描述",
      description.trim() || "（未填寫）",
      "",
      "## 環境資訊",
      `- 回報時間：${new Date().toISOString()}`,
      `- 頁面路徑：${pathname ?? "—"}`,
      `- 完整 URL：${url}`,
      `- 工作區：${workspaceName ?? "—"} (${workspaceId ?? "—"})`,
      `- 使用者：${userName}${userRoles?.length ? ` · 身份：${userRoles.join(", ")}` : ""}`,
      `- 視窗：${viewport}（螢幕 ${screen}）`,
      `- 語言 / 時區：${lang} / ${tz}`,
      `- 連線狀態：${online ? "online" : "offline"}`,
      `- 瀏覽器：${ua}`,
      "",
      "## 最近 JS 錯誤（最多 10 筆）",
      errorBlock,
    ].join("\n");
  }, [description, pathname, workspaceId, workspaceName, userName, userRoles, errors]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be unavailable on insecure contexts — fall back to select.
      const ta = document.createElement("textarea");
      ta.value = report;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  const handleDownload = () => {
    const blob = new Blob([report], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `switchboard-error-report-${stamp}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-[var(--border)] p-4">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Bug size={18} className="text-orange-500" />
              系統異常回報
            </h2>
            <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
              將下方清單複製給開發團隊 — 省去來回追問環境。本工具不會自動送出任何資料。
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-2 md:p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-secondary)]"
            aria-label="關閉"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <div>
            <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
              問題描述（越具體越好）
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              autoFocus
              placeholder="例：我在審核佇列點放行後，訊息仍顯示待審；重試 2 次無效。"
              className="w-full resize-y rounded border border-[var(--input)] bg-[var(--background)] px-2 py-1.5 text-sm outline-none focus:border-[var(--primary)]"
              maxLength={2000}
            />
            <div className="mt-0.5 text-right text-[10px] text-[var(--muted-foreground)]">
              {description.length} / 2000
            </div>
          </div>

          <details className="rounded border border-[var(--border)] p-2 text-xs">
            <summary className="cursor-pointer font-medium text-[var(--foreground)]">
              預覽完整回報（
              {errors.length > 0 ? `${errors.length} 筆錯誤已附上` : "無攔截錯誤"}
              ）
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-[11px] leading-snug text-[var(--muted-foreground)]">
              {report}
            </pre>
          </details>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] bg-[var(--muted)] p-3">
          <span className="text-[10px] text-[var(--muted-foreground)]">
            包含 URL、瀏覽器、視窗、JS 錯誤等；不含密碼或 session
          </span>
          <div className="flex gap-2">
            <button
              onClick={handleDownload}
              className="inline-flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs hover:bg-[var(--bg-secondary)]"
            >
              <Download size={13} />
              下載 .md
            </button>
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1 rounded bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              {copied ? (
                <>
                  <Check size={13} />
                  已複製
                </>
              ) : (
                <>
                  <Copy size={13} />
                  複製回報
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
