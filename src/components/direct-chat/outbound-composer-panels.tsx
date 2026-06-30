"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { Phone, ShieldOff } from "lucide-react";
import { cn } from "@/lib/utils";

export type OutboundNativePayload =
  { kind: "story"; peerId: string; storyId: number };

export type ComposerPanel =
  | "story"
  | "calls"
  | "secret"
  | null;

export function OutboundComposerShortcutBar({
  onOpen,
  active,
  disabled,
}: {
  onOpen: (panel: ComposerPanel) => void;
  active: ComposerPanel;
  disabled?: boolean;
}) {
  const buttons: Array<{ id: ComposerPanel; label: string; icon: ReactNode; title?: string; unsupported?: boolean }> = [
    { id: "calls", label: "通話", icon: <Phone className="h-3.5 w-3.5" />, title: "請使用對話標題列的通話按鈕" },
    { id: "secret", label: "秘密聊天（未支援）", icon: <ShieldOff className="h-3.5 w-3.5" />, title: "目前網頁客服台不支援 Telegram 秘密聊天", unsupported: true },
  ];
  return (
    <div className="flex flex-wrap gap-1 border-b border-[var(--border)]/60 px-2 py-1.5">
      {buttons.map((b) => (
        <button
          key={String(b.id)}
          type="button"
          disabled={disabled || b.unsupported}
          title={b.title ?? b.label}
          onClick={() => {
            if (b.unsupported) return;
            onOpen(active === b.id ? null : b.id);
          }}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors",
            active === b.id
              ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
              : "bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]",
            (disabled || b.unsupported) && "opacity-50 cursor-not-allowed",
          )}
        >
          {b.icon}
          {b.label}
        </button>
      ))}
    </div>
  );
}

export function OutboundComposerPanels({
  openPanel,
  onClose,
  onSubmit,
  disabled,
}: {
  openPanel: ComposerPanel;
  onClose: () => void;
  onSubmit: (payload: OutboundNativePayload) => Promise<boolean> | boolean;
  disabled?: boolean;
}) {
  const [storyPeerId, setStoryPeerId] = useState("");
  const [storyId, setStoryId] = useState("");

  const storyIdNum = Number(storyId);
  const storyValid = storyPeerId.trim().length > 0 && storyId.trim() !== "" && Number.isInteger(storyIdNum) && storyIdNum > 0;

  if (!openPanel) return null;

  const submit = async (payload: OutboundNativePayload) => {
    const ok = await onSubmit(payload);
    if (ok) onClose();
  };

  const panelClass = "border-t border-[var(--border)]/60 bg-[var(--bg-secondary)]/30 p-3 text-sm";
  const inputClass = "w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-sm outline-none focus:border-[var(--primary)]";
  const primaryClass = "rounded-md bg-[var(--primary)] px-3 py-1.5 text-sm text-[var(--primary-foreground)] disabled:opacity-50";
  const ghostClass = "rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]";

  if (openPanel === "calls" || openPanel === "secret") {
    return (
      <div className={panelClass}>
        <div className="font-medium text-[var(--text-primary)]">
          {openPanel === "calls" ? "Telegram Calls：使用標題列入口" : "Secret Chats：明確 out-of-scope"}
        </div>
        <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
          {openPanel === "calls"
            ? "內嵌通話需要 Telegram VoIP gateway。請在對話標題列使用通話按鈕。"
            : "Secret chat 需要 Telegram encrypted layer、金鑰交換、seq/no、TTL 與 encrypted file 狀態機。Switchboard 保留一般雲端對話，不保存端對端秘密聊天。"}
        </p>
        <button type="button" className={ghostClass} onClick={onClose}>關閉</button>
      </div>
    );
  }

  return (
    <div className={panelClass}>
      {openPanel === "story" && (
        <fieldset disabled={disabled} className="grid gap-2 sm:grid-cols-2 disabled:opacity-60">
          <input className={inputClass} placeholder="對象 ID / username" value={storyPeerId} onChange={(e) => setStoryPeerId(e.target.value)} />
          <input className={inputClass} placeholder="Story 編號" value={storyId} onChange={(e) => setStoryId(e.target.value)} />
          <div className="sm:col-span-2 text-xs text-[var(--text-muted)]">只支援轉發已存在、且目前 TG 帳號可存取的 Story。若對象不屬於此工作區或此帳號不可見，系統會拒絕送出。</div>
          <div className="sm:col-span-2 flex gap-2">
            <button className={primaryClass} disabled={disabled || !storyValid} onClick={() => submit({ kind: "story", peerId: storyPeerId.trim(), storyId: storyIdNum })}>{disabled ? "送出中…" : "送出 Story"}</button>
            <button className={ghostClass} onClick={onClose}>取消</button>
          </div>
        </fieldset>
      )}
    </div>
  );
}
