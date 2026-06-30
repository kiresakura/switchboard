"use client";

/**
 * MessageLinkPreview — TG-style link preview card rendered below a bubble.
 *
 * Lifecycle:
 *   1. Extract the first http(s) URL from the message text
 *   2. Call /api/link-preview?url=... (server-side OG scraper)
 *   3. If metadata exists, render a card with: site name + title +
 *      description + optional image
 *   4. No metadata → render nothing (the plain URL in the text stays
 *      clickable via MessageText)
 *
 * Response caching at the browser layer keeps repeat views cheap; we also
 * maintain an in-memory Map across mounts so Virtuoso re-mounting a bubble
 * doesn't refetch.
 */

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { firstUrl } from "./message-text";

type Meta = {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  url: string;
};

// Module-level cache shared across all bubbles. Never expires intentionally —
// OG previews rarely change within a session and a full reload clears it.
const previewCache = new Map<string, Meta | null>();
const inflight = new Map<string, Promise<Meta | null>>();

function fetchPreview(url: string): Promise<Meta | null> {
  const existing = previewCache.get(url);
  if (existing !== undefined) return Promise.resolve(existing);
  const pending = inflight.get(url);
  if (pending) return pending;
  const p = fetch(`/api/link-preview?url=${encodeURIComponent(url)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data: Meta | null) => {
      // Treat a payload with zero useful fields as a cache miss too — render
      // nothing, don't block on it.
      if (!data || (!data.title && !data.description && !data.image)) {
        previewCache.set(url, null);
        return null;
      }
      previewCache.set(url, data);
      return data;
    })
    .catch(() => {
      previewCache.set(url, null);
      return null;
    })
    .finally(() => {
      inflight.delete(url);
    });
  inflight.set(url, p);
  return p;
}

export function MessageLinkPreview({
  text,
  side,
}: {
  text: string;
  side: "left" | "right";
}) {
  const url = firstUrl(text);
  const [meta, setMeta] = useState<Meta | null>(
    url ? (previewCache.get(url) ?? null) : null,
  );
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    if (!url) return;
    if (previewCache.has(url)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync w/ module-level cache
      setMeta(previewCache.get(url) ?? null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchPreview(url).then((m) => {
      if (!cancelled) {
        setMeta(m);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!url || !meta) {
    // Show a subtle loader on the sender side ONLY while first fetching —
    // avoids layout thrash when we discover there's no OG data.
    if (loading && url) {
      return (
        <div className="mt-1 text-[10px] text-[var(--muted-foreground)] opacity-70">
          解析連結中…
        </div>
      );
    }
    return null;
  }

  return (
    <a
      href={meta.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "mt-1 flex w-full max-w-full overflow-hidden rounded-md border transition-colors",
        side === "left"
          ? "border-[var(--border)] bg-black/[0.02] hover:bg-black/[0.04] dark:bg-white/5 dark:hover:bg-white/10"
          : "border-white/30 bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20",
      )}
    >
      {meta.image && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={meta.image}
          alt=""
          className="size-16 shrink-0 object-cover"
          loading="lazy"
          onError={(e) => {
            // Hide broken preview thumbnails instead of showing a browser-
            // default "broken image" glyph.
            (e.currentTarget as HTMLElement).style.display = "none";
          }}
        />
      )}
      <div className="min-w-0 flex-1 px-2 py-1.5">
        {meta.siteName && (
          <div className="truncate text-[10px] opacity-70">{meta.siteName}</div>
        )}
        {meta.title && (
          <div className="truncate text-[12px] font-semibold">{meta.title}</div>
        )}
        {meta.description && (
          <div className="line-clamp-2 text-[11px] opacity-80">{meta.description}</div>
        )}
      </div>
    </a>
  );
}
