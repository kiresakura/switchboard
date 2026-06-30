"use client";

/**
 * ChatAvatar — TG-style fallback avatar (colored circle with 1–2 initials).
 *
 * Colors are the 7 peer colors Telegram ships as defaults (and what
 * getUserColorKey seeds when the server hasn't told the client otherwise).
 * Extracted from https://github.com/Ajaxy/telegram-tt — src/util/theme.ts.
 *
 * When a real profile photo URL is available, pass `src`; the component tries
 * it first and silently falls back to initials + color on load failure (e.g.
 * our avatar API returns 404 until the bridge has cached a photo).
 */

import { useState } from "react";
import { cn } from "@/lib/utils";

// Telegram peer colors (src/util/theme.ts updatePeerColors fallback list)
export const TG_PEER_COLORS = [
  "#D45246", // red
  "#F68136", // orange
  "#6C61DF", // violet
  "#46BA43", // green
  "#5CAFFA", // cyan
  "#408ACF", // blue
  "#D95574", // pink
];

/** Deterministic mapping from any string (name / user id) to a peer color index. */
export function peerColorIndex(seed: string | null | undefined): number {
  if (!seed) return 0;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % TG_PEER_COLORS.length;
}

export function peerColor(seed: string | null | undefined): string {
  return TG_PEER_COLORS[peerColorIndex(seed)];
}

/** Extract 1–2 display initials that work for CJK and Latin names. */
export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const trimmed = name.trim();
  if (!trimmed) return "?";
  // If the name contains any CJK character, take the first 1 CJK char.
  const cjk = trimmed.match(/[\u4e00-\u9fff\u3400-\u4dbf]/);
  if (cjk) return cjk[0];
  // Latin-style: pick first letter of first two words.
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

type Size = "xs" | "sm" | "md" | "lg" | "xl";
const SIZE_CLASS: Record<Size, string> = {
  xs: "size-6 text-[10px]",
  sm: "size-8 text-xs",
  md: "size-10 text-sm",
  lg: "size-14 text-base",
  xl: "size-20 text-2xl",
};

export type ChatAvatarProps = {
  name: string | null | undefined;
  /** Optional seed to override `name` for color determination — e.g. a stable user id. */
  seed?: string | null;
  /** Real profile photo URL, if available. */
  src?: string | null;
  size?: Size;
  className?: string;
};

export function ChatAvatar({ name, seed, src, size = "md", className }: ChatAvatarProps) {
  const bg = peerColor(seed ?? name);
  const letters = initials(name);
  const [imgBroken, setImgBroken] = useState(false);
  const showImg = src && !imgBroken;

  return (
    <div
      className={cn(
        "flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-medium text-white shadow-sm",
        SIZE_CLASS[size],
        className,
      )}
      style={showImg ? undefined : {
        // TG's subtle top highlight: white overshoot gradient on top of the base color.
        backgroundImage: `linear-gradient(#ffffff -300%, ${bg})`,
      }}
      aria-label={name ?? "avatar"}
    >
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={name ?? ""}
          className="size-full object-cover"
          onError={() => setImgBroken(true)}
        />
      ) : (
        <span aria-hidden="true">{letters}</span>
      )}
    </div>
  );
}
