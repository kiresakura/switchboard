"use client";

import { useEffect, useState, useTransition } from "react";
import { Settings2 } from "lucide-react";

interface MenuConfig {
  showMute: boolean;
  showClear: boolean;
  showDelete: boolean;
}

const ITEMS: { key: keyof MenuConfig; label: string; desc: string; danger?: boolean }[] = [
  {
    key: "showMute",
    label: "關閉通知",
    desc: "在對話 ⋮ 選單中顯示「關閉通知」",
  },
  {
    key: "showClear",
    label: "清空對話紀錄",
    desc: "在對話 ⋮ 選單中顯示「清空對話紀錄」",
    danger: true,
  },
  {
    key: "showDelete",
    label: "刪除對話",
    desc: "在對話 ⋮ 選單中顯示「刪除對話」",
    danger: true,
  },
];

export default function MenuConfigSection({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const [config, setConfig] = useState<MenuConfig>({
    showMute: false,
    showClear: false,
    showDelete: false,
  });
  const [loaded, setLoaded] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/ui-config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.uiConfig?.menuConfig) {
          setConfig(d.uiConfig.menuConfig as MenuConfig);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [workspaceId]);

  const toggle = (key: keyof MenuConfig) => {
    const next = { ...config, [key]: !config[key] };
    setConfig(next);
    startTransition(async () => {
      await fetch(`/api/workspaces/${workspaceId}/ui-config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
    });
  };

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <Settings2 className="size-3.5 text-[var(--text-muted)]" />
        <p className="ui-label text-[var(--text-muted)]">對話選單權限</p>
        {isPending && (
          <span className="ml-auto text-[11px] text-[var(--text-muted)]">
            儲存中…
          </span>
        )}
      </div>
      <p className="mb-5 max-w-[520px] text-[13px] leading-relaxed text-[var(--text-secondary)]">
        以下操作在所有成員的對話 ⋮ 選單中預設隱藏。啟用後即對全工作區生效。
      </p>
      <div className="space-y-3">
        {ITEMS.map(({ key, label, desc, danger }) => {
          const on = config[key];
          return (
            <label
              key={key}
              className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-3 transition-colors hover:bg-[var(--bg-secondary)]"
            >
              <div className="min-w-0 flex-1">
                <div
                  className={`text-[14px] font-medium ${danger ? "text-[var(--danger)]" : "text-[var(--text-primary)]"}`}
                >
                  {label}
                </div>
                <div className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                  {desc}
                </div>
              </div>
              {/* Pill toggle */}
              <button
                type="button"
                role="switch"
                aria-checked={on}
                onClick={() => loaded && toggle(key)}
                disabled={!loaded}
                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
                  on
                    ? danger
                      ? "bg-[var(--danger)]"
                      : "bg-[var(--accent)]"
                    : "bg-[var(--border)]"
                } disabled:opacity-40`}
              >
                <span
                  className={`inline-block size-4 rounded-full bg-white shadow-sm transition-transform ${
                    on ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </label>
          );
        })}
      </div>
    </section>
  );
}
