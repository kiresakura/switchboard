"use client";

/**
 * ImageLightbox — TG-style full-screen image viewer.
 *
 * Opens when any `<ChatImage>` in the chat is clicked. Supports:
 *   - Click-outside / ESC to close
 *   - Ctrl/Cmd+scroll or trackpad pinch to zoom (native image zoom not used
 *     because it doesn't feel like TG; we use CSS transform)
 *   - Optional download button
 *
 * Lightweight — no dependencies. A portal'd overlay mounted at document.body.
 */

import { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, Download, ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

type LightboxState = {
  src: string;
  alt?: string;
  fileName?: string | null;
};

// Single module-level state → any ChatImage can open the same overlay without
// prop drilling. React's useSyncExternalStore would work too, but a lean
// subscription pattern is enough for a UI this simple.
const listeners = new Set<(s: LightboxState | null) => void>();
let current: LightboxState | null = null;

function setCurrent(s: LightboxState | null) {
  current = s;
  for (const fn of listeners) fn(s);
}

export function openLightbox(s: LightboxState) {
  setCurrent(s);
}
export function closeLightbox() {
  setCurrent(null);
}

/**
 * ChatImage — inline image that opens the lightbox when clicked.
 * Intended to replace ad-hoc <img onClick={window.open(...)}> calls.
 */
export function ChatImage({
  src,
  alt,
  fileName,
  className,
  fallback,
}: {
  src: string;
  alt?: string;
  fileName?: string | null;
  className?: string;
  fallback?: React.ReactNode;
}) {
  const [broken, setBroken] = useState(false);
  if (broken) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt ?? ""}
      className={cn("cursor-zoom-in", className)}
      onClick={(e) => {
        e.stopPropagation();
        openLightbox({ src, alt, fileName });
      }}
      onError={() => setBroken(true)}
    />
  );
}

/**
 * LightboxHost — mount this ONCE near the top of the app tree. It renders
 * the overlay into a portal when an image is requested.
 */
export function LightboxHost() {
  const [state, setState] = useState<LightboxState | null>(current);
  const [scale, setScale] = useState(1);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe portal mount
    setMounted(true);
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);

  const close = useCallback(() => setCurrent(null), []);

  useEffect(() => {
    if (!state) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset zoom on image change
    setScale(1);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "+" || e.key === "=") setScale((s) => Math.min(s * 1.25, 6));
      else if (e.key === "-") setScale((s) => Math.max(s / 1.25, 0.25));
      else if (e.key === "0") setScale(1);
    };
    window.addEventListener("keydown", onKey);
    // Lock body scroll while open — identical to TG's viewer.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [state, close]);

  if (!mounted || !state) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90 backdrop-blur-sm"
      onClick={close}
      role="dialog"
      aria-label="圖片檢視器"
    >
      {/* Controls — Telegram puts these at the top-right. */}
      <div
        className="absolute top-4 right-4 flex items-center gap-1 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => setScale((s) => Math.max(s / 1.25, 0.25))}
          className="flex size-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
          aria-label="縮小"
          title="縮小（-）"
        >
          <ZoomOut className="size-4" />
        </button>
        <button
          onClick={() => setScale(1)}
          className="flex size-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
          aria-label="還原大小"
          title="還原（0）"
        >
          <RotateCcw className="size-4" />
        </button>
        <button
          onClick={() => setScale((s) => Math.min(s * 1.25, 6))}
          className="flex size-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
          aria-label="放大"
          title="放大（+）"
        >
          <ZoomIn className="size-4" />
        </button>
        <a
          href={state.src}
          download={state.fileName ?? undefined}
          onClick={(e) => e.stopPropagation()}
          className="flex size-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
          aria-label="下載"
          title="下載原檔"
        >
          <Download className="size-4" />
        </a>
        <button
          onClick={close}
          className="flex size-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
          aria-label="關閉"
          title="關閉（Esc）"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Image — zoomable via CSS transform so pinch/scroll zoom feels native. */}
      <div
        className="flex max-h-[90vh] max-w-[90vw] items-center justify-center overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onWheel={(e) => {
          // Ctrl+wheel zoom: matches trackpad pinch on Mac (emitted as ctrlKey).
          if (!(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          const delta = e.deltaY > 0 ? 0.9 : 1.1;
          setScale((s) => Math.max(0.25, Math.min(6, s * delta)));
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={state.src}
          alt={state.alt ?? ""}
          className="max-h-[90vh] max-w-[90vw] transition-transform duration-150"
          style={{ transform: `scale(${scale})` }}
          draggable={false}
        />
      </div>

      {state.fileName && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-[12px] text-white">
          {state.fileName}
        </div>
      )}
    </div>,
    document.body,
  );
}
