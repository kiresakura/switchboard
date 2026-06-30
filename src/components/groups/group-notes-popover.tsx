"use client";

/**
 * GroupNotesPopover — small inline editor for Group.notes that can be embedded
 * anywhere in the app (review queue, pairing detail, chat headers etc.) so
 * operators don't have to context-switch to 群組管理 just to read or amend
 * a per-group note.
 *
 * Behaviour:
 *   - Closed state: a small icon button. If notes is set, the icon shows a
 *     filled background hint + a 1-line preview tooltip on hover.
 *   - Open state: portal-rendered popover anchored to the trigger button.
 *     Read mode shows the full notes (or「尚無備註」placeholder); 編輯 button
 *     swaps to a textarea with 儲存 / 取消.
 *   - Save → PATCH /api/workspaces/:wsId/groups/:gid { notes }, optimistically
 *     updates local state, calls onSaved so caller can keep its copy in sync.
 *   - Failures surface via useToast.
 *
 * Caller controls visibility/permission externally — pass canEdit=false to
 * render a read-only popover (still useful: shows the notes without leaving
 * the page).
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { StickyNote, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

interface Props {
  workspaceId: string;
  groupId: string;
  groupTitle: string;
  initialNotes: string | null;
  canEdit: boolean;
  /** Optional label shown next to the icon (e.g.「來源群備註」) */
  label?: string;
  /** Called after a successful save with the new notes value */
  onSaved?: (notes: string | null) => void;
}

export function GroupNotesPopover({
  workspaceId,
  groupId,
  groupTitle,
  initialNotes,
  canEdit,
  label,
  onSaved,
}: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<string | null>(initialNotes);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // 跟著 prop 變動更新本地 state(若父層 re-fetch 拿到新 notes)。
  useEffect(() => {
    setNotes(initialNotes);
  }, [initialNotes]);

  useEffect(() => {
    if (!open) return;
    function place() {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const W = 320;
      // 預設展開在按鈕下方;靠近右邊緣時靠右,靠近底端時改向上展開
      let left = r.left;
      if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8;
      let top = r.bottom + 4;
      const estimatedH = editing ? 220 : 140;
      if (top + estimatedH > window.innerHeight - 8) {
        top = Math.max(8, r.top - estimatedH - 4);
      }
      setPos({ top, left });
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, editing]);

  // 點 popover 外部關閉
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
      setEditing(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setEditing(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const hasNotes = !!(notes && notes.trim());

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/groups/${groupId}`,
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
      setNotes(newNotes);
      setEditing(false);
      onSaved?.(newNotes);
      toast.success("備註已儲存");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (!open) {
            setDraft(notes ?? "");
            setEditing(false);
          }
          setOpen((v) => !v);
        }}
        title={
          hasNotes
            ? `${label ?? "備註"}:${notes!.slice(0, 80)}${notes!.length > 80 ? "…" : ""}`
            : `${label ?? "備註"}(尚未填寫)`
        }
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors",
          hasNotes
            ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/15"
            : "border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--bg-secondary)]",
        )}
      >
        <StickyNote className="size-3" />
        {label ?? "備註"}
        {hasNotes && <span className="size-1 rounded-full bg-amber-500" />}
      </button>

      {open && pos && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[1500] w-[320px] rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-xl animate-[scale-in_120ms_ease-out]"
            style={{ top: pos.top, left: pos.left }}
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] uppercase tracking-wider text-[var(--muted-foreground)]">
                  {label ?? "群組備註"}
                </div>
                <div className="truncate text-sm font-medium" title={groupTitle}>
                  {groupTitle}
                </div>
              </div>
              <button
                type="button"
                aria-label="關閉"
                onClick={() => {
                  setOpen(false);
                  setEditing(false);
                }}
                className="ml-2 rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-secondary)]"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="px-3 py-2.5">
              {editing ? (
                <>
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="寫下這個群組的備註,例如客戶名稱、應對重點、合規注意事項..."
                    rows={6}
                    autoFocus
                    disabled={saving}
                    className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-50"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      disabled={saving}
                      className="rounded border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={save}
                      disabled={saving}
                      className="rounded bg-[var(--primary)] px-2.5 py-1 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
                    >
                      {saving ? "儲存中…" : "儲存"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {/* 整個備註內容區塊都是編輯入口 — 點(或鍵盤 Enter / Space)
                      就直接進編輯,不必再去按下面的「編輯備註」鈕。鈕保留
                      作為視覺提示。 */}
                  {canEdit ? (
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setDraft(notes ?? "");
                        setEditing(true);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setDraft(notes ?? "");
                          setEditing(true);
                        }
                      }}
                      title="點擊以編輯備註"
                      className="-mx-1 -my-1 min-h-[3rem] cursor-pointer rounded px-1 py-1 transition-colors hover:bg-[var(--bg-secondary)]/40 hover:ring-1 hover:ring-[var(--primary)]/30 focus:outline-none focus:ring-1 focus:ring-[var(--primary)]/50"
                    >
                      {hasNotes ? (
                        <div className="whitespace-pre-wrap break-words text-sm text-[var(--foreground)] max-h-60 overflow-y-auto">
                          {notes}
                        </div>
                      ) : (
                        <div className="text-sm italic text-[var(--muted-foreground)]">
                          尚無備註(點擊新增)
                        </div>
                      )}
                    </div>
                  ) : hasNotes ? (
                    <div className="whitespace-pre-wrap break-words text-sm text-[var(--foreground)] max-h-60 overflow-y-auto">
                      {notes}
                    </div>
                  ) : (
                    <div className="text-sm italic text-[var(--muted-foreground)]">
                      尚無備註
                    </div>
                  )}
                  {canEdit && (
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          setDraft(notes ?? "");
                          setEditing(true);
                        }}
                        className="rounded border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--primary)] hover:bg-[var(--bg-secondary)]"
                      >
                        {hasNotes ? "編輯備註" : "新增備註"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
