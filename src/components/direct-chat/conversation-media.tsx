"use client";

/**
 * ConversationMedia — TG 個人檔案的「共享媒體」分頁(Phase 2)。
 *
 * 四個分頁,各打 chat/search?filter=...(該 route 支援 query-less 純 filter
 * 模式 —— 其註解明寫「對應 UI:右側面板媒體 / 文件 / 連結分頁」,專為此而生):
 *   媒體  filter=photo,video   縮圖格狀(?w=200 即時縮圖;影片用 <video>)
 *   檔案  filter=document      檔名列表,點擊在新分頁開啟
 *   連結  filter=url           內含連結的訊息,從 content 抽出 URL
 *   語音  filter=voice,audio   內嵌 <audio> 播放器(preload=none)
 *
 * 內容區自帶 max-height + 捲動,避免把整個對話資訊面板撐過長。
 * 父層 ConversationPanel 以 key={groupId} remount → 換對話時本元件自然重置。
 */

import { useEffect, useState } from "react";
import {
  Image as ImageIcon,
  FileText,
  Link2,
  Mic,
  Play,
  type LucideIcon,
} from "lucide-react";
import { cn, mediaThumbUrl } from "@/lib/utils";
import { openLightbox } from "@/components/chat/image-lightbox";

type MediaItem = {
  id: string;
  content: string;
  timestamp: string;
  messageType: string;
  mediaUrl: string | null;
  mediaType: string | null;
  mediaFileName: string | null;
};

type TabKey = "media" | "files" | "links" | "voice";

const TABS: { key: TabKey; label: string; Icon: LucideIcon; filter: string }[] =
  [
    { key: "media", label: "媒體", Icon: ImageIcon, filter: "photo,video" },
    { key: "files", label: "檔案", Icon: FileText, filter: "document" },
    { key: "links", label: "連結", Icon: Link2, filter: "url" },
    { key: "voice", label: "語音", Icon: Mic, filter: "voice,audio" },
  ];

const EMPTY: Record<TabKey, string> = {
  media: "尚無媒體",
  files: "尚無檔案",
  links: "尚無連結",
  voice: "尚無語音訊息",
};

// 從訊息內文抽 URL。route 的 filter=url 已先用「content 含 http(s)://」粗篩。
const URL_RE = /https?:\/\/[^\s<>"`]+/gi;

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function ConversationMedia({
  workspaceId,
  groupId,
}: {
  workspaceId: string;
  groupId: string;
}) {
  const [tab, setTab] = useState<TabKey>("media");
  // per-tab 快取;undefined = 尚未抓過(= 載入中)。
  const [cache, setCache] = useState<Partial<Record<TabKey, MediaItem[]>>>({});

  useEffect(() => {
    if (cache[tab] !== undefined) return; // 此分頁已抓過
    const filter = TABS.find((t) => t.key === tab)!.filter;
    let cancelled = false;
    fetch(
      `/api/workspaces/${workspaceId}/groups/${groupId}/chat/search?filter=${encodeURIComponent(
        filter,
      )}&limit=60`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        const matches: MediaItem[] = Array.isArray(d?.matches)
          ? d.matches
          : [];
        setCache((prev) => ({ ...prev, [tab]: matches }));
      })
      .catch(() => {
        // 失敗也寫入空陣列 → 顯示空狀態而非卡在「載入中」。
        if (!cancelled) setCache((prev) => ({ ...prev, [tab]: [] }));
      });
    return () => {
      cancelled = true;
    };
  }, [tab, workspaceId, groupId, cache]);

  const items = cache[tab];

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)]">
      {/* 分頁列 */}
      <div className="flex border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1 py-2 text-xs transition-colors",
              tab === t.key
                ? "border-b-2 border-[var(--primary)] font-medium text-[var(--primary)]"
                : "border-b-2 border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
            )}
          >
            <t.Icon className="size-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {/* 內容 */}
      <div className="max-h-[360px] overflow-y-auto p-2">
        {items === undefined ? (
          <div className="py-6 text-center text-xs text-[var(--muted-foreground)]">
            載入中…
          </div>
        ) : items.length === 0 ? (
          <div className="py-6 text-center text-xs text-[var(--muted-foreground)]">
            {EMPTY[tab]}
          </div>
        ) : tab === "media" ? (
          <MediaGrid items={items} />
        ) : tab === "files" ? (
          <FileList items={items} />
        ) : tab === "links" ? (
          <LinkList items={items} />
        ) : (
          <VoiceList items={items} />
        )}
      </div>
    </div>
  );
}

function MediaGrid({ items }: { items: MediaItem[] }) {
  const media = items.filter((m) => m.mediaUrl);
  if (media.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-[var(--muted-foreground)]">
        尚無媒體
      </div>
    );
  }
  return (
    <div className="grid grid-cols-3 gap-1">
      {media.map((m) => {
        const isVideo =
          m.messageType === "VIDEO" || m.messageType === "VIDEO_NOTE";
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              if (isVideo) {
                window.open(m.mediaUrl!, "_blank", "noopener");
              } else {
                openLightbox({
                  src: m.mediaUrl!,
                  alt: undefined,
                  fileName: m.mediaFileName,
                });
              }
            }}
            className="relative aspect-square overflow-hidden rounded bg-black/5"
            title={isVideo ? "開啟影片" : "檢視圖片"}
          >
            {isVideo ? (
              <>
                <video
                  src={m.mediaUrl!}
                  preload="metadata"
                  className="size-full object-cover"
                />
                <span className="absolute inset-0 flex items-center justify-center bg-black/30">
                  <Play className="size-5 text-white" />
                </span>
              </>
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={mediaThumbUrl(m.mediaUrl!, 200)}
                alt={m.mediaFileName ?? ""}
                loading="lazy"
                className="size-full object-cover"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function FileList({ items }: { items: MediaItem[] }) {
  const files = items.filter((m) => m.mediaUrl);
  if (files.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-[var(--muted-foreground)]">
        尚無檔案
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      {files.map((m) => (
        <a
          key={m.id}
          href={m.mediaUrl!}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded px-2 py-1.5 transition-colors hover:bg-[var(--bg-secondary)]"
        >
          <FileText className="size-4 shrink-0 text-[var(--muted-foreground)]" />
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--foreground)]">
            {m.mediaFileName || "檔案"}
          </span>
          <span className="shrink-0 text-[10px] text-[var(--muted-foreground)]">
            {fmtDate(m.timestamp)}
          </span>
        </a>
      ))}
    </div>
  );
}

function LinkList({ items }: { items: MediaItem[] }) {
  const rows = items
    .map((m) => ({ m, urls: m.content.match(URL_RE) ?? [] }))
    .filter((r) => r.urls.length > 0);
  if (rows.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-[var(--muted-foreground)]">
        尚無連結
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {rows.map(({ m, urls }) => (
        <div key={m.id} className="rounded px-2 py-1">
          {urls.map((u, i) => (
            <a
              key={i}
              href={u}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate text-xs text-[var(--primary)] hover:underline"
            >
              {u}
            </a>
          ))}
          <div className="mt-0.5 line-clamp-2 text-[10px] text-[var(--muted-foreground)]">
            {m.content}
          </div>
        </div>
      ))}
    </div>
  );
}

function VoiceList({ items }: { items: MediaItem[] }) {
  const voices = items.filter((m) => m.mediaUrl);
  if (voices.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-[var(--muted-foreground)]">
        尚無語音訊息
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {voices.map((m) => (
        <div key={m.id} className="rounded px-2 py-1.5">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] text-[var(--muted-foreground)]">
            <Mic className="size-3" />
            <span>{m.messageType === "VOICE" ? "語音訊息" : "音訊"}</span>
            <span aria-hidden>·</span>
            <span>{fmtDate(m.timestamp)}</span>
          </div>
          <audio
            controls
            preload="none"
            src={m.mediaUrl!}
            className="h-8 w-full"
          />
        </div>
      ))}
    </div>
  );
}
