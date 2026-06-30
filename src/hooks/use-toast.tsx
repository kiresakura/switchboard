"use client";

/**
 * UI feedback primitives — toast 通知 + confirm 對話框。
 *
 * 取代分散在各頁面的 `alert()` / `confirm()` 原生對話框,讓回饋符合產品
 * 風格(支援 dark mode、動畫、主品牌色),且 confirm 走 Promise-based
 * API 不阻塞主執行緒。
 *
 * 新 API(推薦):
 *   const { toast, confirm } = useToast();
 *   toast.success("已儲存");
 *   toast.error("操作失敗", { title: "錯誤" });
 *   if (await confirm({ message: "確定刪除?", danger: true })) { ... }
 *
 * 舊 API(向後相容,保留給 bug-report-button 等既有 callsites):
 *   toast({ title: "...", description: "...", variant: "default" | "destructive" });
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CheckCircle, AlertCircle, Info, AlertTriangle, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ──────────────────────────────────────────────

type ToastVariant = "default" | "destructive" | "success" | "error" | "warning" | "info";

interface ToastEntry {
  id: string;
  variant: ToastVariant;
  title?: string;
  description?: string;
  /** 自動消失毫秒數(0 = 永不) */
  duration: number;
}

interface ToastLegacyArgs {
  title?: string;
  description?: string;
  variant?: "default" | "destructive";
}

interface ToastOpts {
  title?: string;
  duration?: number;
}

/**
 * `toast` 是個 callable 物件:既能 `toast({ title, description })`(舊),
 * 也能 `toast.success("...")` / `toast.error("...")` 等(新)。
 */
interface ToastFn {
  (args: ToastLegacyArgs): void;
  success: (message: string, opts?: ToastOpts) => void;
  error: (message: string, opts?: ToastOpts) => void;
  warning: (message: string, opts?: ToastOpts) => void;
  info: (message: string, opts?: ToastOpts) => void;
}

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** 危險操作 → 確認鈕變紅 */
  danger?: boolean;
}

interface ToastContextValue {
  toast: ToastFn;
  /** Legacy API for direct DOM re-render lookups (bug-report-button uses this) */
  toasts: ToastEntry[];
  removeToast: (id: string) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

// ─── Variant styles ─────────────────────────────────────

const VARIANT_STYLES: Record<
  ToastVariant,
  { container: string; icon: string; Icon: typeof CheckCircle }
> = {
  default: {
    container:
      "border-[var(--border)] bg-[var(--card)] text-[var(--foreground)]",
    icon: "text-[var(--muted-foreground)]",
    Icon: Info,
  },
  destructive: {
    container: "border-red-500/30 bg-red-50 dark:bg-red-950/40",
    icon: "text-red-600 dark:text-red-400",
    Icon: AlertCircle,
  },
  success: {
    container: "border-green-500/30 bg-green-50 dark:bg-green-950/40",
    icon: "text-green-600 dark:text-green-400",
    Icon: CheckCircle,
  },
  error: {
    container: "border-red-500/30 bg-red-50 dark:bg-red-950/40",
    icon: "text-red-600 dark:text-red-400",
    Icon: AlertCircle,
  },
  warning: {
    container: "border-orange-500/30 bg-orange-50 dark:bg-orange-950/40",
    icon: "text-orange-600 dark:text-orange-400",
    Icon: AlertTriangle,
  },
  info: {
    container: "border-blue-500/30 bg-blue-50 dark:bg-blue-950/40",
    icon: "text-blue-600 dark:text-blue-400",
    Icon: Info,
  },
};

// ─── Provider ───────────────────────────────────────────

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [confirmState, setConfirmState] = useState<
    | (ConfirmOptions & { resolve: (v: boolean) => void })
    | null
  >(null);
  const [mounted, setMounted] = useState(false);

  // React 19 / Next.js hydration requires the first client render to match the
  // server markup exactly. Creating a portal during that first render injects a
  // client-only <div> where the server stream still has Next script markers,
  // causing hydration error #418. Defer the portal until after hydration.
  useEffect(() => {
    setMounted(true);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (variant: ToastVariant, args: { title?: string; description?: string; duration?: number }) => {
      const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const duration =
        args.duration ?? (variant === "destructive" || variant === "error" ? 6000 : 3500);
      setToasts((prev) => [...prev, { id, variant, ...args, duration }]);
      if (duration > 0) {
        setTimeout(() => removeToast(id), duration);
      }
    },
    [removeToast],
  );

  // Build the callable + properties toast object.
  const toastFn = useCallback(
    (args: ToastLegacyArgs) =>
      push(args.variant ?? "default", { title: args.title, description: args.description }),
    [push],
  ) as ToastFn;
  toastFn.success = (message, opts) =>
    push("success", { description: message, title: opts?.title, duration: opts?.duration });
  toastFn.error = (message, opts) =>
    push("error", { description: message, title: opts?.title, duration: opts?.duration });
  toastFn.warning = (message, opts) =>
    push("warning", { description: message, title: opts?.title, duration: opts?.duration });
  toastFn.info = (message, opts) =>
    push("info", { description: message, title: opts?.title, duration: opts?.duration });

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setConfirmState({ ...opts, resolve });
      }),
    [],
  );

  const closeConfirm = useCallback(
    (result: boolean) => {
      if (confirmState) {
        confirmState.resolve(result);
        setConfirmState(null);
      }
    },
    [confirmState],
  );

  // Esc 取消、Enter 確定
  useEffect(() => {
    if (!confirmState) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeConfirm(false);
      else if (e.key === "Enter") closeConfirm(true);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmState, closeConfirm]);

  return (
    <ToastContext.Provider value={{ toast: toastFn, toasts, removeToast, confirm }}>
      {children}
      {mounted &&
        createPortal(
          <>
            {/* Toast stack — 右下角(舊版在右上,改右下避免擋 sidebar/header) */}
            <div className="pointer-events-none fixed bottom-4 right-4 z-[2000] flex flex-col gap-2 max-w-[calc(100vw-2rem)]">
              {toasts.map((t) => {
                const style = VARIANT_STYLES[t.variant];
                const Icon = style.Icon;
                return (
                  <div
                    key={t.id}
                    role="status"
                    className={cn(
                      "pointer-events-auto flex w-[320px] max-w-full items-start gap-3 rounded-xl border p-3 shadow-lg backdrop-blur",
                      "animate-[slide-in-from-right_180ms_ease-out]",
                      style.container,
                    )}
                  >
                    <Icon className={cn("size-5 shrink-0 mt-0.5", style.icon)} />
                    <div className="flex-1 space-y-0.5 min-w-0">
                      {t.title && (
                        <p className="text-sm font-semibold text-[var(--foreground)]">
                          {t.title}
                        </p>
                      )}
                      {t.description && (
                        <p className="text-sm text-[var(--foreground)] break-words">
                          {t.description}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label="關閉"
                      onClick={() => removeToast(t.id)}
                      className="shrink-0 rounded-md p-1 text-[var(--muted-foreground)] hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Confirm dialog */}
            {confirmState && (
              <div
                className="fixed inset-0 z-[2100] flex items-center justify-center bg-black/40 p-4 animate-[fade-in_120ms_ease-out]"
                onClick={() => closeConfirm(false)}
              >
                <div
                  role="alertdialog"
                  aria-modal="true"
                  className="w-full max-w-[420px] rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-2xl animate-[scale-in_140ms_ease-out]"
                  onClick={(e) => e.stopPropagation()}
                >
                  {confirmState.title && (
                    <h2 className="text-base font-semibold text-[var(--foreground)]">
                      {confirmState.title}
                    </h2>
                  )}
                  <p className="mt-2 text-sm text-[var(--muted-foreground)] whitespace-pre-line">
                    {confirmState.message}
                  </p>
                  <div className="mt-5 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => closeConfirm(false)}
                      className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--bg-secondary)]"
                    >
                      {confirmState.cancelText ?? "取消"}
                    </button>
                    <button
                      type="button"
                      autoFocus
                      onClick={() => closeConfirm(true)}
                      className={cn(
                        "rounded-lg px-4 py-2 text-sm font-semibold text-white",
                        confirmState.danger
                          ? "bg-[var(--destructive)] hover:brightness-110"
                          : "bg-[var(--primary)] hover:brightness-110",
                      )}
                    >
                      {confirmState.confirmText ?? "確定"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return ctx;
}
