"use client";

import { useEffect, useState } from "react";
import { UserProfileModal } from "./user-profile-modal";

/**
 * 全域使用者資料彈窗 host：在 workspace layout 掛一次，整個 workspace 共用。
 * 任何元件（chat-bubble / message-text / review queue 等）想開彈窗只要：
 *   window.dispatchEvent(new CustomEvent("switchboard:open-user-profile", { detail: { platformUserId } }))
 * 不必各自管理 state / 各自 import modal，避免到處重複的 wiring。
 */
export function UserProfileModalHost({ workspaceId }: { workspaceId: string }) {
  const [activeUserId, setActiveUserId] = useState<string | null>(null);

  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent).detail as { platformUserId?: string };
      if (detail?.platformUserId) setActiveUserId(detail.platformUserId);
    }
    window.addEventListener("switchboard:open-user-profile", handler);
    return () => window.removeEventListener("switchboard:open-user-profile", handler);
  }, []);

  if (!activeUserId) return null;
  return (
    <UserProfileModal
      workspaceId={workspaceId}
      platformUserId={activeUserId}
      onClose={() => setActiveUserId(null)}
    />
  );
}
