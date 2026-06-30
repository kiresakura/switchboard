"use client";

import { useLayoutEffect } from "react";

/**
 * 在 React 渲染前讀 localStorage 套用 dark / light 主題 class。
 *
 * 為什麼用 useLayoutEffect 而不是 useEffect：useLayoutEffect 在瀏覽器繪製前
 * 同步執行，使用者比較不會看到主題切換閃爍。
 *
 * 為什麼不用 server component 寫 <script>：Next.js 16 / React 19 對 server
 * component 渲染 <script> 標籤變嚴格，會跳警告。
 */
export function ThemeInit() {
  useLayoutEffect(() => {
    try {
      const t = localStorage.getItem("switchboard_theme");
      if (t === "dark" || t === "light") {
        const root = document.documentElement;
        // 移除另一個（避免兩個 class 並存）再加目前的
        root.classList.remove("dark", "light");
        root.classList.add(t);
      }
    } catch {
      // localStorage 不可用（隱私模式 / iframe sandbox）→ 用預設主題
    }
  }, []);

  return null;
}
