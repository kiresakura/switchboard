"use client";

import { useEffect } from "react";

const COOKIE_NAME = "switchboard_last_workspace";
const MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 天

/**
 * 在使用者進入工作空間頁面時，把 workspaceId 寫入 cookie。
 *
 * 為什麼用 client component：Next.js 16 規定 cookie 只能在 Server Action 或
 * Route Handler 修改，layout (Server Component) 不能寫 cookie。所以改用這個小
 * client component 在掛載時 (mount) 透過 document.cookie 寫入。
 *
 * 這個 cookie 的用途是：之後使用者點「全域系統設定」進入 /admin 時，admin
 * layout 讀這個 cookie 來決定要不要繼續顯示 workspace sidebar 樣式。純 UI
 * 紀錄，不是安全憑證 — 後端仍以 session 為準。
 */
export function LastWorkspaceCookieSetter({ workspaceId }: { workspaceId: string }) {
  useEffect(() => {
    // 只在值不同時才寫，避免每次 render 都動 cookie
    const current = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${COOKIE_NAME}=`))
      ?.split("=")[1];
    if (current === workspaceId) return;
    document.cookie = `${COOKIE_NAME}=${workspaceId}; path=/; max-age=${MAX_AGE_SEC}; SameSite=Lax`;
  }, [workspaceId]);

  return null;
}
