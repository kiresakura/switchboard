"use client";

import { useEffect } from "react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[Dashboard Error]", error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-8">
      <h2 className="text-xl font-semibold text-[var(--destructive)]">發生錯誤</h2>
      <p className="text-sm text-[var(--muted-foreground)]">
        {error.message || "系統發生未預期的錯誤，請稍後再試。"}
      </p>
      <button
        onClick={reset}
        className="rounded-xl bg-[var(--primary)] px-5 py-2.5 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90 transition-opacity"
      >
        重新載入
      </button>
    </div>
  );
}
