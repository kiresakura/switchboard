"use client";

/**
 * AIAnalysisCard — 對話頂端的「AI 預析」收合卡(2026-05-21 Batch 3)。
 *
 * 跟 AICopilotPanel(右下角 FAB 的互動問答)互補:
 *   - 預析 = 開對話時頂端一條收合 bar,點開 → 一次性結構化 brief
 *     (摘要 / 客戶意圖 / 情緒急迫度 / 建議下一步)。
 *   - click-to-generate:不自動跑,避免每開一個對話就燒一次 API 預算。
 *   - 分析結果是 per-conversation;groupId 一換就重置。
 */

import { useEffect, useState } from "react";
import { Sparkles, ChevronDown, RefreshCw, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = { workspaceId: string; groupId: string };

export function AIAnalysisCard({ workspaceId, groupId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [error, setError] = useState("");

  // 換對話就重置 — 預析是 per-conversation,不能把上一個對話的 brief 留著
  useEffect(() => {
    setExpanded(false);
    setAnalysis(null);
    setError("");
    setLoading(false);
  }, [groupId]);

  async function runAnalysis() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/groups/${groupId}/ai/analyze`,
        { method: "POST" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "分析失敗");
        return;
      }
      setAnalysis(typeof data.analysis === "string" ? data.analysis : "");
    } catch {
      setError("網路錯誤,分析失敗");
    } finally {
      setLoading(false);
    }
  }

  function handleToggle() {
    const next = !expanded;
    setExpanded(next);
    // 第一次展開且還沒有結果 → 自動觸發一次分析
    if (next && !analysis && !loading && !error) {
      void runAnalysis();
    }
  }

  return (
    <div className="mb-3 rounded-md border border-[var(--accent)]/30 bg-[var(--accent-bg)]/30 text-xs">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Sparkles className="size-3.5 shrink-0 text-[var(--accent)]" />
        <span className="font-medium text-[var(--accent)]">AI 語意分析</span>
        <span className="truncate text-[var(--text-muted)]">
          {analysis ? "已分析這段對話" : "點此讓 AI 先幫你掃一遍這段對話"}
        </span>
        <ChevronDown
          className={cn(
            "ml-auto size-3.5 shrink-0 text-[var(--text-muted)] transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded && (
        <div className="border-t border-[var(--accent)]/20 px-3 py-2.5">
          {loading ? (
            <div className="flex items-center gap-2 text-[var(--text-muted)]">
              <Loader2 className="size-3.5 animate-spin" />
              AI 分析中…
            </div>
          ) : error ? (
            <div className="space-y-2">
              <div className="text-[var(--destructive)]">{error}</div>
              <button
                type="button"
                onClick={() => void runAnalysis()}
                className="rounded border border-[var(--border)] px-2 py-1 text-[var(--foreground)] hover:bg-[var(--bg-secondary)]"
              >
                重試
              </button>
            </div>
          ) : analysis ? (
            <div className="space-y-2">
              <div className="whitespace-pre-wrap leading-relaxed text-[var(--text-secondary)]">
                {analysis}
              </div>
              <button
                type="button"
                onClick={() => void runAnalysis()}
                className="flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--foreground)]"
              >
                <RefreshCw className="size-3" />
                重新分析
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void runAnalysis()}
              className="rounded border border-[var(--border)] px-2 py-1 text-[var(--foreground)] hover:bg-[var(--bg-secondary)]"
            >
              開始分析
            </button>
          )}
        </div>
      )}
    </div>
  );
}
