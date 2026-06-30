"use client";

/**
 * FloatingGroupNotesPanel — 審核佇列專用的浮動備註視窗。
 *
 * 行為設計(2026-05-05 spec):
 *   - 永遠掛在頁面右上角(預設位置;使用者可拖動,位置會記到 localStorage)。
 *   - 可拖動 (header 為拖把)。
 *   - 可調整大小 (右下角拖把)。
 *   - 可縮小成小 pill,但**沒有「關閉」按鈕** — 客服在審核佇列頁時,
 *     備註視窗永遠存在,以最大化提示效果(不必擔心自己手滑關掉)。
 *   - 同時顯示來源群與目標群的備註,各自可獨立編輯(編輯一邊時另一邊
 *     的儲存按鈕仍可運作 — 內部用 editingSide 狀態判斷)。
 *
 * 持久化:
 *   - localStorage key `switchboard_review_notes_panel` 儲存 {x, y, w, h, minimized}。
 *   - 換瀏覽器/裝置會回到預設位置,這是可接受的。
 *
 * 響應式:
 *   - 視窗寬 < md (768px) 時整個元件不渲染;手機端的客服應該透過內嵌
 *     的 popover 看備註,浮動視窗在小螢幕上反而擋畫面。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GripHorizontal, Minus, Plus, StickyNote } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type GroupNote = {
  groupId: string;
  groupTitle: string;
  notes: string | null;
};

interface Props {
  workspaceId: string;
  source: GroupNote | null;
  target: GroupNote | null;
  onSaved: (groupId: string, notes: string | null) => void;
}

const DEFAULT_W = 360;
const DEFAULT_H = 380;
const MIN_W = 280;
const MIN_H = 220;
const MAX_W = 720;
const MAX_H = 720;
const MOBILE_BREAKPOINT = 768;
const PANEL_KEY = "switchboard_review_notes_panel";

interface PanelState {
  x: number;
  y: number;
  w: number;
  h: number;
  minimized: boolean;
}

// 8 個縮放方向:n/e/s/w 邊 + ne/se/sw/nw 角。從 n/w 兩側拖動會同時調整
// 位置(讓對側維持原位),所以開始拖動時要記住起始的 x/y 一起算。
type ResizeDir = "n" | "e" | "s" | "w" | "ne" | "se" | "sw" | "nw";

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export function FloatingGroupNotesPanel({
  workspaceId,
  source,
  target,
  onSaved,
}: Props) {
  const { toast } = useToast();
  const [mounted, setMounted] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [state, setState] = useState<PanelState>({
    x: 0,
    y: 0,
    w: DEFAULT_W,
    h: DEFAULT_H,
    minimized: false,
  });
  const [editingSide, setEditingSide] = useState<null | "source" | "target">(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const dragStart = useRef<{ mx: number; my: number; px: number; py: number } | null>(null);
  const resizeStart = useRef<{
    mx: number;
    my: number;
    x: number;
    y: number;
    w: number;
    h: number;
    dir: ResizeDir;
  } | null>(null);

  // Hydrate position/size from localStorage on first mount
  useEffect(() => {
    setMounted(true);
    const desktop = window.innerWidth >= MOBILE_BREAKPOINT;
    setIsDesktop(desktop);
    if (!desktop) return;
    try {
      const raw = localStorage.getItem(PANEL_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PanelState>;
        setState({
          x:
            typeof parsed.x === "number"
              ? Math.max(0, Math.min(window.innerWidth - 80, parsed.x))
              : Math.max(0, window.innerWidth - DEFAULT_W - 24),
          y:
            typeof parsed.y === "number"
              ? Math.max(0, Math.min(window.innerHeight - 40, parsed.y))
              : 80,
          w:
            typeof parsed.w === "number"
              ? Math.max(MIN_W, Math.min(MAX_W, parsed.w))
              : DEFAULT_W,
          h:
            typeof parsed.h === "number"
              ? Math.max(MIN_H, Math.min(MAX_H, parsed.h))
              : DEFAULT_H,
          minimized: !!parsed.minimized,
        });
      } else {
        setState({
          x: Math.max(0, window.innerWidth - DEFAULT_W - 24),
          y: 80,
          w: DEFAULT_W,
          h: DEFAULT_H,
          minimized: false,
        });
      }
    } catch {
      setState((p) => ({ ...p, x: 24, y: 80 }));
    }
  }, []);

  // Persist after every change (debounce-free is fine — drag emits many but
  // localStorage writes are cheap and this is single-tab UX).
  useEffect(() => {
    if (!mounted) return;
    try {
      localStorage.setItem(PANEL_KEY, JSON.stringify(state));
    } catch {}
  }, [state, mounted]);

  // Keep panel in viewport when window resizes / orientation changes.
  useEffect(() => {
    if (!mounted) return;
    function onWinResize() {
      const desktop = window.innerWidth >= MOBILE_BREAKPOINT;
      setIsDesktop(desktop);
      if (!desktop) return;
      setState((prev) => ({
        ...prev,
        x: Math.max(0, Math.min(window.innerWidth - 80, prev.x)),
        y: Math.max(0, Math.min(window.innerHeight - 40, prev.y)),
      }));
    }
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
  }, [mounted]);

  // ── Drag ─────────────────────────────────────────────────────────
  const onDragMove = useCallback((e: MouseEvent) => {
    const s = dragStart.current;
    if (!s) return;
    setState((prev) => ({
      ...prev,
      x: Math.max(0, Math.min(window.innerWidth - 80, s.px + (e.clientX - s.mx))),
      y: Math.max(0, Math.min(window.innerHeight - 40, s.py + (e.clientY - s.my))),
    }));
  }, []);
  const onDragEnd = useCallback(() => {
    dragStart.current = null;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
  }, [onDragMove]);
  function onDragStart(e: React.MouseEvent) {
    if (e.button !== 0) return;
    // Don't start drag if clicking on a button inside the header
    if ((e.target as HTMLElement).closest("button")) return;
    dragStart.current = {
      mx: e.clientX,
      my: e.clientY,
      px: state.x,
      py: state.y,
    };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
    e.preventDefault();
  }

  // ── Resize ───────────────────────────────────────────────────────
  // 8 方向縮放:
  //   - 含 "e" → 拖右邊,寬度跟著 dx 增減,x 不變
  //   - 含 "w" → 拖左邊,寬度往反向算(dx<0 變寬),同時 x 跟著動讓右側錨點不變
  //   - 含 "s" → 拖下邊,高度跟 dy 同向,y 不變
  //   - 含 "n" → 拖上邊,高度反向,y 跟著動讓底部錨點不變
  // 同時用 maxAllowedW/H 限制不要超出視窗,因此不需要再 clamp 一次 x/y。
  const onResizeMove = useCallback((e: MouseEvent) => {
    const s = resizeStart.current;
    if (!s) return;
    const dx = e.clientX - s.mx;
    const dy = e.clientY - s.my;
    let nx = s.x;
    let ny = s.y;
    let nw = s.w;
    let nh = s.h;

    if (s.dir.includes("e")) {
      const maxW = Math.max(MIN_W, window.innerWidth - s.x);
      nw = clamp(s.w + dx, MIN_W, Math.min(MAX_W, maxW));
    }
    if (s.dir.includes("w")) {
      const maxW = Math.max(MIN_W, s.x + s.w);
      const proposed = s.w - dx;
      nw = clamp(proposed, MIN_W, Math.min(MAX_W, maxW));
      nx = s.x + (s.w - nw);
    }
    if (s.dir.includes("s")) {
      const maxH = Math.max(MIN_H, window.innerHeight - s.y);
      nh = clamp(s.h + dy, MIN_H, Math.min(MAX_H, maxH));
    }
    if (s.dir.includes("n")) {
      const maxH = Math.max(MIN_H, s.y + s.h);
      const proposed = s.h - dy;
      nh = clamp(proposed, MIN_H, Math.min(MAX_H, maxH));
      ny = s.y + (s.h - nh);
    }

    setState((prev) => ({ ...prev, x: nx, y: ny, w: nw, h: nh }));
  }, []);
  const onResizeEnd = useCallback(() => {
    resizeStart.current = null;
    document.removeEventListener("mousemove", onResizeMove);
    document.removeEventListener("mouseup", onResizeEnd);
  }, [onResizeMove]);
  function onResizeStart(dir: ResizeDir, e: React.MouseEvent) {
    if (e.button !== 0) return;
    resizeStart.current = {
      mx: e.clientX,
      my: e.clientY,
      x: state.x,
      y: state.y,
      w: state.w,
      h: state.h,
      dir,
    };
    document.addEventListener("mousemove", onResizeMove);
    document.addEventListener("mouseup", onResizeEnd);
    e.preventDefault();
    e.stopPropagation();
  }

  function startEdit(side: "source" | "target") {
    const t = side === "source" ? source : target;
    setDraft(t?.notes ?? "");
    setEditingSide(side);
  }

  async function save() {
    if (!editingSide) return;
    const t = editingSide === "source" ? source : target;
    if (!t) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/groups/${t.groupId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes: draft }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "備註儲存失敗");
        return;
      }
      const newNotes = draft.trim() ? draft : null;
      onSaved(t.groupId, newNotes);
      setEditingSide(null);
      toast.success("備註已儲存");
    } finally {
      setSaving(false);
    }
  }

  if (!mounted || !isDesktop || typeof document === "undefined") return null;

  const hasSourceNotes = !!(source?.notes && source.notes.trim());
  const hasTargetNotes = !!(target?.notes && target.notes.trim());

  // ── Minimized: tiny pill — only header row, draggable, with restore btn.
  if (state.minimized) {
    return createPortal(
      <div
        className="fixed z-[1500] flex items-center gap-2 rounded-full border border-amber-500/40 bg-[var(--card)] py-1 pl-2 pr-1 shadow-lg cursor-grab active:cursor-grabbing select-none"
        style={{ top: state.y, left: state.x }}
        onMouseDown={onDragStart}
      >
        <StickyNote className="size-3.5 text-amber-600" />
        <span className="text-[11px] font-medium">群組備註</span>
        {(hasSourceNotes || hasTargetNotes) && (
          <span className="flex gap-0.5">
            {hasSourceNotes && (
              <span
                className="size-1.5 rounded-full bg-amber-500"
                title="來源群有備註"
              />
            )}
            {hasTargetNotes && (
              <span
                className="size-1.5 rounded-full bg-amber-500"
                title="目標群有備註"
              />
            )}
          </span>
        )}
        <button
          type="button"
          aria-label="展開"
          title="展開"
          onClick={(e) => {
            e.stopPropagation();
            setState((p) => ({ ...p, minimized: false }));
          }}
          className="ml-0.5 rounded-full p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-secondary)] hover:text-[var(--foreground)]"
        >
          <Plus className="size-3" />
        </button>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      className="fixed z-[1500] flex flex-col rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-xl"
      style={{
        top: state.y,
        left: state.x,
        width: state.w,
        height: state.h,
      }}
    >
      {/* Header / drag handle. 整條 header 都是拖把,但點到按鈕時 onDragStart
          會 short-circuit (closest("button"))。 */}
      <div
        className="flex items-center gap-1.5 select-none rounded-t-lg border-b border-[var(--border)] bg-[var(--muted)]/40 px-2 py-1.5 cursor-grab active:cursor-grabbing"
        onMouseDown={onDragStart}
      >
        <GripHorizontal className="size-3.5 text-[var(--muted-foreground)]" />
        <StickyNote className="size-3.5 text-amber-600" />
        <span className="text-[11px] font-semibold">群組備註</span>
        <span className="ml-1 text-[10px] text-[var(--muted-foreground)]">
          可拖動 / 縮放
        </span>
        <button
          type="button"
          aria-label="縮小"
          title="縮小"
          onClick={(e) => {
            e.stopPropagation();
            setState((p) => ({ ...p, minimized: true }));
          }}
          className="ml-auto rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-secondary)] hover:text-[var(--foreground)]"
        >
          <Minus className="size-3.5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 space-y-2 overflow-y-auto px-2.5 py-2">
        <NoteSection
          icon="📍"
          sideLabel="來源群"
          group={source}
          editing={editingSide === "source"}
          onStartEdit={() => startEdit("source")}
          onCancel={() => setEditingSide(null)}
          onSave={save}
          draft={draft}
          setDraft={setDraft}
          saving={saving && editingSide === "source"}
        />
        <NoteSection
          icon="🎯"
          sideLabel="目標群"
          group={target}
          editing={editingSide === "target"}
          onStartEdit={() => startEdit("target")}
          onCancel={() => setEditingSide(null)}
          onSave={save}
          draft={draft}
          setDraft={setDraft}
          saving={saving && editingSide === "target"}
        />
      </div>

      {/* 8 個縮放把手 — 上下左右邊 + 4 個角。
          邊把手做成細條(~5px),靠 cursor 提示;角落把手 size-3,且在
          z-order 上蓋過邊條,讓拐角拖動優先抓到對角縮放。SE 角額外畫一
          個小三角形圖示,作為傳統 desktop window 的視覺提示。 */}
      {/* Top edge (n) */}
      <div
        onMouseDown={(e) => onResizeStart("n", e)}
        aria-label="調整高度(上)"
        className="absolute left-3 right-3 top-0 h-1.5 cursor-ns-resize"
      />
      {/* Bottom edge (s) */}
      <div
        onMouseDown={(e) => onResizeStart("s", e)}
        aria-label="調整高度(下)"
        className="absolute left-3 right-3 bottom-0 h-1.5 cursor-ns-resize"
      />
      {/* Left edge (w) */}
      <div
        onMouseDown={(e) => onResizeStart("w", e)}
        aria-label="調整寬度(左)"
        className="absolute top-3 bottom-3 left-0 w-1.5 cursor-ew-resize"
      />
      {/* Right edge (e) */}
      <div
        onMouseDown={(e) => onResizeStart("e", e)}
        aria-label="調整寬度(右)"
        className="absolute top-3 bottom-3 right-0 w-1.5 cursor-ew-resize"
      />
      {/* NW corner */}
      <div
        onMouseDown={(e) => onResizeStart("nw", e)}
        aria-label="左上角縮放"
        className="absolute top-0 left-0 size-3 cursor-nwse-resize z-10"
      />
      {/* NE corner */}
      <div
        onMouseDown={(e) => onResizeStart("ne", e)}
        aria-label="右上角縮放"
        className="absolute top-0 right-0 size-3 cursor-nesw-resize z-10"
      />
      {/* SW corner */}
      <div
        onMouseDown={(e) => onResizeStart("sw", e)}
        aria-label="左下角縮放"
        className="absolute bottom-0 left-0 size-3 cursor-nesw-resize z-10"
      />
      {/* SE corner — 帶視覺指示的拐角把手 */}
      <div
        onMouseDown={(e) => onResizeStart("se", e)}
        aria-label="右下角縮放"
        title="拖動調整大小"
        className="absolute bottom-0 right-0 size-4 cursor-nwse-resize z-10 flex items-end justify-end p-0.5"
      >
        <svg
          viewBox="0 0 14 14"
          className="size-3 text-[var(--muted-foreground)]/70"
          aria-hidden
        >
          <path
            d="M13 1 L1 13 M13 5 L5 13 M13 9 L9 13"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
          />
        </svg>
      </div>
    </div>,
    document.body,
  );
}

interface NoteSectionProps {
  icon: string;
  sideLabel: string;
  group: GroupNote | null;
  editing: boolean;
  onStartEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  draft: string;
  setDraft: (v: string) => void;
  saving: boolean;
}

function NoteSection({
  icon,
  sideLabel,
  group,
  editing,
  onStartEdit,
  onCancel,
  onSave,
  draft,
  setDraft,
  saving,
}: NoteSectionProps) {
  const hasNotes = !!(group?.notes && group.notes.trim());
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--background)]">
      <div className="flex items-center gap-1.5 border-b border-[var(--border)]/60 px-2 py-1">
        <span className="text-xs">{icon}</span>
        <span className="text-[10px] font-medium text-[var(--muted-foreground)]">
          {sideLabel}
        </span>
        {group && (
          <span
            className="truncate text-[11px] font-medium"
            title={group.groupTitle}
          >
            {group.groupTitle}
          </span>
        )}
        {!editing && group && (
          <button
            type="button"
            onClick={onStartEdit}
            className="ml-auto shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--primary)] hover:bg-[var(--bg-secondary)]"
          >
            {hasNotes ? "編輯" : "新增"}
          </button>
        )}
      </div>
      <div className="px-2 py-1.5">
        {!group ? (
          <div className="text-[11px] italic text-[var(--muted-foreground)]">
            尚未選取審核項目
          </div>
        ) : editing ? (
          <>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="寫下這個群組的備註,例如客戶名稱、應對重點、合規注意事項..."
              rows={4}
              autoFocus
              disabled={saving}
              className="w-full rounded border border-[var(--input)] bg-[var(--background)] px-1.5 py-1 text-xs outline-none focus:ring-1 focus:ring-[var(--ring)] disabled:opacity-50"
            />
            <div className="mt-1 flex justify-end gap-1">
              <button
                type="button"
                onClick={onCancel}
                disabled={saving}
                className="rounded border border-[var(--border)] px-2 py-0.5 text-[10px] hover:bg-[var(--bg-secondary)] disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={onSave}
                disabled={saving}
                className="rounded bg-[var(--primary)] px-2 py-0.5 text-[10px] font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
              >
                {saving ? "儲存中…" : "儲存"}
              </button>
            </div>
          </>
        ) : (
          /* 備註框/文字本身就是編輯入口 — 點任意處進編輯,不需先按右上角
              的「編輯」鈕(那個鈕還是保留作為視覺提示)。Enter / Space
              透過 keyboard 也能觸發,維持鍵盤可達性。 */
          <div
            role="button"
            tabIndex={0}
            onClick={onStartEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onStartEdit();
              }
            }}
            title="點擊以編輯備註"
            className="-mx-1 -my-1 min-h-[2.5rem] cursor-pointer rounded px-1 py-1 transition-colors hover:bg-[var(--bg-secondary)]/40 hover:ring-1 hover:ring-[var(--primary)]/30 focus:outline-none focus:ring-1 focus:ring-[var(--primary)]/50"
          >
            {hasNotes ? (
              <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-[var(--foreground)]">
                {group.notes}
              </div>
            ) : (
              <div className="text-[11px] italic text-[var(--muted-foreground)]">
                尚無備註(點擊新增)
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
