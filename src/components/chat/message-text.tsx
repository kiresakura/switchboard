"use client";

/**
 * MessageText — renders Telegram-style rich message content.
 *
 * 兩個資料來源,優先順序:
 *   1. props.entities (TG `message.entities[]` normalize 過的 JSON)— bridge 直接從
 *      TG 拿,精確標記 Bold / Italic / Spoiler / Blockquote / CustomEmoji / TextUrl 等。
 *   2. 沒有 entities(送出端、舊資料、純 text 模式)→ 退回 regex tokenize,自己抓 @mention
 *      跟 URL,維持「2026-05-21 之前」的渲染行為。
 *
 * 設計重點:
 *   - 渲染採「線性切片」演算法 — entities 已是 [offset, offset+length) 區間,
 *     對重疊 (e.g. bold + italic 嵌套) 採「外層 wrapper 先包住、子段繼續切」處理。
 *   - 不直接接受 HTML — 即便 entities.type=text_url,只渲染 href + 顯示文字,
 *     不執行任何 dangerouslySetInnerHTML。
 *   - mention_name (userId) 派發 `switchboard:open-user-profile` event,跟舊 TG mention 連結
 *     行為一致(UserProfileModalHost 接收後開彈窗)。
 *   - custom_emoji 我們沒辦法 render(documentId → image 要 download),先 fallback
 *     顯示原始文字 + 一個 ✨ 標記提示這是 premium 自訂 emoji。
 *
 * Link preview cards 仍走 <MessageLinkPreview>(本元件只做 inline tokenization)。
 */

import { Fragment, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { NormalizedMessageEntity } from "@/lib/telegram/client-manager";

// ── 退回 regex tokenize 用的 patterns(沒 entities 時用)──────────────

// Matches @mention (Latin + CJK letters/digits/underscore, up to 32 chars).
const MENTION_RE = /@[\w一-鿿㐀-䶿]{1,64}/g;

// URL matcher — http(s):// or www. — 不過嚴格(避免亂吞引號等)
const URL_RE = /(https?:\/\/[^\s<>"`]+|www\.[^\s<>"`]+)/g;

// TG mention link(舊版 HTML 注入路徑):`<a href="tg://user?id=N">顯示名</a>`
const TG_MENTION_RE =
  /<a\s+href=["']tg:\/\/user\?id=(\d+)["']>([^<]+)<\/a>/gi;

type Token =
  | { kind: "text"; value: string }
  | { kind: "mention"; value: string }
  | { kind: "url"; value: string; href: string }
  | { kind: "tg-mention"; userId: string; display: string };

export type MessageTextProps = {
  text: string;
  /** Inherited color class for mentions/links (defaults to primary). */
  accentClass?: string;
  /** Click handler for URLs — called first; default is navigation via <a>. */
  onLinkClick?: (url: string) => void;
  className?: string;
  /**
   * 2026-05-21 TG parity:Message entities(TG 直接給的格式化標記)。
   * 有就走 entity renderer;沒有就退回 regex tokenize。
   */
  entities?: NormalizedMessageEntity[] | null;
};

// ─── Spoiler — 劇透遮蓋 ────────────────────────────────────────────

/**
 * TG 風格劇透:預設遮蓋,點擊 / Enter / Space 展開。
 * 用 state 取代純 hover —— hover 在觸控裝置上無法觸發,而且 role="button"
 * 一定要配鍵盤 handler 才算真的可互動(a11y)。展開後不收回,跟 TG 一致。
 */
function Spoiler({ children }: { children: React.ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  if (revealed) {
    return <span className="rounded px-0.5">{children}</span>;
  }
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label="顯示劇透內容"
      title="點擊顯示劇透內容"
      className="cursor-pointer rounded bg-[var(--text-muted)]/30 px-0.5 text-transparent transition-colors hover:bg-[var(--text-muted)]/40"
      onClick={() => setRevealed(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setRevealed(true);
        }
      }}
    >
      {children}
    </span>
  );
}

// ─── Entity-driven renderer (有 entities 時走這條) ────────────────

/**
 * 把 text 切成 spans:某段被 entity 覆蓋就包進對應的 wrapper。
 * 演算法:
 *   1. 把所有 entity 的 offset 跟 offset+length 收集成「切點集合」+ 0 + text.length。
 *   2. sort + dedupe → 得到 boundary 陣列 [b0, b1, ...]。
 *   3. 對每個區段 [bi, bi+1] 找出「覆蓋這個 sub-range」的所有 entities(交集),
 *      用 nested wrapper 包起來。
 * 這樣處理重疊與嵌套都正確,而且不需要 O(N²) 比較。
 */
function renderWithEntities(
  text: string,
  entities: NormalizedMessageEntity[],
  accentClass: string,
  onLinkClick?: (url: string) => void,
): React.ReactNode {
  // 注意:TG entity offset/length 是「UTF-16 code unit」計數,跟 JS string 一致,
  // 所以可以直接 text.slice(offset, offset+length)。
  const boundaries = new Set<number>([0, text.length]);
  for (const e of entities) {
    const start = Math.max(0, e.offset);
    const end = Math.min(text.length, e.offset + e.length);
    if (start >= end) continue;
    boundaries.add(start);
    boundaries.add(end);
  }
  const bounds = Array.from(boundaries).sort((a, b) => a - b);

  const out: React.ReactNode[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const segStart = bounds[i];
    const segEnd = bounds[i + 1];
    if (segStart >= segEnd) continue;
    const seg = text.slice(segStart, segEnd);
    const covering = entities.filter(
      (e) => e.offset <= segStart && e.offset + e.length >= segEnd,
    );
    out.push(
      <Fragment key={`seg-${segStart}`}>
        {wrapWithEntities(seg, covering, segStart, accentClass, onLinkClick)}
      </Fragment>,
    );
  }
  return out;
}

/**
 * 對一段子文字 + 覆蓋它的 entity 清單,從「最深層 → 最淺層」包 wrapper。
 * 我們的順序選擇:
 *   - 結構性 (pre / blockquote / code) 包最外層 (block-ish)
 *   - 行為性 (text_url / mention / mention_name) 中間 (anchor 行為要在格式之上)
 *   - 視覺性 (bold / italic / underline / strike / spoiler) 最內層
 * 這樣 a > strong > spoiler-content 之類嵌套 DOM 結構正確,點擊 anchor 也能繼承內層格式。
 */
function wrapWithEntities(
  seg: string,
  entities: NormalizedMessageEntity[],
  segOffset: number,
  accentClass: string,
  onLinkClick?: (url: string) => void,
): React.ReactNode {
  // 找各類 entity(同類取第一個)
  const find = (type: NormalizedMessageEntity["type"]) =>
    entities.find((e) => e.type === type);

  const pre = find("pre");
  const block = find("blockquote");
  const code = find("code");
  const textUrl = find("text_url");
  const url = find("url");
  const email = find("email");
  const phone = find("phone");
  const mention = find("mention");
  const mentionName = find("mention_name");
  const customEmoji = find("custom_emoji");

  const bold = find("bold");
  const italic = find("italic");
  const underline = find("underline");
  const strike = find("strikethrough");
  const spoiler = find("spoiler");

  // 構建從內到外的 ReactNode:先做內層,逐層 wrap 上去。
  let node: React.ReactNode = seg;

  // 內層:視覺修飾
  if (bold) node = <strong className="font-semibold">{node}</strong>;
  if (italic) node = <em className="italic">{node}</em>;
  if (underline) node = <span className="underline">{node}</span>;
  if (strike) node = <span className="line-through">{node}</span>;
  if (spoiler) {
    // TG spoiler:預設遮蓋,點擊 / Enter / Space 展開 — 見 <Spoiler> 元件。
    node = <Spoiler>{node}</Spoiler>;
  }

  // 中層:行為修飾(anchor / mention)— 一個 segment 只可能命中一個 anchor entity
  if (textUrl?.url) {
    const href = textUrl.url;
    node = (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          if (onLinkClick) {
            e.preventDefault();
            onLinkClick(href);
          }
        }}
        className={cn(
          "underline decoration-dotted underline-offset-2 hover:decoration-solid",
          accentClass,
        )}
      >
        {node}
      </a>
    );
  } else if (url) {
    // 純 URL entity:href 就是 seg 自己
    const raw = seg;
    const href = raw.startsWith("http") ? raw : `https://${raw}`;
    node = (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          if (onLinkClick) {
            e.preventDefault();
            onLinkClick(href);
          }
        }}
        className={cn(
          "underline decoration-dotted underline-offset-2 hover:decoration-solid",
          accentClass,
        )}
      >
        {node}
      </a>
    );
  } else if (email) {
    node = (
      <a href={`mailto:${seg}`} className={cn("underline", accentClass)}>
        {node}
      </a>
    );
  } else if (phone) {
    node = (
      <a href={`tel:${seg.replace(/\s+/g, "")}`} className={cn("underline", accentClass)}>
        {node}
      </a>
    );
  } else if (mentionName?.userId) {
    const userId = mentionName.userId;
    node = (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent("switchboard:open-user-profile", {
              detail: { platformUserId: userId },
            }),
          );
        }}
        className={cn(
          "font-medium hover:underline cursor-pointer",
          accentClass,
        )}
        title="點擊查看用戶資料 + 共同群"
      >
        {node}
      </button>
    );
  } else if (mention) {
    // @mention(用戶名形式)— 沒給 userId 就純樣式化
    node = <span className={cn("font-medium", accentClass)}>{node}</span>;
  }

  // 外層:結構性 — code / pre / blockquote
  if (code) {
    node = (
      <code className="bg-[var(--bg-secondary)]/80 rounded px-1 py-0.5 font-mono text-[0.9em]">
        {node}
      </code>
    );
  }
  if (pre) {
    // pre 是 block-level,但我們塞在 inline 流裡,用 inline-block 妥協
    node = (
      <code className="block bg-[var(--bg-secondary)]/80 rounded p-2 font-mono text-[0.9em] my-1 whitespace-pre">
        {node}
      </code>
    );
  }
  if (block) {
    node = (
      <span className="block border-l-2 border-[var(--primary)]/60 pl-2 my-1 opacity-90">
        {node}
      </span>
    );
  }

  // customEmoji:沒辦法 render 真的圖,加個 ✨ 標記 + tooltip 提示是 Premium 自訂 emoji。
  if (customEmoji) {
    node = (
      <span title="Telegram Premium 自訂 emoji">
        {node}
        <span className="text-[0.8em] opacity-70">✨</span>
      </span>
    );
  }

  // 避免 segOffset 警告(用於 React key 不重複)— 直接 ignore
  void segOffset;
  return node;
}

// ─── Regex tokenizer (fallback;沒 entities 時走這條) ──────────────

function tokenize(text: string): Token[] {
  if (!text) return [];
  type Hit =
    | { start: number; end: number; kind: "mention"; value: string }
    | { start: number; end: number; kind: "url"; value: string }
    | { start: number; end: number; kind: "tg-mention"; userId: string; display: string };
  const hits: Hit[] = [];

  // TG mention 先收（優先級最高，避免 URL 正則去抓 tg://user?id=N）
  for (const m of text.matchAll(TG_MENTION_RE)) {
    if (m.index == null) continue;
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      kind: "tg-mention",
      userId: m[1],
      display: m[2],
    });
  }
  for (const m of text.matchAll(MENTION_RE)) {
    if (m.index == null) continue;
    hits.push({ start: m.index, end: m.index + m[0].length, kind: "mention", value: m[0] });
  }
  for (const m of text.matchAll(URL_RE)) {
    if (m.index == null) continue;
    let raw = m[0];
    const trailingMatch = raw.match(/[\).,!?]+$/);
    if (trailingMatch) raw = raw.slice(0, raw.length - trailingMatch[0].length);
    if (!raw) continue;
    hits.push({ start: m.index, end: m.index + raw.length, kind: "url", value: raw });
  }
  hits.sort((a, b) => a.start - b.start);

  const out: Token[] = [];
  let cursor = 0;
  for (const h of hits) {
    if (h.start < cursor) continue;
    if (h.start > cursor) out.push({ kind: "text", value: text.slice(cursor, h.start) });
    if (h.kind === "mention") out.push({ kind: "mention", value: h.value });
    else if (h.kind === "url")
      out.push({ kind: "url", value: h.value, href: h.value.startsWith("http") ? h.value : `https://${h.value}` });
    else out.push({ kind: "tg-mention", userId: h.userId, display: h.display });
    cursor = h.end;
  }
  if (cursor < text.length) out.push({ kind: "text", value: text.slice(cursor) });
  return out;
}

export function MessageText({
  text,
  accentClass,
  onLinkClick,
  className,
  entities,
}: MessageTextProps) {
  const tokens = useMemo(() => tokenize(text), [text]);
  const hasEntities = Array.isArray(entities) && entities.length > 0;
  const accent = accentClass ?? "text-[var(--primary)]";

  if (hasEntities) {
    return (
      <span className={cn("whitespace-pre-wrap break-words", className)}>
        {renderWithEntities(text, entities, accent, onLinkClick)}
      </span>
    );
  }

  return (
    <span className={cn("whitespace-pre-wrap break-words", className)}>
      {tokens.map((t, i) => {
        if (t.kind === "text") return <Fragment key={i}>{t.value}</Fragment>;
        if (t.kind === "mention")
          return (
            <span key={i} className={cn("font-medium", accent)}>
              {t.value}
            </span>
          );
        if (t.kind === "tg-mention") {
          return (
            <button
              key={i}
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                window.dispatchEvent(
                  new CustomEvent("switchboard:open-user-profile", {
                    detail: { platformUserId: t.userId },
                  }),
                );
              }}
              className={cn(
                "font-medium hover:underline cursor-pointer",
                accent,
              )}
              title="點擊查看用戶資料 + 共同群"
            >
              {t.display}
            </button>
          );
        }
        return (
          <a
            key={i}
            href={t.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              if (onLinkClick) {
                e.preventDefault();
                onLinkClick(t.href);
              }
            }}
            className={cn(
              "underline decoration-dotted underline-offset-2 hover:decoration-solid",
              accent,
            )}
          >
            {t.value}
          </a>
        );
      })}
    </span>
  );
}

/**
 * Return the FIRST URL in a message, if any — used by link-preview cards.
 */
export function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"`]+/);
  if (!m) return null;
  let u = m[0];
  const trailingMatch = u.match(/[\).,!?]+$/);
  if (trailingMatch) u = u.slice(0, u.length - trailingMatch[0].length);
  return u || null;
}
