"use client";

import { useEffect } from "react";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Page error:", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4 p-6">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-[var(--foreground)] mb-2">
          頁面載入發生問題
        </h2>
        <p className="text-sm text-[var(--muted-foreground)] mb-4">
          系統遇到錯誤,請嘗試重新載入。若問題持續,請聯繫管理員。
        </p>
      </div>
      <button
        onClick={reset}
        className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
      >
        重新載入
      </button>
    </div>
  );
}
