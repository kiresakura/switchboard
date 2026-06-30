"use client";

import { useEffect, useCallback } from "react";

type SecurityProviderProps = {
  children: React.ReactNode;
};

/**
 * 全站防護：
 *   - 攔截右鍵選單（避免使用者用「另存圖片」「檢視原始碼」洩漏）
 *   - 允許文字選取 + 複製：使用者明確需要在「對話 / 審核佇列 / 公佈欄與交接」
 *     等地方圈選複製內容（2026-04-28 反饋）。安全性靠 watermark + audit log，
 *     不靠阻擋複製這種「劇場式」防護。
 */
export function SecurityProvider({ children }: SecurityProviderProps) {
  const handleContextMenu = useCallback((e: MouseEvent) => {
    e.preventDefault();
  }, []);

  useEffect(() => {
    document.addEventListener("contextmenu", handleContextMenu);
    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [handleContextMenu]);

  return <>{children}</>;
}
