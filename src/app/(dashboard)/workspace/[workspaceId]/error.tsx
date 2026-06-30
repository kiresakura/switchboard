"use client";

import { useEffect } from "react";

export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[Workspace Error]", error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-8">
      <h2 className="text-xl font-semibold text-red-600">頁面載入失敗</h2>
      <p className="text-sm text-gray-500">
        {error.message || "無法載入工作區資料，請稍後再試。"}
      </p>
      <button
        onClick={reset}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
      >
        重新載入
      </button>
    </div>
  );
}
