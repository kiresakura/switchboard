import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Strips invisible and layout-hostile Unicode:
//   U+200B-F  zero-width chars
//   U+202A-E  LRE/RLE/PDF/LRO/RLO (BIDI override — can spoof text direction)
//   U+2066-9  LRI/RLI/FSI/PDI (isolates — less dangerous but noisy in short labels)
// Used for user-submitted titles (group names, pairing names) before render.
// Keeps legitimate RTL script (Arabic/Hebrew) intact — only strips the
// directional control chars that flip surrounding text.
const UNSAFE_CTRL_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

export function safeTitle(s: string | null | undefined, max = 80): string {
  if (!s) return "";
  const stripped = s.replace(UNSAFE_CTRL_CHARS, "");
  if (stripped.length <= max) return stripped;
  return stripped.slice(0, max) + "…";
}

/**
 * Append the on-the-fly thumbnail param to one of our /api/media/<id> URLs.
 * GET /api/media/<id>?w=200|400|800 resizes raster images server-side
 * (sharp → WebP). Non-/api/media URLs (external, blob:, data:) pass through
 * untouched. `width` is typed to the route's allowlisted sizes.
 */
export function mediaThumbUrl(url: string, width: 200 | 400 | 800): string {
  return url.startsWith("/api/media/") ? `${url}?w=${width}` : url;
}
