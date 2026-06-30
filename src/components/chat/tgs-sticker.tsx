"use client";

/**
 * TgsSticker — 渲染 Telegram TGS 動畫貼圖。
 *
 * TGS 檔案 = gzip 壓縮的 Lottie JSON 動畫。客戶端要:
 *   1. fetch bytes(透過 /api/media/<id> URL)
 *   2. pako.inflate 解壓
 *   3. JSON.parse
 *   4. 用 lottie-react 渲染
 *
 * lottie + pako bundle 約 226KB,所以這個 component 透過 next/dynamic 載入,
 * 只有「真的看到 TGS 貼圖」時才會 fetch + execute。
 *
 * 失敗(壞檔 / 解壓錯誤 / 網路失敗)→ fallback 顯示靜態 placeholder。
 */

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { inflate } from "pako";

// 真正的 Lottie player code split 出去,只有此 component 第一次 render 才 load。
const Lottie = dynamic(() => import("lottie-react"), { ssr: false });

export function TgsSticker({ url, size = 128 }: { url: string; size?: number }) {
  const [animationData, setAnimationData] = useState<object | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAnimationData(null);
    setError(null);

    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const json = inflate(new Uint8Array(buf), { to: "string" });
        const parsed = JSON.parse(json) as object;
        if (!cancelled) setAnimationData(parsed);
      } catch (err) {
        if (!cancelled) setError(String(err).slice(0, 100));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-[var(--border)] text-xs text-[var(--text-muted)]"
        style={{ width: size, height: size }}
        title={`TGS 解析失敗:${error}`}
      >
        🎭 動畫貼圖
      </div>
    );
  }

  if (!animationData) {
    // 載入中 — placeholder 維持版面高度避免聊天 scroll 跳動
    return (
      <div
        className="flex items-center justify-center rounded-md bg-[var(--bg-secondary)]/40 text-xs text-[var(--text-muted)] animate-pulse"
        style={{ width: size, height: size }}
        aria-label="動畫貼圖載入中"
      >
        🎭
      </div>
    );
  }

  return (
    <Lottie
      animationData={animationData}
      loop
      autoplay
      style={{ width: size, height: size }}
    />
  );
}
