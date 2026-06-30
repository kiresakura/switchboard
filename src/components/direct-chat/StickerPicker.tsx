"use client";

/**
 * StickerPicker — 瀏覽 / 傳送 TG 貼圖。
 *
 * 流程：
 *  1. 用 accountId 呼叫 /api/.../sticker-sets → 取得用戶的貼圖包清單
 *  2. 點擊貼圖包 → 呼叫 /sticker-sets/:setId → 取得該包的 stickers 列表
 *  3. 每張貼圖的縮圖透過 POST /sticker-thumb 代理下載
 *  4. 點擊貼圖 → 呼叫 onSelect(sticker)，父層呼叫 send-sticker API
 *
 * 貼圖包資料 per-session 快取（Map），切換對話不重拉。
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, Layers } from "lucide-react";
import { cn } from "@/lib/utils";

type StickerSetMeta = {
  id: string;
  accessHash: string;
  title: string;
  shortName: string;
  count: number;
};

export type StickerInfo = {
  id: string;
  accessHash: string;
  fileReference: string;
  emoji: string;
  mimeType: string;
};

type Props = {
  workspaceId: string;
  accountId: string;
  /** 父層呼叫 send-sticker API */
  onSelect: (sticker: StickerInfo) => void;
};

// Per-session sticker set cache — 貼圖包很少更動，session 內不重抓
const setsCache = new Map<string, StickerSetMeta[]>();
const stickersCache = new Map<string, StickerInfo[]>();

export function StickerPicker({ workspaceId, accountId, onSelect }: Props) {
  const [sets, setSets] = useState<StickerSetMeta[]>([]);
  const [setsLoading, setSetsLoading] = useState(true);
  const [activeSetIdx, setActiveSetIdx] = useState(0);
  const [stickers, setStickers] = useState<StickerInfo[]>([]);
  const [stickersLoading, setStickersLoading] = useState(false);
  const cancelledRef = useRef(false);

  // 載入貼圖包清單
  useEffect(() => {
    cancelledRef.current = false;
    const cacheKey = `${workspaceId}:${accountId}`;
    const cached = setsCache.get(cacheKey);
    if (cached) {
      setSets(cached);
      setSetsLoading(false);
      return;
    }
    setSetsLoading(true);
    fetch(
      `/api/workspaces/${workspaceId}/sticker-sets?accountId=${encodeURIComponent(accountId)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelledRef.current) return;
        const list: StickerSetMeta[] = d?.sets ?? [];
        setsCache.set(cacheKey, list);
        setSets(list);
        setSetsLoading(false);
      })
      .catch(() => {
        if (!cancelledRef.current) setSetsLoading(false);
      });
    return () => {
      cancelledRef.current = true;
    };
  }, [workspaceId, accountId]);

  // 載入選中貼圖包的 stickers
  useEffect(() => {
    if (sets.length === 0) return;
    const set = sets[activeSetIdx];
    if (!set) return;
    const cacheKey = `${workspaceId}:${accountId}:${set.id}`;
    const cached = stickersCache.get(cacheKey);
    if (cached) {
      setStickers(cached);
      return;
    }
    setStickers([]);
    setStickersLoading(true);
    fetch(
      `/api/workspaces/${workspaceId}/sticker-sets/${encodeURIComponent(set.id)}` +
        `?accountId=${encodeURIComponent(accountId)}&accessHash=${encodeURIComponent(set.accessHash)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list: StickerInfo[] = d?.stickers ?? [];
        stickersCache.set(cacheKey, list);
        setStickers(list);
        setStickersLoading(false);
      })
      .catch(() => setStickersLoading(false));
  }, [workspaceId, accountId, sets, activeSetIdx]);

  if (setsLoading) {
    return (
      <div className="flex h-64 w-72 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-xl">
        <Loader2 className="size-6 animate-spin text-[var(--muted-foreground)]" />
      </div>
    );
  }

  if (sets.length === 0) {
    return (
      <div className="flex h-48 w-72 flex-col items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-xl text-sm text-[var(--muted-foreground)]">
        <Layers className="size-8 opacity-40" />
        <span>此帳號尚無貼圖包</span>
        <span className="text-xs opacity-60">請先在 Telegram 新增貼圖</span>
      </div>
    );
  }

  return (
    <div className="flex h-80 w-80 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-xl">
      {/* 貼圖包 tab — 水平捲動 */}
      <div className="flex shrink-0 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-primary)]">
        {sets.map((s, idx) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setActiveSetIdx(idx)}
            title={s.title}
            className={cn(
              "shrink-0 whitespace-nowrap px-3 py-2 text-xs transition-colors",
              activeSetIdx === idx
                ? "border-b-2 border-[var(--accent)] bg-[var(--accent-bg)] font-medium text-[var(--accent)]"
                : "text-[var(--muted-foreground)] hover:bg-[var(--bg-secondary)]",
            )}
          >
            {s.title}
          </button>
        ))}
      </div>

      {/* 貼圖格 */}
      <div className="relative flex-1 overflow-y-auto p-1">
        {stickersLoading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="size-5 animate-spin text-[var(--muted-foreground)]" />
          </div>
        ) : (
          <div className="grid grid-cols-5 gap-1">
            {stickers.map((sticker) => (
              <StickerThumb
                key={sticker.id}
                sticker={sticker}
                workspaceId={workspaceId}
                accountId={accountId}
                onClick={() => onSelect(sticker)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 單張貼圖縮圖 ─────────────────────────────────────────────────────────────

function StickerThumb({
  sticker,
  workspaceId,
  accountId,
  onClick,
}: {
  sticker: StickerInfo;
  workspaceId: string;
  accountId: string;
  onClick: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // POST /api/workspaces/:wid/sticker-thumb → 代理下載縮圖
    fetch(`/api/workspaces/${workspaceId}/sticker-thumb`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId,
        docId: sticker.id,
        accessHash: sticker.accessHash,
        fileReference: sticker.fileReference,
      }),
    })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (cancelled || !blob) return;
        setSrc(URL.createObjectURL(blob));
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, accountId, sticker.id, sticker.accessHash, sticker.fileReference]);

  return (
    <button
      type="button"
      onClick={onClick}
      title={sticker.emoji}
      className="relative flex aspect-square items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-secondary)]"
    >
      {loading ? (
        <div className="size-10 animate-pulse rounded bg-[var(--bg-secondary)]" />
      ) : src ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={src}
          alt={sticker.emoji}
          className="size-12 object-contain p-0.5"
          loading="lazy"
        />
      ) : (
        <span className="text-xl">{sticker.emoji}</span>
      )}
    </button>
  );
}
