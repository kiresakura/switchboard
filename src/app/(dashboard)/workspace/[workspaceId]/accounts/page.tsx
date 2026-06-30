"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { Pencil, Check, X, Info } from "lucide-react";
import { safeTitle } from "@/lib/utils";
import { PageHeader } from "@/components/ui/section";
import { useToast } from "@/hooks/use-toast";

type Account = {
  id: string;
  displayName: string | null;  // 自訂暱稱（可選；未設定時 UI fallback 用 TG 名稱）
  phoneNumber: string | null;
  status: string;
  platform: string;
  telegramFirstName?: string | null;
  telegramLastName?: string | null;
  telegramUsername?: string | null;
  _count: { groupMemberships: number };
};

/**
 * 取得帳號顯示名稱：自訂暱稱 → TG 名稱 → 電話 → 「(未命名)」
 * 用於 UI 顯示及編輯預設值
 */
function getAccountLabel(a: Pick<Account, "displayName" | "telegramFirstName" | "telegramLastName" | "phoneNumber">): string {
  if (a.displayName?.trim()) return a.displayName;
  const tgName = [a.telegramFirstName, a.telegramLastName].filter(Boolean).join(" ").trim();
  if (tgName) return tgName;
  if (a.phoneNumber) return a.phoneNumber;
  return "(未命名)";
}

const STATUS_LABELS: Record<string, string> = {
  PENDING_AUTH: "待驗證",
  ACTIVE: "已連線",
  DISCONNECTED: "已斷線",
  AUTH_ERROR: "驗證失敗",
  DISABLED: "已停用",
};

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "text-[var(--approve)]",
  PENDING_AUTH: "text-amber-500 dark:text-amber-400",
  DISCONNECTED: "text-orange-500 dark:text-orange-400",
  AUTH_ERROR: "text-[var(--destructive)]",
  DISABLED: "text-[var(--muted-foreground)]",
};

type AuthStep =
  | "idle"
  | "phone"
  | "code"
  | "2fa"
  | "select-groups"
  | "done"
  | "session";

type DiscoveredGroup = {
  id: string;          // platformGroupId（TG chat ID）— 也是註冊時用來上傳的 key
  title: string;
  chatType: string;
  accountId: string;   // 該對話來自哪個 Telegram 帳號（registry 註冊時需要）
  isNew?: boolean;
  isReactivatable?: boolean;
  isCurrentlyListening?: boolean;
  wasPreviouslyPaired?: boolean;
  wasPreviouslyHidden?: boolean;
};

/** 2026-05-21 Batch 4 — 一個 TG 帳號的某個已登入裝置 / session。 */
type DeviceAuth = {
  hash: string;
  deviceModel: string;
  platform: string;
  systemVersion: string;
  appName: string;
  appVersion: string;
  dateCreated: number;
  dateActive: number;
  ip: string;
  country: string;
  region: string;
  isCurrent: boolean;
  isOfficialApp: boolean;
  isPasswordPending: boolean;
};

export default function AccountsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const { confirm } = useToast();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ displayName: "", phoneNumber: "", apiId: "", apiHash: "" });
  const [error, setError] = useState("");

  // Auth flow state
  const [authAccountId, setAuthAccountId] = useState<string | null>(null);
  const [authStep, setAuthStep] = useState<AuthStep>("idle");
  const [authPhone, setAuthPhone] = useState("");
  const [authApiId, setAuthApiId] = useState("");
  const [authApiHash, setAuthApiHash] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [pendingAuthId, setPendingAuthId] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [authMockMode, setAuthMockMode] = useState(false);
  const [discoveredGroups, setDiscoveredGroups] = useState<DiscoveredGroup[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());

  // Batch 4 — Session 字串登入(authApiId / authApiHash 沿用上方既有 state)
  const [authSessionString, setAuthSessionString] = useState("");

  // Batch 4 — 多裝置監測(裝置列表 modal)
  const [devicesAccountId, setDevicesAccountId] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceAuth[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState("");
  const [kickingHash, setKickingHash] = useState<string | null>(null);

  // 「發送驗證碼」按鈕的 30 秒冷卻計時，避免使用者連點觸發 TG flood / 重複發送
  const [sendCooldown, setSendCooldown] = useState(0);

  // 進入 "phone" step 時自動啟動 30 秒倒數
  useEffect(() => {
    if (authStep === "phone") {
      setSendCooldown(30);
    }
  }, [authStep]);

  // 倒數計時 tick
  useEffect(() => {
    if (sendCooldown <= 0) return;
    const timer = setTimeout(() => setSendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(timer);
  }, [sendCooldown]);

  // Inline displayName edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);

  const fetchAccounts = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/accounts`);
    if (res.ok) {
      const data = await res.json();
      setAccounts(data.accounts);
    }
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // 防呆：accounts 列表刷新後，如果驗證流程中的帳號 id 已不存在
  // （例如被另一個 tab 刪掉、或本地刪除沒走 handleDelete），自動關閉殘留 dialog
  useEffect(() => {
    if (authAccountId && accounts.length > 0 && !accounts.some((a) => a.id === authAccountId)) {
      setAuthAccountId(null);
      setAuthStep("idle");
      setDiscoveredGroups([]);
      setSelectedGroupIds(new Set());
    }
  }, [accounts, authAccountId]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    // Step 1: Create account
    const res = await fetch(`/api/workspaces/${workspaceId}/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: form.displayName,
        phoneNumber: form.phoneNumber,
      }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "新增失敗");
      return;
    }

    const accountData = await res.json();
    const newAccountId = accountData.account?.id;

    // Step 2: Auto-start auth if API credentials were provided
    if (newAccountId && form.apiId.trim() && form.apiHash.trim()) {
      setAuthAccountId(newAccountId);
      setAuthPhone(form.phoneNumber);
      setAuthApiId(form.apiId.trim());
      setAuthApiHash(form.apiHash.trim());
      setAuthStep("phone");
      const phoneSnapshot = form.phoneNumber;
      const apiIdSnapshot = form.apiId.trim();
      const apiHashSnapshot = form.apiHash.trim();
      setForm({ displayName: "", phoneNumber: "", apiId: "", apiHash: "" });
      setShowAdd(false);
      fetchAccounts();
      // Auto-submit the auth (send verification code)
      try {
        const authRes = await fetch(
          `/api/workspaces/${workspaceId}/accounts/${newAccountId}/auth`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              phoneNumber: phoneSnapshot,
              apiId: apiIdSnapshot,
              apiHash: apiHashSnapshot,
            }),
          }
        );
        const authData = await authRes.json();
        if (authRes.ok) {
          setPendingAuthId(authData.pendingAuthId);
          setAuthMockMode(authData.mockMode || false);
          setAuthStep("code");
        } else {
          setAuthError(authData.error || "發送驗證碼失敗");
        }
      } catch {
        setAuthError("發送驗證碼時發生網路錯誤");
      }
    } else {
      setForm({ displayName: "", phoneNumber: "", apiId: "", apiHash: "" });
      setShowAdd(false);
      fetchAccounts();
    }
  }

  function startAuth(account: Account) {
    setAuthAccountId(account.id);
    setAuthPhone(account.phoneNumber || "");
    setAuthStep("phone");
    setAuthError("");
    setAuthCode("");
    setAuthPassword("");
  }

  // ─── Batch 4 — Session 字串登入 ──────────────────────────────
  function startSessionAuth(account: Account) {
    setAuthAccountId(account.id);
    setAuthStep("session");
    setAuthError("");
    setAuthSessionString("");
    setAuthApiId("");
    setAuthApiHash("");
  }

  async function handleSessionLogin(e: React.FormEvent) {
    e.preventDefault();
    setAuthError("");
    setAuthLoading(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/accounts/telegram/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountId: authAccountId,
            sessionString: authSessionString.trim(),
            apiId: authApiId.trim(),
            apiHash: authApiHash.trim(),
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || "Session 登入失敗");
        return;
      }
      setAuthAccountId(null);
      setAuthStep("idle");
      fetchAccounts();
    } catch {
      setAuthError("網路連線錯誤，請稍後再試");
    } finally {
      setAuthLoading(false);
    }
  }

  // ─── Batch 4 — 多裝置監測 ────────────────────────────────────
  async function fetchDevices(accountId: string) {
    setDevicesLoading(true);
    setDevicesError("");
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/accounts/${accountId}/authorizations`,
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDevicesError(data.error || "無法取得裝置列表");
        setDevices([]);
        return;
      }
      setDevices(Array.isArray(data.authorizations) ? data.authorizations : []);
      if (data.error) setDevicesError(data.error);
    } catch {
      setDevicesError("網路錯誤，無法取得裝置列表");
      setDevices([]);
    } finally {
      setDevicesLoading(false);
    }
  }

  function openDevices(accountId: string) {
    setDevicesAccountId(accountId);
    setDevices([]);
    setDevicesError("");
    fetchDevices(accountId);
  }

  function closeDevices() {
    setDevicesAccountId(null);
    setDevices([]);
    setDevicesError("");
    setKickingHash(null);
  }

  async function kickDevice(accountId: string, hash: string) {
    if (
      !(await confirm({
        message:
          "確定要遠端登出這個裝置？該裝置將立即從這個 Telegram 帳號登出。",
        danger: true,
      }))
    )
      return;
    setKickingHash(hash);
    setDevicesError("");
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/accounts/${accountId}/authorizations?hash=${encodeURIComponent(hash)}`,
        { method: "DELETE" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDevicesError(data.error || "登出裝置失敗");
        return;
      }
      fetchDevices(accountId);
    } catch {
      setDevicesError("網路錯誤，登出裝置失敗");
    } finally {
      setKickingHash(null);
    }
  }

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setAuthError("");
    setAuthLoading(true);

    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/accounts/${authAccountId}/auth`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phoneNumber: authPhone,
            apiId: authApiId.trim() || undefined,
            apiHash: authApiHash.trim() || undefined,
          }),
        }
      );

      const data = await res.json();

      if (!res.ok) {
        setAuthError(data.error || "發送失敗");
        return;
      }

      setPendingAuthId(data.pendingAuthId);
      setAuthMockMode(data.mockMode || false);
      setAuthStep("code");
    } catch {
      setAuthError("網路連線錯誤，請稍後再試");
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setAuthError("");
    setAuthLoading(true);

    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/accounts/${authAccountId}/auth`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "verify",
            pendingAuthId,
            code: authCode,
            password: authPassword || undefined,
          }),
        }
      );

      const data = await res.json();

      if (!res.ok) {
        setAuthError(data.error || "驗證失敗");
        return;
      }

      if (data.needs2FA) {
        setAuthStep("2fa");
        return;
      }

      if (data.success) {
        fetchAccounts();
        // Trigger group discovery then show selection
        setAuthStep("select-groups");
        setAuthLoading(true);
        try {
          // 呼叫 /groups/refresh（bridge discover-preview）抓 TG 對話列表。
          // bridge 內部 ensureConnected 會等 client 連線完成（最多 30 秒），
          // 所以前端不再需要 setTimeout 等待。
          const refreshRes = await fetch(`/api/workspaces/${workspaceId}/groups/refresh`);
          if (refreshRes.ok) {
            const rData = await refreshRes.json();
            type RawDiscovered = {
              platformGroupId: string;
              title: string;
              chatType: string;
              accountId: string;
              isNew?: boolean;
              isReactivatable?: boolean;
              isCurrentlyListening?: boolean;
              wasPreviouslyPaired?: boolean;
              wasPreviouslyHidden?: boolean;
            };
            const allChats: RawDiscovered[] = rData.groups || [];

            // 規格 2026-05-06:同步流程不處理私訊。私訊會被 bridge auto-register
            // 自動入庫,要不要監聽 / 隱藏改去群組管理頁面個別操作。
            const groupOrChannel = allChats.filter((g) => g.chatType !== "PRIVATE");
            const sortKey = (t: string) => (t === "GROUP" ? 0 : t === "CHANNEL" ? 1 : 2);
            const sorted = [...groupOrChannel].sort((a, b) => {
              const k = sortKey(a.chatType) - sortKey(b.chatType);
              if (k !== 0) return k;
              return a.title.localeCompare(b.title);
            });
            const groups: DiscoveredGroup[] = sorted.map((g) => ({
              id: g.platformGroupId,
              title: g.title,
              chatType: g.chatType,
              accountId: g.accountId,
              isNew: g.isNew,
              isReactivatable: g.isReactivatable,
              isCurrentlyListening: g.isCurrentlyListening,
              wasPreviouslyPaired: g.wasPreviouslyPaired,
              wasPreviouslyHidden: g.wasPreviouslyHidden,
            }));
            setDiscoveredGroups(groups);
            // 規格 2026-05-06 — 預設勾選由系統決定,使用者不能手動覆寫:
            //   情境 A:**workspace 完全沒同步歷史**(全部 isNew=true,
            //          DB 還沒有任何 group row)→ 預勾全部,初次設置一鍵搞定。
            //   情境 B:**已經有同步歷史**(至少一個 chat 在 DB 找得到)→
            //          只勾「之前配對過 wasPreviouslyPaired」AND「沒被使用者
            //          刻意隱藏 !wasPreviouslyHidden」的群組。典型情境:刪掉
            //          Telegram 帳號後重新加回,使用者期待「舊配對自動接回去,
            //          先前隱藏的維持隱藏」。
            const workspaceHasAnyHistory = groups.some((g) => !g.isNew);
            const presets = groups
              .filter((g) => {
                if (!workspaceHasAnyHistory) return true;
                if (g.wasPreviouslyHidden) return false;
                return !!g.wasPreviouslyPaired;
              })
              .map((g) => g.id);
            setSelectedGroupIds(new Set(presets));
          }
        } catch {
          // If discovery fails, skip to done
        }
        setAuthLoading(false);
      }
    } catch {
      setAuthError("網路連線錯誤，請稍後再試");
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleDelete(accountId: string) {
    if (!await confirm({ message: "確定要刪除此帳號？", danger: true })) return;

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/accounts/${accountId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "刪除失敗");
      }
    } catch {
      setError("刪除失敗，請檢查網路連線");
    } finally {
      // 若刪除的是目前驗證流程中的帳號，順便關掉「選擇要監聽的群組」dialog，
      // 避免顯示一個指向已刪除帳號的殘留畫面
      if (authAccountId === accountId) {
        setAuthAccountId(null);
        setAuthStep("idle");
        setDiscoveredGroups([]);
        setSelectedGroupIds(new Set());
      }
      fetchAccounts();
      // 帳號刪除會把孤兒群組軟刪除（isActive=false），影響 layout 警示計數
      router.refresh();
    }
  }

  function startEditName(account: Account) {
    setEditingId(account.id);
    // displayName 可能是 null（自訂暱稱沒填）→ 編輯框預設空字串
    setEditName(account.displayName ?? "");
    setTimeout(() => editInputRef.current?.focus(), 0);
  }

  function cancelEditName() {
    setEditingId(null);
    setEditName("");
  }

  async function saveEditName(accountId: string) {
    const trimmed = editName.trim();
    if (!trimmed) return;

    setEditLoading(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/accounts/${accountId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: trimmed }),
        }
      );
      if (res.ok) {
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === accountId ? { ...a, displayName: trimmed } : a
          )
        );
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "更新名稱失敗");
      }
    } catch {
      setError("更新名稱失敗，請檢查網路連線");
    } finally {
      setEditLoading(false);
      setEditingId(null);
      setEditName("");
    }
  }

  if (loading) {
    return (
      <div className="text-sm text-[var(--muted-foreground)]">載入中...</div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader
        title="Telegram 帳號"
        description="管理員工的 Telegram 帳號連線與設定 — 每個帳號代表一位員工在 Telegram 上的身分"
        actions={
          <button
            onClick={() => setShowAdd(showAdd ? false : true)}
            className="rounded-md bg-[var(--primary)] text-[var(--primary-foreground)] px-4 py-2 text-sm font-medium hover:opacity-90 flex items-center gap-2"
          >
            {showAdd ? "取消" : "新增 Telegram 帳號"}
          </button>
        }
      />

      {/* 提醒:帳號 = 員工在 TG 上的身分,直接代表員工本人發訊息。 */}
      <div className="flex items-start gap-3 rounded-lg border border-orange-500/30 bg-orange-500/5 px-4 py-3">
        <Info className="size-4 shrink-0 text-orange-600 mt-0.5" />
        <div className="space-y-1 text-xs text-orange-900 dark:text-orange-300">
          <p className="font-medium">提醒:這裡的每個帳號 = 一位員工在 Telegram 上的身分</p>
          <p className="text-orange-800/80 dark:text-orange-300/80">
            在 Switchboard 介面送出的訊息,對 TG 接收者來說等同員工本人親自發送。請確認登入的是員工自己的帳號,
            避免代發或拿他人帳號操作造成歸屬混淆。
          </p>
        </div>
      </div>

      {/* 新增帳號表單 — 一步到位:填完即自動開始驗證 */}
      {showAdd && (
        <form
          onSubmit={handleAdd}
          className="mb-6 space-y-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-4"
        >
          <input
            type="text"
            placeholder="自訂暱稱（可選）"
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
          />
          <input
            type="tel"
            placeholder="電話號碼（含國碼，例如：+886912345678）"
            value={form.phoneNumber}
            onChange={(e) => setForm({ ...form, phoneNumber: e.target.value })}
            required
            className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
          />
          <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/30 p-3 space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-xs font-medium">Telegram API 憑證</p>
              <a
                href="https://my.telegram.org/apps"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[var(--primary)] hover:underline"
              >
                尚未申請?點此建立 →
              </a>
            </div>
            <p className="text-[11px] text-[var(--muted-foreground)]">
              每個帳號都要用自己的手機號碼到 my.telegram.org 申請獨立的 App,
              填入該帳號專屬的 API ID 與 Hash。共用同一組會導致封號連鎖。
            </p>
            <input
              type="text"
              inputMode="numeric"
              placeholder="API ID(純數字,例如:12345678)"
              value={form.apiId}
              onChange={(e) => setForm({ ...form, apiId: e.target.value.replace(/[^0-9]/g, "") })}
              className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
            <input
              type="text"
              placeholder="API Hash(32 位英數字)"
              value={form.apiHash}
              onChange={(e) => setForm({ ...form, apiHash: e.target.value.trim() })}
              className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </div>
          {error && (
            <p className="text-sm text-[var(--destructive)]">{error}</p>
          )}
          <button
            type="submit"
            className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
          >
            新增並開始驗證
          </button>
        </form>
      )}

      {/* Auth flow dialog */}
      {authAccountId && authStep !== "idle" && (
        <div className="mb-6 rounded-lg border-2 border-[var(--primary)] bg-[var(--card)] p-4">
          <h3 className="mb-3 font-medium">Telegram 帳號驗證</h3>

          {authStep === "phone" && (
            <form onSubmit={handleSendCode} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
                  電話號碼（含國碼）
                </label>
                <input
                  type="tel"
                  value={authPhone}
                  onChange={(e) => setAuthPhone(e.target.value)}
                  required
                  disabled
                  placeholder="+886912345678"
                  className="w-full rounded-md border border-[var(--input)] bg-[var(--muted)]/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-70"
                />
              </div>
              <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/30 p-3 space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-xs font-medium">Telegram API 憑證(此帳號專用)</p>
                  <a
                    href="https://my.telegram.org/apps"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-[var(--primary)] hover:underline"
                  >
                    尚未申請?點此建立 →
                  </a>
                </div>
                <p className="text-[11px] text-[var(--muted-foreground)]">
                  每個 Telegram 帳號都應以**自己的**手機號碼登入 my.telegram.org,為此帳號建立獨立的 App,填入取得的 API ID 與 Hash。
                  共用一組憑證會造成其中一個帳號被封時全數連鎖失效。
                </p>
                <div>
                  <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
                    API ID(純數字)
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={authApiId}
                    onChange={(e) => setAuthApiId(e.target.value.replace(/[^0-9]/g, ""))}
                    disabled
                    placeholder="例:12345678"
                    className="w-full rounded-md border border-[var(--input)] bg-[var(--muted)]/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
                    API Hash(32 位英數字)
                  </label>
                  <input
                    type="text"
                    value={authApiHash}
                    onChange={(e) => setAuthApiHash(e.target.value.trim())}
                    disabled
                    placeholder="例:a1b2c3d4e5f6..."
                    className="w-full rounded-md border border-[var(--input)] bg-[var(--muted)]/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)] font-mono disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </div>
              </div>
              {authError && (
                <p className="text-sm text-[var(--destructive)]">{authError}</p>
              )}
              <p className="text-xs text-[var(--muted-foreground)]">
                電話與 API 憑證已鎖定，避免送出驗證後又被改動。需要修改請按「取消」重新開始。
              </p>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={authLoading || sendCooldown > 0}
                  className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {authLoading
                    ? "發送中..."
                    : sendCooldown > 0
                      ? `發送驗證碼（${sendCooldown}s）`
                      : "發送驗證碼"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthAccountId(null);
                    setAuthStep("idle");
                  }}
                  className="rounded-md border border-[var(--border)] px-4 py-2 text-sm"
                >
                  取消
                </button>
              </div>
            </form>
          )}

          {authStep === "session" && (
            <form onSubmit={handleSessionLogin} className="space-y-3">
              <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
                貼上預先產生的 GramJS <strong>StringSession</strong> 字串直接登入，
                跳過手機驗證碼流程。適合手機 / 驗證碼登入不穩、或已在他處匯出
                session 的情況。
              </p>
              <div>
                <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
                  Session 字串
                </label>
                <textarea
                  value={authSessionString}
                  onChange={(e) => setAuthSessionString(e.target.value)}
                  required
                  rows={4}
                  placeholder="貼上 StringSession…"
                  className="w-full resize-y rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-[var(--ring)]"
                />
              </div>
              <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--muted)]/30 p-3">
                <p className="text-[11px] text-[var(--muted-foreground)]">
                  Session 字串必須搭配「產生它時所用的同一組」API ID / Hash，
                  否則 Telegram 會拒絕連線。
                </p>
                <div>
                  <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
                    API ID(純數字)
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={authApiId}
                    onChange={(e) =>
                      setAuthApiId(e.target.value.replace(/[^0-9]/g, ""))
                    }
                    required
                    placeholder="例:12345678"
                    className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
                    API Hash(32 位英數字)
                  </label>
                  <input
                    type="text"
                    value={authApiHash}
                    onChange={(e) => setAuthApiHash(e.target.value.trim())}
                    required
                    placeholder="例:a1b2c3d4e5f6..."
                    className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  />
                </div>
              </div>
              {authError && (
                <p className="text-sm text-[var(--destructive)]">{authError}</p>
              )}
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={authLoading}
                  className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
                >
                  {authLoading ? "驗證並連線中..." : "驗證並連線"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthAccountId(null);
                    setAuthStep("idle");
                  }}
                  className="rounded-md border border-[var(--border)] px-4 py-2 text-sm"
                >
                  取消
                </button>
              </div>
            </form>
          )}

          {authStep === "code" && (
            <form onSubmit={handleVerifyCode} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
                  驗證碼
                </label>
                <input
                  type="text"
                  value={authCode}
                  onChange={(e) => setAuthCode(e.target.value)}
                  required
                  placeholder="12345"
                  autoFocus
                  className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
                />
              </div>
              <p className="text-xs text-[var(--muted-foreground)]">
                請輸入 Telegram 發送到 {authPhone} 的驗證碼。
              </p>
              {authMockMode && (
                  <div className="rounded-md border border-[var(--primary)]/30 bg-[var(--primary)]/10 px-3 py-2">
                  <p className="text-xs font-medium text-[var(--primary)]">
                    模擬模式（未填 API ID/Hash 且系統也無環境變數）
                  </p>
                  <p className="text-xs text-[var(--primary)]/80">
                    請輸入 <strong>12345</strong> 完成模擬驗證
                  </p>
                </div>
              )}
              {authError && (
                <p className="text-sm text-[var(--destructive)]">{authError}</p>
              )}
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={authLoading}
                  className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
                >
                  {authLoading ? "驗證中..." : "確認驗證碼"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthAccountId(null);
                    setAuthStep("idle");
                  }}
                  className="rounded-md border border-[var(--border)] px-4 py-2 text-sm"
                >
                  取消
                </button>
              </div>
            </form>
          )}

          {authStep === "2fa" && (
            <form onSubmit={handleVerifyCode} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
                  兩步驗證密碼
                </label>
                <input
                  type="password"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  required
                  placeholder="Two-factor password"
                  autoFocus
                  className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
                />
              </div>
              <p className="text-xs text-[var(--muted-foreground)]">
                此帳號已啟用兩步驗證，請輸入 Telegram 兩步驗證密碼。
              </p>
              {authError && (
                <p className="text-sm text-[var(--destructive)]">{authError}</p>
              )}
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={authLoading}
                  className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
                >
                  {authLoading ? "驗證中..." : "確認密碼"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthAccountId(null);
                    setAuthStep("idle");
                  }}
                  className="rounded-md border border-[var(--border)] px-4 py-2 text-sm"
                >
                  取消
                </button>
              </div>
            </form>
          )}

          {authStep === "select-groups" && (
            <div className="space-y-3">
              <h4 className="font-medium text-sm">同步預覽（自動處理）</h4>
              <p className="text-xs text-[var(--muted-foreground)]">
                帳號已成功連線。下列是此帳號的群組與頻道(私訊不走同步流程)。
                預設規則:已配對過且未被隱藏的群組會啟用;其餘以隱藏狀態加入,
                之後可在群組管理頁逐一恢復。<strong className="text-[var(--foreground)]">本清單為唯讀</strong>。
              </p>
              {authLoading ? (
                <div className="text-sm text-[var(--muted-foreground)]">正在探索對話...</div>
              ) : discoveredGroups.length === 0 ? (
                <div className="text-sm text-[var(--muted-foreground)]">未發現任何群組或頻道。此帳號可能尚未加入任何 Telegram 群組。</div>
              ) : (
                <div className="space-y-2">
                  <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-3 py-2 text-xs text-[var(--muted-foreground)] leading-relaxed">
                    系統會自動判斷每個群組的同步狀態 — 已配對過的會接回、之前隱藏過的維持隱藏。
                    要納入或排除特定群組,確認同步後到「群組管理」頁面對個別群組按「隱藏 / 恢復」即可。
                  </div>
                  <div className="max-h-80 overflow-y-auto space-y-1">
                    {/* 排序:勾選的(會啟用)排最上方,未勾選的(會加入但隱藏)
                        往下沉,讓使用者一眼看到「實際會啟用什麼」。 */}
                    {[...discoveredGroups]
                      .sort((a, b) => {
                        const aSel = selectedGroupIds.has(a.id) ? 0 : 1;
                        const bSel = selectedGroupIds.has(b.id) ? 0 : 1;
                        if (aSel !== bSel) return aSel - bSel;
                        return 0;
                      })
                      .map((g) => (
                      <div
                        key={g.id}
                        className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors ${
                          selectedGroupIds.has(g.id)
                            ? "border-[var(--primary)] bg-[var(--primary)]/5"
                            : "border-[var(--border)] opacity-70"
                        }`}
                        title={
                          selectedGroupIds.has(g.id)
                            ? "系統判定:會啟用(已配對過或為全新工作空間)"
                            : "系統判定:加入但隱藏(之前被隱藏過、或不在歷史配對裡)"
                        }
                      >
                        <input
                          type="checkbox"
                          checked={selectedGroupIds.has(g.id)}
                          readOnly
                          disabled
                          aria-label="系統決定的同步狀態(唯讀)"
                          className="rounded cursor-not-allowed"
                        />
                        <span className="flex-1 min-w-0 truncate flex items-center gap-2" title={g.title}>
                          <bdi className="truncate">{safeTitle(g.title, 60)}</bdi>
                          {g.isNew && (
                            <span className="text-xs text-green-500 font-medium shrink-0">新</span>
                          )}
                          {g.isReactivatable && (
                            <span className="text-[10px] rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-300 px-1.5 py-0.5 shrink-0">
                              已停用
                            </span>
                          )}
                          {g.wasPreviouslyPaired && (
                            <span className="text-[10px] rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 px-1.5 py-0.5 shrink-0">
                              已配對過
                            </span>
                          )}
                          {g.wasPreviouslyHidden && (
                            <span className="text-[10px] rounded-full bg-gray-500/10 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 shrink-0">
                              之前已隱藏
                            </span>
                          )}
                        </span>
                        <span className="text-xs text-[var(--muted-foreground)] shrink-0">
                          {g.chatType === "CHANNEL" ? "頻道" : "群組"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    // 整批送出 — 所有發現的對話都登記到 Switchboard,使用者勾選的
                    // 設成 isListeningAccount=true(監聽),沒勾的 false(不監聽)。
                    // server 已不再依勾選決定 isActive / isHidden。
                    const allItems = discoveredGroups.map((g) => ({
                      platformGroupId: g.id,
                      title: g.title,
                      chatType: g.chatType,
                      accountId: g.accountId,
                      wantListening: selectedGroupIds.has(g.id),
                    }));
                    if (allItems.length > 0) {
                      await fetch(`/api/workspaces/${workspaceId}/groups/refresh`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ groups: allItems }),
                      }).catch(() => {});
                    }
                    setAuthStep("done");
                    fetchAccounts();
                    router.refresh();
                    setTimeout(() => {
                      setAuthAccountId(null);
                      setAuthStep("idle");
                      setDiscoveredGroups([]);
                      setSelectedGroupIds(new Set());
                    }, 2000);
                  }}
                  disabled={discoveredGroups.length === 0 || authLoading}
                  className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
                >
                  確認同步(啟用 {selectedGroupIds.size} / 共 {discoveredGroups.length})
                </button>
                {discoveredGroups.length === 0 && (
                  <button
                    onClick={() => {
                      setAuthStep("done");
                      setTimeout(() => {
                        setAuthAccountId(null);
                        setAuthStep("idle");
                      }, 2000);
                    }}
                    className="rounded-md border border-[var(--border)] px-4 py-2 text-sm"
                  >
                    跳過
                  </button>
                )}
              </div>
            </div>
          )}

          {authStep === "done" && (
            <div className="rounded bg-[var(--approve)]/10 border border-[var(--approve)]/20 px-4 py-3 text-sm text-[var(--approve)]">
              設定完成！帳號已連線,已啟用所選群組的訊息接收。
            </div>
          )}
        </div>
      )}

      {/* Account list */}
      {accounts.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)]">
          尚未新增任何 Telegram 帳號。
        </p>
      ) : (
        <div className="space-y-2">
          {accounts.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                {editingId === a.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      saveEditName(a.id);
                    }}
                    className="flex items-center gap-1"
                  >
                    <input
                      ref={editInputRef}
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") cancelEditName();
                      }}
                      disabled={editLoading}
                      className="w-full max-w-[200px] rounded border border-[var(--input)] bg-[var(--background)] px-2 py-0.5 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
                    />
                    <button
                      type="submit"
                      disabled={editLoading || !editName.trim()}
                      className="rounded p-1 text-[var(--approve)] hover:bg-[var(--approve)]/10 disabled:opacity-50"
                      title="儲存"
                      aria-label="儲存"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={cancelEditName}
                      disabled={editLoading}
                      className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                      title="取消"
                      aria-label="取消"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </form>
                ) : (
                  <div className="flex items-center gap-1 group">
                    <span
                      className={`text-sm font-medium truncate ${
                        a.displayName?.trim() ? "" : "italic opacity-70"
                      }`}
                    >
                      {/* 自訂暱稱優先；沒設定 → fallback 顯示 TG 名稱 / 電話 */}
                      {getAccountLabel(a)}
                    </span>
                    <button
                      onClick={() => startEditName(a)}
                      className="rounded p-1.5 text-[var(--muted-foreground)] opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:bg-[var(--bg-secondary)] transition-opacity"
                      title="編輯名稱"
                      aria-label="編輯名稱"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                <div className="text-xs text-[var(--muted-foreground)]">
                  {a.telegramFirstName || a.telegramLastName ? (
                    <>
                      Telegram 名稱:{" "}
                      {[a.telegramFirstName, a.telegramLastName]
                        .filter(Boolean)
                        .join(" ")}
                      {a.telegramUsername && <> · @{a.telegramUsername}</>}
                    </>
                  ) : (
                    <span className="italic opacity-60">
                      尚未取得 Telegram 原始名稱(請重新連線帳號)
                    </span>
                  )}
                </div>
                <div className="text-xs text-[var(--muted-foreground)]">
                  {a.phoneNumber || "未設定電話"} ·{" "}
                  {a._count.groupMemberships} 個群組
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                <span
                  className={`text-xs font-medium ${STATUS_COLORS[a.status] || ""}`}
                >
                  {STATUS_LABELS[a.status] || a.status}
                </span>
                {(a.status === "PENDING_AUTH" ||
                  a.status === "AUTH_ERROR") && (
                  <>
                    <button
                      onClick={() => startAuth(a)}
                      className="rounded bg-[var(--primary)] px-2 py-1 text-xs text-[var(--primary-foreground)] hover:opacity-90"
                    >
                      驗證
                    </button>
                    <button
                      onClick={() => startSessionAuth(a)}
                      className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-secondary)]"
                      title="改用 Session 字串登入(手機驗證碼不穩時的替代方案)"
                    >
                      Session 登入
                    </button>
                  </>
                )}
                {a.status === "ACTIVE" && (
                  <button
                    onClick={() => openDevices(a.id)}
                    className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-secondary)]"
                    title="查看此帳號目前登入的裝置"
                  >
                    裝置
                  </button>
                )}
                <button
                  onClick={() => handleDelete(a.id)}
                  className="rounded px-2 py-1 text-xs text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                >
                  刪除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Batch 4 — 多裝置監測:裝置列表 modal */}
      {devicesAccountId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={closeDevices}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
              <h3 className="text-sm font-medium">已登入的裝置</h3>
              <button
                onClick={closeDevices}
                className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-secondary)]"
                aria-label="關閉"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-y-auto px-4 py-3">
              {devicesLoading ? (
                <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">
                  載入裝置列表中...
                </div>
              ) : devicesError && devices.length === 0 ? (
                <div className="space-y-2 py-6 text-center">
                  <p className="text-sm text-[var(--destructive)]">
                    {devicesError}
                  </p>
                  <p className="text-xs text-[var(--muted-foreground)]">
                    帳號需在線上(已連線)時才能查詢裝置列表。
                  </p>
                </div>
              ) : devices.length === 0 ? (
                <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">
                  沒有裝置資料。
                </div>
              ) : (
                <div className="space-y-2">
                  {devicesError && (
                    <p className="text-xs text-[var(--destructive)]">
                      {devicesError}
                    </p>
                  )}
                  {devices.map((d) => (
                    <div
                      key={d.hash}
                      className={`rounded-md border px-3 py-2 ${
                        d.isCurrent
                          ? "border-[var(--primary)]/40 bg-[var(--primary)]/5"
                          : "border-[var(--border)]"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-sm font-medium">
                            <span className="truncate">
                              {d.deviceModel || d.platform || "未知裝置"}
                            </span>
                            {d.isCurrent && (
                              <span className="shrink-0 rounded-full bg-[var(--primary)]/15 px-1.5 py-0.5 text-[10px] text-[var(--primary)]">
                                目前裝置
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                            {[d.appName, d.appVersion].filter(Boolean).join(" ")}
                            {d.platform && ` · ${d.platform}`}
                            {d.systemVersion && ` ${d.systemVersion}`}
                          </div>
                          {(d.country || d.region || d.ip) && (
                            <div className="text-xs text-[var(--muted-foreground)]">
                              {[d.country, d.region].filter(Boolean).join(" / ")}
                              {d.ip && ` · ${d.ip}`}
                            </div>
                          )}
                          {d.dateActive > 0 && (
                            <div className="text-xs text-[var(--muted-foreground)]">
                              最近活動:
                              {new Date(d.dateActive * 1000).toLocaleString(
                                "zh-TW",
                                {
                                  year: "numeric",
                                  month: "2-digit",
                                  day: "2-digit",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  hour12: false,
                                },
                              )}
                            </div>
                          )}
                        </div>
                        {!d.isCurrent && (
                          <button
                            onClick={() => kickDevice(devicesAccountId, d.hash)}
                            disabled={kickingHash === d.hash}
                            className="shrink-0 rounded border border-[var(--destructive)]/30 px-2 py-1 text-xs text-[var(--destructive)] hover:bg-[var(--destructive)]/10 disabled:opacity-50"
                          >
                            {kickingHash === d.hash ? "登出中..." : "登出"}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="border-t border-[var(--border)] px-4 py-2 text-[11px] text-[var(--muted-foreground)]">
              「登出」會把該裝置從此 Telegram 帳號移除。無法登出「目前裝置」(Switchboard bridge 連線本身)。
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
