"use client";

/**
 * BackfillButton — 從 TG 補抓某個對話最近 N 則歷史訊息進 DirectChatMessage。
 *
 * 用途：剛綁帳號 / 之前停用過監聽 / 看不到舊對話 → 一鍵把 TG 已有的訊息
 * 拉進 Switchboard。dedup by platformMessageId，重複按不會塞重複訊息。
 */
import { useState } from "react";
import { Loader2, History } from "lucide-react";

const PRESETS = [50, 100, 200] as const;

export function BackfillButton({
  workspaceId,
  groupId,
  onDone,
}: {
  workspaceId: string;
  groupId: string;
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function backfill(limit: number) {
    setBusy(true);
    setMsg(null);
    setOpen(false);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/groups/${groupId}/backfill`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setMsg(`補抓失敗：${data.error || res.status}`);
        return;
      }
      const mediaPart =
        (data.mediaStored ?? 0) > 0 ? `、含媒體 ${data.mediaStored} 個` : "";
      const failedPart =
        (data.failed ?? 0) > 0
          ? `；${data.failed} 則寫入失敗${data.firstFailure ? `（${String(data.firstFailure).slice(0, 80)}）` : ""}`
          : "";
      setMsg(
        `已補抓 ${data.inserted ?? 0} 則新訊息${mediaPart}（跳過 ${data.skipped ?? 0} 則重複；總掃 ${data.total ?? 0} 則）${failedPart}`,
      );
      onDone?.();
    } catch (err) {
      setMsg(`網路錯誤：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      // 成功訊息 4 秒後自動清；失敗 / 部分失敗給 12 秒讓使用者看清楚診斷
      setTimeout(
        () => setMsg((cur) => (cur && /失敗/.test(cur) ? cur : null)),
        4000,
      );
      setTimeout(() => setMsg(null), 12_000);
    }
  }

  return (
    <div className="relative flex items-center gap-2">
      {msg && (
        <span className="text-xs text-[var(--muted-foreground)] max-w-[260px] truncate" title={msg}>
          {msg}
        </span>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="flex items-center gap-1 rounded-md border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--bg-secondary)] disabled:opacity-50"
        title="從 TG 補抓最近 N 則歷史訊息"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <History className="w-3.5 h-3.5" />}
        {busy ? "補抓中…" : "補抓 TG 歷史"}
      </button>
      {open && !busy && (
        <div
          className="absolute right-0 top-full z-30 mt-1 flex flex-col rounded-md border border-[var(--border)] bg-[var(--card)] py-1 shadow-md"
          onMouseLeave={() => setOpen(false)}
        >
          {PRESETS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => backfill(n)}
              className="px-3 py-1.5 text-xs text-left hover:bg-[var(--bg-secondary)] whitespace-nowrap"
            >
              抓最近 {n} 則
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
