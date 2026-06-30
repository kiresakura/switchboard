import { NextResponse } from "next/server";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { requireAuth } from "@/lib/auth/middleware";

/**
 * GET /api/link-preview?url=<encoded>
 *
 * Server-side fetches the given URL and extracts OpenGraph / Twitter card
 * metadata. Returns JSON { title, description, image, siteName } (any may be
 * null). We *don't* persist previews — Switchboard messages are relatively
 * low-volume and caching at the browser (Cache-Control) is enough for
 * repeated views.
 *
 * SSRF hardening:
 *   - Only http(s) URLs allowed — re-checked on every redirect hop.
 *   - The hostname is DNS-resolved and EVERY A/AAAA record is validated
 *     against private / loopback / link-local / CGNAT / reserved ranges
 *     (IPv4 + IPv6). A public-looking hostname with a private A record is
 *     therefore rejected — substring host matching alone is not enough.
 *   - Redirects are followed manually (redirect: "manual") so each hop's
 *     host is re-resolved and re-validated; a 30x into the internal
 *     network is blocked.
 *   - 5-second hard timeout, max 5 redirects, 512 KB response cap.
 *   - Residual: a sub-second DNS rebind between our lookup and undici's
 *     own connect-time resolve is not closed — fully closing that needs a
 *     connect-time lookup hook on the fetch dispatcher (out of scope).
 */
export async function GET(req: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url).searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return NextResponse.json({ error: "invalid URL" }, { status: 400 });
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return NextResponse.json({ error: "only http/https is supported" }, { status: 400 });
  }

  const fetched = await safeFetchHtml(target);
  if ("error" in fetched) {
    // SSRF rejections surface as 403; transient upstream problems (timeout,
    // non-html, dead host, upstream 5xx) degrade gracefully to a 200 null-
    // meta so the UI just renders a bare link.
    if (fetched.blocked) {
      return NextResponse.json({ error: fetched.error }, { status: 403 });
    }
    return NextResponse.json(
      { title: null, description: null, image: null, siteName: null, error: fetched.error },
      { status: 200, headers: cacheHeaders(fetched.status ? 600 : 60) },
    );
  }

  const meta = extractMeta(fetched.html, fetched.finalUrl);
  return NextResponse.json(meta, { status: 200, headers: cacheHeaders(3600) });
}

// ─── SSRF-safe fetch ───────────────────────────────────────────────

const MAX_REDIRECTS = 5;
const MAX_BODY = 512 * 1024;
const FETCH_TIMEOUT_MS = 5000;

type FetchOk = { html: string; finalUrl: URL };
type FetchErr = { error: string; blocked: boolean; status?: number };

/**
 * Fetch `initial` as HTML, following redirects manually so every hop's
 * host can be re-validated against the SSRF blocklist. Caps the body at
 * 512 KB and the whole walk at MAX_REDIRECTS hops.
 */
async function safeFetchHtml(initial: URL): Promise<FetchOk | FetchErr> {
  let current = initial;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      return { error: "only http/https is supported", blocked: true };
    }

    const block = await checkHost(current.hostname);
    if (block) {
      return { error: block.reason, blocked: block.blocked };
    }

    let res: Response;
    try {
      res = await fetch(current.toString(), {
        headers: {
          // Telegram-friendly UA: some sites gate OG tags on recognized bots.
          "user-agent": "Mozilla/5.0 (compatible; Switchboard-LinkPreview/1.0)",
          accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "manual",
      });
    } catch (err) {
      return { error: String(err).slice(0, 100), blocked: false };
    }

    // Manual redirect: resolve Location against the current URL and loop —
    // the next iteration re-runs checkHost() on the new host.
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      const loc = res.headers.get("location") ?? "";
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        return { error: "bad redirect target", blocked: false };
      }
      current = next;
      continue;
    }

    if (!res.ok) {
      return { error: `upstream ${res.status}`, blocked: false, status: res.status };
    }

    const ct = res.headers.get("content-type") ?? "";
    if (!/^text\/html|^application\/xhtml/i.test(ct)) {
      return { error: "not html", blocked: false, status: 200 };
    }

    // Cap at 512 KB — OG tags live in <head>, deep body text is irrelevant.
    const reader = res.body?.getReader();
    if (!reader) return { error: "no body", blocked: false };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        chunks.push(value);
        if (size > MAX_BODY) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    } catch (err) {
      return { error: String(err).slice(0, 100), blocked: false };
    }
    const buf = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      buf.set(c, offset);
      offset += c.byteLength;
    }
    return {
      html: new TextDecoder("utf-8", { fatal: false }).decode(buf),
      finalUrl: current,
    };
  }
  return { error: "too many redirects", blocked: false };
}

type HostBlock = { reason: string; blocked: boolean };

/**
 * Resolve `hostname` and return a block reason if it (or any resolved IP)
 * is non-public. `blocked: true` → genuine SSRF rejection (→ 403);
 * `blocked: false` → benign failure such as an unresolvable host (→ soft
 * 200 null-meta). Returns null when every resolved address is public.
 */
async function checkHost(hostname: string): Promise<HostBlock | null> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // Literal IP in the URL — no DNS round-trip needed.
  const literal = isIP(host);
  if (literal === 4) {
    return isBlockedIpv4(host)
      ? { reason: "private addresses are not allowed", blocked: true }
      : null;
  }
  if (literal === 6) {
    return isBlockedIpv6(host)
      ? { reason: "private addresses are not allowed", blocked: true }
      : null;
  }

  // Internal names that should never be resolved at all.
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { reason: "private addresses are not allowed", blocked: true };
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dnsLookup(host, { all: true });
  } catch {
    return { reason: "could not resolve host", blocked: false };
  }
  if (records.length === 0) {
    return { reason: "could not resolve host", blocked: false };
  }
  for (const r of records) {
    const bad =
      r.family === 6 ? isBlockedIpv6(r.address) : isBlockedIpv4(r.address);
    if (bad) {
      return { reason: "private addresses are not allowed", blocked: true };
    }
  }
  return null;
}

/** Dotted-quad IPv4 → unsigned 32-bit int, or null when unparseable. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = ((n << 8) | v) >>> 0;
  }
  return n;
}

/** True if `ip` is in a private / loopback / link-local / reserved IPv4 range. */
function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → fail closed
  const inRange = (base: string, bits: number): boolean => {
    const b = ipv4ToInt(base);
    if (b === null) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((b & mask) >>> 0);
  };
  return (
    inRange("0.0.0.0", 8) || // "this" network
    inRange("10.0.0.0", 8) || // private
    inRange("100.64.0.0", 10) || // CGNAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link-local incl. cloud metadata
    inRange("172.16.0.0", 12) || // private
    inRange("192.0.0.0", 24) || // IETF protocol assignments
    inRange("192.168.0.0", 16) || // private
    inRange("198.18.0.0", 15) || // benchmarking
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) // reserved / broadcast
  );
}

/** True if `ip` is a loopback / ULA / link-local / multicast IPv6 address. */
function isBlockedIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]; // strip any zone id

  // IPv4-mapped / -compatible in mixed notation (::ffff:a.b.c.d) — the
  // address really is the embedded IPv4, so validate that instead.
  const mapped = addr.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedIpv4(mapped[1]);

  if (addr === "::1" || addr === "::") return true; // loopback / unspecified

  const head = parseInt(addr.split(":")[0] || "", 16);
  if (Number.isNaN(head)) return true; // compressed/odd leading form → fail closed
  if (head >= 0xfc00 && head <= 0xfdff) return true; // fc00::/7 ULA
  if (head >= 0xfe80 && head <= 0xfebf) return true; // fe80::/10 link-local
  if (head >= 0xff00) return true; // ff00::/8 multicast
  return false;
}

function cacheHeaders(seconds: number): HeadersInit {
  return {
    "Cache-Control": `private, max-age=${seconds}`,
  };
}

type Meta = {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  url: string;
};

function extractMeta(html: string, base: URL): Meta {
  // Grab the <head> slice only to avoid walking the entire body.
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const head = headMatch ? headMatch[1] : html.slice(0, 50_000);

  const pickMeta = (names: string[]): string | null => {
    for (const name of names) {
      // Try property="..." (OG) and name="..." (Twitter / generic).
      const attr = `(?:property|name)=["']${escapeRegex(name)}["']`;
      const re = new RegExp(
        `<meta[^>]*(?:${attr}[^>]*content=["']([^"']*)["']|content=["']([^"']*)["'][^>]*${attr})[^>]*>`,
        "i",
      );
      const m = head.match(re);
      if (m) {
        const v = (m[1] ?? m[2] ?? "").trim();
        if (v) return decodeEntities(v);
      }
    }
    return null;
  };

  const title =
    pickMeta(["og:title", "twitter:title"]) ??
    (head.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null);
  const description = pickMeta(["og:description", "twitter:description", "description"]);
  const imageRaw = pickMeta(["og:image", "og:image:url", "twitter:image", "twitter:image:src"]);
  const siteName = pickMeta(["og:site_name", "application-name"]);

  let image: string | null = null;
  if (imageRaw) {
    try {
      image = new URL(imageRaw, base).toString();
    } catch {
      image = null;
    }
  }

  return {
    title,
    description,
    image,
    siteName,
    url: base.toString(),
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(s: string): string {
  // Minimal entity decode — OG content rarely contains anything exotic.
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
}
