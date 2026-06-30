"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronDown, User, WifiOff, RefreshCw, Keyboard } from "lucide-react";

interface Account {
  id: string;
  displayName: string;
  status: "ACTIVE" | "DISCONNECTED" | "PENDING_AUTH" | "AUTH_ERROR" | "DISABLED";
  platform: string;
  phoneNumber?: string;
}

interface AccountSwitcherProps {
  workspaceId: string;
  selectedAccountId: string;
  onAccountChange: (accountId: string) => void;
  /** 是否隱藏右側「重新整理」按鈕（送訊息區用 compact 樣式時關掉） */
  hideRefresh?: boolean;
  /** 緊湊模式：縮小 padding，方便塞進送訊息區 */
  compact?: boolean;
}

const LAST_ACCOUNT_KEY = "switchboard_last_account";

function getLastAccountForGroup(workspaceId: string, groupId?: string): string | null {
  if (!groupId) return null;
  try {
    const data = JSON.parse(localStorage.getItem(LAST_ACCOUNT_KEY) || "{}");
    return data[`${workspaceId}:${groupId}`] || null;
  } catch {
    return null;
  }
}

function saveLastAccountForGroup(workspaceId: string, groupId: string, accountId: string) {
  try {
    const data = JSON.parse(localStorage.getItem(LAST_ACCOUNT_KEY) || "{}");
    data[`${workspaceId}:${groupId}`] = accountId;
    localStorage.setItem(LAST_ACCOUNT_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}

export function AccountSwitcher({
  workspaceId,
  selectedAccountId,
  onAccountChange,
  hideRefresh = false,
  compact = false,
}: AccountSwitcherProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAccounts = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/accounts`);
      if (response.ok) {
        const data = await response.json();
        const fetchedAccounts: Account[] = data.accounts || [];
        setAccounts(fetchedAccounts);

        // Auto-select: prefer last used, then first active
        if (!selectedAccountId && fetchedAccounts.length > 0) {
          const activeAccounts = fetchedAccounts.filter((a) => a.status === "ACTIVE");
          const first = activeAccounts[0] || fetchedAccounts[0];
          onAccountChange(first.id);
        }
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [workspaceId, selectedAccountId, onAccountChange]);

  useEffect(() => {
    fetchAccounts();
    // Poll account statuses every 30s
    pollRef.current = setInterval(() => fetchAccounts(true), 30000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchAccounts]);

  // Keyboard shortcut: Alt+1~9 to quick-switch accounts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && e.key >= "1" && e.key <= "9") {
        const idx = parseInt(e.key) - 1;
        if (accounts[idx]) {
          e.preventDefault();
          onAccountChange(accounts[idx].id);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [accounts, onAccountChange]);

  const selectedAccount = accounts.find((acc) => acc.id === selectedAccountId);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "ACTIVE":
        return <span className="relative flex h-2.5 w-2.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span><span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500"></span></span>;
      case "DISCONNECTED":
        return <WifiOff className="w-4 h-4 text-red-500" />;
      case "AUTH_ERROR":
        return <WifiOff className="w-4 h-4 text-orange-500" />;
      default:
        return <WifiOff className="w-4 h-4 text-yellow-500" />;
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case "ACTIVE": return "在線";
      case "DISCONNECTED": return "離線";
      case "PENDING_AUTH": return "待認證";
      case "AUTH_ERROR": return "認證失敗";
      case "DISABLED": return "已停用";
      default: return "未知";
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "ACTIVE": return "bg-green-50 text-green-700 border-green-200";
      case "DISCONNECTED": return "bg-red-50 text-red-700 border-red-200";
      case "AUTH_ERROR": return "bg-orange-50 text-orange-700 border-orange-200";
      default: return "bg-yellow-50 text-yellow-700 border-yellow-200";
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-4 bg-[var(--card)] rounded-lg border">
        <div className="animate-spin rounded-full h-5 w-5 border-2 border-blue-500 border-t-transparent"></div>
        <span className="ml-2 text-sm text-[var(--muted-foreground)]">載入帳號...</span>
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="p-4 bg-red-50 rounded-lg border border-red-200">
        <div className="flex items-center">
          <WifiOff className="w-5 h-5 text-red-500 mr-2" />
          <span className="text-sm text-red-700">無可用的 TG 發送身分</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={`flex-1 flex items-center justify-between bg-[var(--background)] rounded-lg border border-[var(--border)] hover:border-blue-300 transition-colors ${compact ? "px-2 py-1.5" : "p-3"}`}
        >
          {/* 單行佈局:狀態點 + 名稱 + 狀態標籤 + 電話,壓成一行省垂直空間。
              名稱過長才 truncate;狀態標籤與電話固定不縮(shrink-0)。 */}
          <div className="flex min-w-0 items-center gap-2">
            {selectedAccount ? getStatusIcon(selectedAccount.status) : <User className="w-4 h-4 text-[var(--muted-foreground)]" />}
            <span className="min-w-0 truncate text-sm font-medium text-[var(--foreground)]">
              {selectedAccount?.displayName || "選擇帳號"}
            </span>
            {selectedAccount && (
              <>
                <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] leading-none ${getStatusColor(selectedAccount.status)}`}>
                  {getStatusText(selectedAccount.status)}
                </span>
                {selectedAccount.phoneNumber && (
                  <span className="shrink-0 text-xs text-[var(--muted-foreground)]">
                    {selectedAccount.phoneNumber}
                  </span>
                )}
              </>
            )}
          </div>
          <ChevronDown className={`w-4 h-4 text-[var(--muted-foreground)] transition-transform ${isOpen ? "rotate-180" : ""}`} />
        </button>

        {/* Refresh button — 30s 已自動 poll，所以可隱藏避免使用者誤以為要手動點 */}
        {!hideRefresh && (
          <button
            onClick={() => fetchAccounts(true)}
            disabled={refreshing}
            className={`bg-[var(--background)] rounded-lg border border-[var(--border)] hover:border-blue-300 transition-colors ${compact ? "px-2 py-1.5" : "p-3"}`}
            title="重新整理帳號狀態"
            aria-label="重新整理帳號狀態"
          >
            <RefreshCw className={`w-4 h-4 text-[var(--muted-foreground)] ${refreshing ? "animate-spin" : ""}`} />
          </button>
        )}
      </div>

      {/* Keyboard hint — compact 模式（對話列表側欄）隱藏以省垂直空間，Alt+1~9 仍可用 */}
      {accounts.length > 1 && !compact && (
        <div className="mt-1 flex items-center gap-1 text-xs text-[var(--muted-foreground)]">
          <Keyboard className="w-3 h-3" />
          <span>Alt+1~{Math.min(accounts.length, 9)} 快速切換</span>
        </div>
      )}

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="absolute top-full left-0 right-0 mt-1 bg-[var(--background)] rounded-lg border border-[var(--border)] shadow-lg z-20 max-h-64 overflow-y-auto">
            {accounts.map((account, idx) => (
              <button
                key={account.id}
                onClick={() => {
                  onAccountChange(account.id);
                  setIsOpen(false);
                }}
                className={`w-full flex items-center space-x-3 p-3 text-left hover:bg-[var(--card)] transition-colors first:rounded-t-lg last:rounded-b-lg ${
                  account.id === selectedAccountId ? "bg-blue-50" : ""
                }`}
              >
                {getStatusIcon(account.status)}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-[var(--foreground)] truncate">
                      {account.displayName}
                    </span>
                    <div className="flex items-center gap-2">
                      {idx < 9 && (
                        <kbd className="px-1.5 py-0.5 text-xs bg-[var(--muted)] text-[var(--muted-foreground)] rounded border">
                          Alt+{idx + 1}
                        </kbd>
                      )}
                      {account.id === selectedAccountId && (
                        <span className="text-xs text-blue-600 font-medium">&#10003;</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center space-x-2 mt-1">
                    <span className={`px-2 py-0.5 rounded-full text-xs border ${getStatusColor(account.status)}`}>
                      {getStatusText(account.status)}
                    </span>
                    {account.phoneNumber && (
                      <span className="text-xs text-[var(--muted-foreground)]">{account.phoneNumber}</span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export { getLastAccountForGroup, saveLastAccountForGroup };
