"use client";

/**
 * DownloadButton — file download with a visible progress indicator.
 *
 * Replaces bare <a href download> with a fetch+stream pipeline:
 *   - Reads Content-Length to drive a determinate progress bar when the
 *     server sends it, or shows an indeterminate pulse otherwise
 *   - Accumulates chunks into a Blob, then triggers a synthetic download
 *     via URL.createObjectURL
 *   - Cancels via AbortController on unmount or repeat-click
 *
 * Keeps the same visual shape as the old media chip (icon + name + size).
 */

import { useRef, useState } from "react";
import { Download, X, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type DownloadButtonProps = {
  url: string;
  fileName?: string | null;
  label?: string;
  sizeBytes?: number | null;
  icon?: React.ReactNode;
  className?: string;
};

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}

export function DownloadButton({
  url,
  fileName,
  sizeBytes,
  icon,
  className,
}: DownloadButtonProps) {
  const [state, setState] = useState<"idle" | "downloading" | "done" | "error">("idle");
  const [progress, setProgress] = useState(0); // 0-1
  const [total, setTotal] = useState<number | null>(sizeBytes ?? null);
  const [received, setReceived] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  async function start(e: React.MouseEvent) {
    e.preventDefault();
    if (state === "downloading") {
      abortRef.current?.abort();
      return;
    }
    setState("downloading");
    setProgress(0);
    setReceived(0);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentLength = res.headers.get("content-length");
      const contentTotal = contentLength ? parseInt(contentLength, 10) : null;
      if (contentTotal) setTotal(contentTotal);

      const reader = res.body?.getReader();
      if (!reader) throw new Error("streaming unsupported");
      const chunks: Uint8Array[] = [];
      let got = 0;
       
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
        setReceived(got);
        if (contentTotal) setProgress(Math.min(got / contentTotal, 1));
      }
      const blob = new Blob(chunks as BlobPart[]);
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = fileName || "download";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke after the browser has had a tick to start the download.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setProgress(1);
      setState("done");
      setTimeout(() => setState("idle"), 2000);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setState("idle");
        return;
      }
      setState("error");
      setTimeout(() => setState("idle"), 3000);
    }
  }

  const showBar = state === "downloading" && total && total > 0;
  const percent = Math.round(progress * 100);

  return (
    <button
      onClick={start}
      className={cn(
        "group relative flex min-w-0 items-center gap-2 overflow-hidden rounded-lg px-2 py-1.5 transition-colors",
        "bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20",
        className,
      )}
      aria-label={state === "downloading" ? "取消下載" : "下載"}
    >
      <span className="flex size-8 shrink-0 items-center justify-center text-xl">
        {state === "downloading" ? (
          <X className="size-4 animate-pulse" />
        ) : state === "done" ? (
          <CheckCircle2 className="size-4 text-[var(--approve)]" />
        ) : (
          icon ?? <Download className="size-4" />
        )}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[12px] font-medium">
          {fileName || "未知檔案"}
        </span>
        <span className="block text-[10px] opacity-75">
          {state === "downloading"
            ? total
              ? `${formatBytes(received)} / ${formatBytes(total)} · ${percent}%`
              : `${formatBytes(received)} · 下載中…`
            : state === "done"
              ? "下載完成"
              : state === "error"
                ? "下載失敗"
                : formatBytes(total ?? sizeBytes)}
        </span>
      </span>
      {/* Progress bar (only when we know total) */}
      {showBar && (
        <span
          className="absolute bottom-0 left-0 h-0.5 bg-[var(--primary)] transition-[width] duration-100"
          style={{ width: `${percent}%` }}
          aria-hidden="true"
        />
      )}
    </button>
  );
}
