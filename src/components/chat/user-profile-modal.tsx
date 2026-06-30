"use client";

import { useEffect, useState } from "react";
import { X, User, AtSign, Users, Phone, Circle } from "lucide-react";

export type UserStatus = {
  kind: "online" | "offline" | "recently" | "lastWeek" | "lastMonth" | "hidden";
  onlineUntil?: string;
  lastSeenAt?: string;
};

export type Profile = {
  platformUserId: string;
  displayName: string;
  username?: string;
  bio?: string;
  phone?: string;
  status?: UserStatus;
  accounts: {
    accountId: string;
    accountName: string;
    sharedGroups: { id: string; title: string }[];
  }[];
};

/** P2 last seen status 顯示字串。relativeMinutes 是「上次在線距現在多久」相對描述。 */
export function formatUserStatus(status: UserStatus | undefined): {
  label: string;
  tone: "online" | "muted";
} {
  if (!status) return { label: "上線狀態未知", tone: "muted" };
  if (status.kind === "online") return { label: "上線中", tone: "online" };
  if (status.kind === "hidden") return { label: "對方已隱藏上線狀態", tone: "muted" };
  if (status.kind === "recently") return { label: "最近上線過", tone: "muted" };
  if (status.kind === "lastWeek") return { label: "一週內上線過", tone: "muted" };
  if (status.kind === "lastMonth") return { label: "一個月內上線過", tone: "muted" };
  if (status.kind === "offline") {
    if (!status.lastSeenAt) return { label: "離線中", tone: "muted" };
    const ts = new Date(status.lastSeenAt);
    const diffMs = Date.now() - ts.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return { label: "剛剛在線", tone: "muted" };
    if (diffMin < 60) return { label: `${diffMin} 分鐘前在線`, tone: "muted" };
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return { label: `${diffHr} 小時前在線`, tone: "muted" };
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return { label: `${diffDay} 天前在線`, tone: "muted" };
    return {
      label: `上次在線:${ts.toLocaleString("zh-TW", { dateStyle: "short" })}`,
      tone: "muted",
    };
  }
  return { label: "上線狀態未知", tone: "muted" };
}

/**
 * 點擊使用者名稱彈窗：顯示 TG 個人資料 + 我們Telegram 帳號中各帳號跟此用戶的共同群。
 *
 * 用法：在父元件保留 state `clickedUserId`，點 sender 名字 → setClickedUserId(id)，
 * 渲染 <UserProfileModal workspaceId={...} platformUserId={clickedUserId} onClose={() => setClickedUserId(null)} />
 */
export function UserProfileModal({
  workspaceId,
  platformUserId,
  onClose,
}: {
  workspaceId: string;
  platformUserId: string;
  onClose: () => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  // 預設 loading=true（init state）→ 進到 effect 才不必 setLoading(true) 觸發二次 render
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(
      `/api/workspaces/${workspaceId}/users/profile?platformUserId=${encodeURIComponent(
        platformUserId,
      )}`,
    )
      .then(async (r) => {
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.error || "載入失敗");
        }
        return r.json();
      })
      .then((d) => {
        if (!cancelled) setProfile(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, platformUserId]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-xl"
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <h3 className="text-base font-semibold text-[var(--foreground)]">
            使用者資料
          </h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-secondary)]"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="p-4 space-y-4">
          {loading && (
            <div className="text-sm text-[var(--muted-foreground)]">載入中…</div>
          )}
          {error && (
            <div className="text-sm text-red-600">載入失敗：{error}</div>
          )}
          {profile && !loading && (
            <>
              {/* 個人資料 */}
              <section className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <User className="size-4 text-[var(--muted-foreground)]" />
                  <span className="text-base font-semibold">
                    {profile.displayName}
                  </span>
                </div>
                {profile.username && (
                  <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                    <AtSign className="size-3" />
                    <span>@{profile.username}</span>
                  </div>
                )}
                {/* P2: last seen / online status — TG 對方上線狀態 */}
                {(() => {
                  const { label, tone } = formatUserStatus(profile.status);
                  return (
                    <div
                      className={`flex items-center gap-1.5 text-xs ${
                        tone === "online"
                          ? "text-[var(--success)]"
                          : "text-[var(--muted-foreground)]"
                      }`}
                    >
                      <Circle
                        className={`size-2 ${
                          tone === "online" ? "fill-current" : "opacity-50"
                        }`}
                      />
                      <span>{label}</span>
                    </div>
                  );
                })()}
                {/* P2: phone (對方公開 phone privacy 時才有) */}
                {profile.phone && (
                  <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                    <Phone className="size-3" />
                    <a
                      href={`tel:${profile.phone}`}
                      className="hover:underline"
                    >
                      {profile.phone}
                    </a>
                  </div>
                )}
                <div className="text-[10px] text-[var(--muted-foreground)]">
                  TG ID：{profile.platformUserId}
                </div>
                {profile.bio && (
                  <div className="mt-2 rounded-md border border-[var(--border)] bg-[var(--background)] p-2 text-xs text-[var(--foreground)] whitespace-pre-wrap">
                    {profile.bio}
                  </div>
                )}
              </section>

              {/* 共同群 */}
              <section>
                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--muted-foreground)]">
                  <Users className="size-3" />
                  與此用戶的共同群（依本系統Telegram 帳號）
                </div>
                {profile.accounts.length === 0 ? (
                  <div className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-xs text-[var(--muted-foreground)]">
                    沒有任何 Telegram 帳號跟此用戶有共同群。
                  </div>
                ) : (
                  <div className="space-y-2">
                    {profile.accounts.map((a) => (
                      <div
                        key={a.accountId}
                        className="rounded-md border border-[var(--border)] bg-[var(--background)] p-2"
                      >
                        <div className="text-xs font-medium text-[var(--foreground)]">
                          {a.accountName}
                        </div>
                        <ul className="mt-1 space-y-0.5">
                          {a.sharedGroups.map((g) => (
                            <li
                              key={g.id}
                              className="text-[11px] text-[var(--muted-foreground)] truncate"
                            >
                              · {g.title}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
