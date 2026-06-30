"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, LogIn, Loader2, MessageSquare, X, User } from "lucide-react";

// localStorage 只存使用者名稱(最多 5 個,LRU)。密碼絕不存 — 由瀏覽器
// password manager 處理(form 已標 autoComplete=current-password)。
// 需要的話使用者點清單裡的帳號即填入 username,密碼欄 password manager 自動接管。
const RECENT_USERS_KEY = "switchboard_recent_users";
const RECENT_USERS_MAX = 5;

function loadRecentUsers(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_USERS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rememberUser(username: string) {
  if (typeof window === "undefined") return;
  const trimmed = username.trim();
  if (!trimmed) return;
  try {
    const current = loadRecentUsers().filter((u) => u !== trimmed);
    const next = [trimmed, ...current].slice(0, RECENT_USERS_MAX);
    localStorage.setItem(RECENT_USERS_KEY, JSON.stringify(next));
  } catch {
    // localStorage full / disabled → silently skip
  }
}

function forgetUser(username: string) {
  if (typeof window === "undefined") return;
  try {
    const next = loadRecentUsers().filter((u) => u !== username);
    localStorage.setItem(RECENT_USERS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

export default function LoginPage() {
  const router = useRouter();
  // 帳密欄用 UNCONTROLLED(ref 讀值)。controlled value/onChange 會跟手機 /
  // 密碼管理員的 silent autofill 衝突:iOS Keychain / 1Password 直接設 DOM
  // .value 而不觸發 onChange,導致 value={state}="" 把填入的密碼清掉、且
  // 送出按鈕卡在 disabled。讀 DOM 是 autofill-proof 的。
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [recentUsers, setRecentUsers] = useState<string[]>([]);
  // 僅用於最近帳號 pill 的高亮,不綁 input value。
  const [selectedUser, setSelectedUser] = useState("");

  useEffect(() => {
    const list = loadRecentUsers();
    setRecentUsers(list);
    if (list.length > 0 && usernameRef.current && !usernameRef.current.value) {
      usernameRef.current.value = list[0];
      setSelectedUser(list[0]);
    }
  }, []);

  function handlePickUser(u: string) {
    if (usernameRef.current) usernameRef.current.value = u;
    setSelectedUser(u);
    setError("");
    queueMicrotask(() => passwordRef.current?.focus());
  }

  function handleForgetUser(e: React.MouseEvent, u: string) {
    e.stopPropagation();
    forgetUser(u);
    setRecentUsers((prev) => prev.filter((x) => x !== u));
    if (usernameRef.current?.value === u) {
      usernameRef.current.value = "";
      setSelectedUser("");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const username = usernameRef.current?.value.trim() ?? "";
    const password = passwordRef.current?.value ?? "";
    if (!username || !password) {
      setError("請輸入帳號和密碼");
      return;
    }
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (res.ok) {
        rememberUser(username);
        // 「直面對話」為核心 (IA 收斂): if /api/auth/me yields a sensible
        // target workspace (switchboard_last_workspace cookie hits a member ws,
        // or the user only has one ws), skip the picker and land on
        // /workspace/<id>/direct-chat directly. Multi-workspace users still
        // see the picker.
        let target = "/workspace";
        try {
          const meRes = await fetch("/api/auth/me");
          if (meRes.ok) {
            const me = await meRes.json();
            const wsList: Array<{ id: string }> = me?.user?.workspaces ?? [];
            const lastWs = document.cookie
              .split("; ")
              .find((c) => c.startsWith("switchboard_last_workspace="))
              ?.split("=")[1];
            const wsIds = new Set(wsList.map((w) => w.id));
            const picked =
              lastWs && wsIds.has(lastWs)
                ? lastWs
                : wsList.length === 1
                  ? wsList[0].id
                  : null;
            if (picked) target = `/workspace/${picked}/direct-chat`;
          }
        } catch {
          // /me failed — silently fall back to the picker
        }
        router.push(target);
        router.refresh();
        return;
      }

      const data = await res.json();
      setError(data.error || "登入失敗，請檢查帳號密碼");
      setLoading(false);
    } catch {
      setError("網路連線錯誤，請稍後再試");
      setLoading(false);
    }
  }

  return (
    // Warm editorial layout — flat cream surface, generous whitespace,
    // serif headline, single terracotta accent (the primary button + the
    // focused input outline). No gradient mesh, no scale animation, no
    // colored shadow stacks.
    <div className="flex min-h-dvh items-center justify-center bg-[var(--bg-primary)] px-6 py-16">
      <div className="w-full max-w-[400px]">
        {/* Editorial brand block — eyebrow label + serif wordmark + tagline.
            Mark icon kept as a small flat square; no shadow ring. */}
        <div className="mb-12 text-center">
          <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-md bg-[var(--accent)]">
            <MessageSquare className="size-6 text-white" strokeWidth={2} />
          </div>
          <p className="ui-label mb-2 text-[var(--text-muted)]">
            Workspace
          </p>
          <h1 className="font-serif text-[42px] leading-[1.1] tracking-[-0.02em] text-[var(--text-primary)]">
            Switchboard
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-[var(--text-secondary)]">
            全通路客戶互動平台
          </p>
        </div>

        {/* Form card — bg-secondary lift, no border by default, no shadow.
            Padding generous so the form feels read-not-data-entered. */}
        <div className="rounded-lg bg-[var(--bg-secondary)] p-8">
          <div className="mb-7">
            <h2 className="font-serif text-[22px] font-medium tracking-[-0.015em] text-[var(--text-primary)]">
              歡迎回來
            </h2>
            <p className="mt-1.5 text-[14px] text-[var(--text-secondary)]">
              請輸入您的帳號和密碼以登入系統。
            </p>
          </div>

          {/* Recent users — quick-pick. Pills are flat: 1px border, no fill;
              active state replaces the fill with a soft terracotta wash. */}
          {recentUsers.length > 0 && (
            <div className="mb-6">
              <p className="ui-label mb-2.5 text-[var(--text-muted)]">
                最近登入的帳號
              </p>
              <div className="flex flex-wrap gap-1.5">
                {recentUsers.map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => handlePickUser(u)}
                    className={`group inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                      selectedUser === u
                        ? "border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--accent)]"
                        : "border-[var(--border)] bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    <User className="size-3" />
                    <span>{u}</span>
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={`忘記 ${u}`}
                      onClick={(e) => handleForgetUser(e, u)}
                      className="ml-0.5 rounded-sm p-0.5 opacity-50 transition-opacity hover:opacity-100"
                    >
                      <X className="size-3" />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Username */}
            <div className="space-y-1.5">
              <label
                htmlFor="username"
                className="block text-[13px] font-medium text-[var(--text-primary)]"
              >
                帳號
              </label>
              <input
                id="username"
                name="username"
                type="text"
                ref={usernameRef}
                defaultValue=""
                onInput={() => setSelectedUser("")}
                placeholder="請輸入帳號"
                required
                autoComplete="username"
                autoFocus
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3.5 py-2.5 text-[15px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
              />
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <label
                htmlFor="password"
                className="block text-[13px] font-medium text-[var(--text-primary)]"
              >
                密碼
              </label>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  ref={passwordRef}
                  defaultValue=""
                  placeholder="請輸入密碼"
                  required
                  autoComplete="current-password"
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3.5 py-2.5 pr-11 text-[15px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-sm p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                  tabIndex={-1}
                  aria-label={showPassword ? "隱藏密碼" : "顯示密碼"}
                >
                  {showPassword ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
              </div>
            </div>

            {/* Error — flat danger surface, no rounded-2xl bubble */}
            {error && (
              <div className="animate-slide-in-top flex items-start gap-2 rounded-md border-l-2 border-[var(--danger)] bg-[var(--bg-primary)] px-3 py-2.5 text-[13px] text-[var(--danger)]">
                <svg
                  className="mt-0.5 size-4 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <span>{error}</span>
              </div>
            )}

            {/* Primary button — terracotta fill, cream text, 6px radius,
                no shadow, no scale-on-active. Hover darkens the fill. */}
            <button
              type="submit"
              disabled={loading}
              className="relative w-full rounded-md bg-[var(--accent)] px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:pointer-events-none disabled:opacity-50"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  登入中…
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  <LogIn className="size-4" />
                  登入系統
                </span>
              )}
            </button>
          </form>
        </div>

        {/* Footer — sentence-cased, period at the end (design prompt §7).
            Tracked-out small caps for a magazine masthead feel. */}
        <p className="ui-label mt-8 text-center text-[var(--text-muted)]">
          Switchboard v2.0 · 安全加密連線
        </p>
      </div>
    </div>
  );
}