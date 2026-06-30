"use client";

import { useEffect, useMemo, useState } from "react";

export function WatermarkOverlay({ userName }: { userName: string }) {
  // Defer date to after mount — rendering `new Date()` during SSR/first-render
  // causes hydration mismatch (React #418) when server timezone differs from
  // client, or when Node's and Chrome's Intl implementations format differently.
  // Calling setState during render (the previous impl) also tripped #418 under
  // React 19's stricter render rules — useEffect is the safe primitive here.
  const dateStr = useMemo(() => new Date().toLocaleDateString("zh-Hant"), []);
  const [mounted, setMounted] = useState(false);
  // Hydration-safe pattern: defer the date-containing text until after
  // client-side render so SSR/CSR mismatch (React #418) doesn't fire on
  // machines where server and client timezones/locales format differently.
  // setState-in-effect is the canonical way to express "run once post-
  // hydration" in React 19 — no better primitive.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration sync
    setMounted(true);
  }, []);
  const text = mounted ? `${userName} · ${dateStr}` : userName;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-50 overflow-hidden select-none"
      aria-hidden="true"
    >
      <div
        className="absolute inset-[-50%] flex flex-wrap gap-20 opacity-[0.04]"
        style={{
          transform: "rotate(-25deg)",
        }}
      >
        {Array.from({ length: 60 }).map((_, i) => (
          // Purely decorative repetition with identical content and no reorder — index key is safe here
          <span
            key={i}
            className="whitespace-nowrap text-sm font-medium text-[var(--foreground)]"
          >
            {text}
          </span>
        ))}
      </div>
    </div>
  );
}
