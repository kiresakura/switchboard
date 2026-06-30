"use client";

import { useEffect, useRef } from "react";

/**
 * SessionWatchdog — 全域 fetch 401 處理。
 *
 * 為什麼需要：使用者把頁面開著一段時間後，cookie 可能因為
 *   - 過絕對上限（30 天）
 *   - 帳號被 admin 停用
 *   - 從別的工作區登出（清掉 cookie）
 * 而失效。原本的行為是：頁面 SSR 時 cookie 還有效 → 渲染正常 → 但任何
 * 互動 API 都會回 401，畫面只顯示「尚未登入」這四個字、操作卡死。
 *
 * 這支元件 patch 全域 `window.fetch`，凡是呼叫 same-origin API、回應是 401
 * 且 path 不是登入相關，就自動把使用者導去 /login（並把目前的路徑保留為
 * `?redirect=`，登入後可以原路回來）。只導一次，避免無限迴圈。
 */

const LOGIN_REDIRECT_FLAG = "__switchboard_session_redirecting";

declare global {
  interface Window {
    [LOGIN_REDIRECT_FLAG]?: boolean;
  }
}

export function SessionWatchdog() {
  // ref 避免 React strict mode 雙重 patch
  const patchedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (patchedRef.current) return;
    patchedRef.current = true;

    const originalFetch = window.fetch.bind(window);

    window.fetch = async function patchedFetch(input, init) {
      const res = await originalFetch(input, init);

      // 只處理 401，且回應 URL 是 same-origin（避免攔到第三方 API）
      if (res.status !== 401) return res;

      let urlStr = "";
      try {
        urlStr =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
      } catch {
        return res;
      }

      let url: URL;
      try {
        url = new URL(urlStr, window.location.origin);
      } catch {
        return res;
      }

      // 跨 origin 不處理
      if (url.origin !== window.location.origin) return res;

      // 登入流程本身的 401 不要轉導（會循環）
      if (
        url.pathname.startsWith("/api/auth/login") ||
        url.pathname.startsWith("/api/auth/logout") ||
        url.pathname.startsWith("/login")
      ) {
        return res;
      }

      // 已經在轉導 / 正在登入頁 — 不重複觸發
      if (window[LOGIN_REDIRECT_FLAG]) return res;
      if (window.location.pathname.startsWith("/login")) return res;

      window[LOGIN_REDIRECT_FLAG] = true;

      // 把目前的位置帶回去當 redirect，登入後 LoginForm 會 push 回來
      const current = window.location.pathname + window.location.search;
      const safeRedirect = current.startsWith("/") && !current.startsWith("//") ? current : "/";
      const target = `/login?redirect=${encodeURIComponent(safeRedirect)}&reason=expired`;

      // 用 location.replace 避免在 history 留下死頁面
      window.location.replace(target);

      return res;
    } as typeof fetch;

    return () => {
      // 嚴格 cleanup 不必要 — 全域 patch 維持整個 app 生命週期
      patchedRef.current = false;
      window.fetch = originalFetch;
    };
  }, []);

  return null;
}
