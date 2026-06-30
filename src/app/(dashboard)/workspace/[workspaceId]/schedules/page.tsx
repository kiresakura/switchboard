"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { CalendarClock, Link2, Plus, ToggleLeft, ToggleRight } from "lucide-react";
import { PageHeader } from "@/components/ui/section";
import { useToast } from "@/hooks/use-toast";
import {
  BEHAVIOR_LABELS,
  INTERVAL_UNIT_LABELS,
  RECURRENCE_LABELS,
  WEEKDAY_LABELS,
  summarizeSchedule,
  type ScheduleBehaviorKind,
  type ScheduleIntervalUnit,
  type ScheduleRecurrence,
} from "@/lib/schedules/recurrence";
import { cn } from "@/lib/utils";

type QuickReplyOption = {
  id: string;
  shortcut: string;
  title: string;
  scope: "WORKSPACE";
};

type ScheduleRule = {
  id: string;
  name: string;
  description: string | null;
  behaviorKind: ScheduleBehaviorKind;
  recurrence: ScheduleRecurrence;
  timezone: string;
  timeOfDay: string | null;
  daysOfWeek: number[];
  dayOfMonth: number | null;
  intervalEvery: number | null;
  intervalUnit: ScheduleIntervalUnit | null;
  startsAt: string | null;
  endsAt: string | null;
  quickReplyId: string | null;
  quickReply: QuickReplyOption | null;
  createdByName: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type FormState = {
  name: string;
  description: string;
  behaviorKind: ScheduleBehaviorKind;
  recurrence: ScheduleRecurrence;
  timezone: string;
  timeOfDay: string;
  daysOfWeek: number[];
  dayOfMonth: string;
  intervalEvery: string;
  intervalUnit: ScheduleIntervalUnit;
  startsAt: string;
  endsAt: string;
  quickReplyId: string;
  isActive: boolean;
};

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  behaviorKind: "REMINDER",
  recurrence: "DAILY",
  timezone: "Asia/Taipei",
  timeOfDay: "09:00",
  daysOfWeek: [1],
  dayOfMonth: "1",
  intervalEvery: "1",
  intervalUnit: "DAYS",
  startsAt: "",
  endsAt: "",
  quickReplyId: "",
  isActive: true,
};

const BEHAVIOR_OPTIONS = Object.keys(BEHAVIOR_LABELS) as ScheduleBehaviorKind[];
const RECURRENCE_OPTIONS = Object.keys(RECURRENCE_LABELS) as ScheduleRecurrence[];
const INTERVAL_UNIT_OPTIONS = Object.keys(INTERVAL_UNIT_LABELS) as ScheduleIntervalUnit[];

function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formFromSchedule(rule: ScheduleRule): FormState {
  return {
    name: rule.name,
    description: rule.description ?? "",
    behaviorKind: rule.behaviorKind,
    recurrence: rule.recurrence,
    timezone: rule.timezone,
    timeOfDay: rule.timeOfDay ?? "09:00",
    daysOfWeek: rule.daysOfWeek.length > 0 ? rule.daysOfWeek : [1],
    dayOfMonth: String(rule.dayOfMonth ?? 1),
    intervalEvery: String(rule.intervalEvery ?? 1),
    intervalUnit: rule.intervalUnit ?? "DAYS",
    startsAt: isoToLocalInput(rule.startsAt),
    endsAt: isoToLocalInput(rule.endsAt),
    quickReplyId: rule.quickReplyId ?? "",
    isActive: rule.isActive,
  };
}

function formToPayload(form: FormState) {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    behaviorKind: form.behaviorKind,
    recurrence: form.recurrence,
    timezone: form.timezone.trim() || "Asia/Taipei",
    timeOfDay: form.timeOfDay,
    daysOfWeek: form.daysOfWeek,
    dayOfMonth: form.dayOfMonth ? Number(form.dayOfMonth) : null,
    intervalEvery: form.intervalEvery ? Number(form.intervalEvery) : null,
    intervalUnit: form.intervalUnit,
    startsAt: localInputToIso(form.startsAt),
    endsAt: localInputToIso(form.endsAt),
    quickReplyId: form.quickReplyId || null,
    isActive: form.isActive,
  };
}

export default function SchedulesPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { confirm } = useToast();
  const [schedules, setSchedules] = useState<ScheduleRule[]>([]);
  const [quickReplies, setQuickReplies] = useState<QuickReplyOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [scheduleRes, replyRes] = await Promise.all([
        fetch(`/api/workspaces/${workspaceId}/schedules`),
        fetch(`/api/workspaces/${workspaceId}/quick-replies?scope=WORKSPACE`),
      ]);
      if (!scheduleRes.ok) {
        const data = await scheduleRes.json().catch(() => ({}));
        setError(data.error || "無法載入排程模組");
      } else {
        const data = await scheduleRes.json();
        setSchedules(Array.isArray(data.schedules) ? data.schedules : []);
        setError("");
      }
      if (replyRes.ok) {
        const data = await replyRes.json();
        const replies = Array.isArray(data.quickReplies) ? data.quickReplies : [];
        setQuickReplies(replies.filter((r: QuickReplyOption) => r.scope === "WORKSPACE"));
      }
    } catch {
      setError("網路錯誤，無法載入排程模組");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const activeCount = useMemo(
    () => schedules.filter((schedule) => schedule.isActive).length,
    [schedules],
  );

  function openCreate() {
    setEditingId("new");
    setForm(EMPTY_FORM);
    setError("");
  }

  function openEdit(rule: ScheduleRule) {
    setEditingId(rule.id);
    setForm(formFromSchedule(rule));
    setError("");
  }

  function closeForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const isNew = editingId === "new";
      const url = isNew
        ? `/api/workspaces/${workspaceId}/schedules`
        : `/api/workspaces/${workspaceId}/schedules/${editingId}`;
      const res = await fetch(url, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formToPayload(form)),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "儲存失敗");
        return;
      }
      closeForm();
      await fetchData();
    } catch {
      setError("網路錯誤，儲存失敗");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(rule: ScheduleRule) {
    const ok = await confirm({
      message: `確定刪除排程規則「${rule.name}」？此動作無法復原。`,
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/schedules/${rule.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "刪除失敗");
        return;
      }
      await fetchData();
    } catch {
      setError("網路錯誤，刪除失敗");
    }
  }

  function toggleWeekday(day: number) {
    setForm((current) => {
      const exists = current.daysOfWeek.includes(day);
      const daysOfWeek = exists
        ? current.daysOfWeek.filter((d) => d !== day)
        : [...current.daysOfWeek, day].sort((a, b) => a - b);
      return { ...current, daysOfWeek };
    });
  }

  if (loading) {
    return <div className="text-sm text-[var(--muted-foreground)]">載入中...</div>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="排程模組"
        description="定義週期性行為；可選擇是否綁定工作區快選回覆。此頁目前只管理規則，不會自動對外發送。"
        actions={
          <button
            onClick={() => (editingId === "new" ? closeForm() : openCreate())}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
          >
            <Plus className="size-4" />
            {editingId === "new" ? "取消" : "新增排程"}
          </button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-3">
          <div className="text-xs text-[var(--muted-foreground)]">排程規則</div>
          <div className="mt-1 text-2xl font-semibold text-[var(--foreground)]">{schedules.length}</div>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-3">
          <div className="text-xs text-[var(--muted-foreground)]">啟用中</div>
          <div className="mt-1 text-2xl font-semibold text-[var(--foreground)]">{activeCount}</div>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-3">
          <div className="text-xs text-[var(--muted-foreground)]">可綁定快選回覆</div>
          <div className="mt-1 text-2xl font-semibold text-[var(--foreground)]">{quickReplies.length}</div>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-[var(--destructive)]/30 bg-[var(--destructive)]/10 px-4 py-2 text-sm text-[var(--destructive)]">
          {error}
        </div>
      )}

      {editingId !== null && (
        <form
          onSubmit={handleSave}
          className="space-y-4 rounded-lg border border-[var(--border)] bg-[var(--card)] p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-[var(--foreground)]">
                {editingId === "new" ? "新增排程規則" : "編輯排程規則"}
              </div>
              <div className="text-xs text-[var(--muted-foreground)]">
                綁定快選回覆後，executor 未來可用該模板作為週期行為的文字來源。
              </div>
            </div>
            <button
              type="button"
              onClick={() => setForm((current) => ({ ...current, isActive: !current.isActive }))}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs",
                form.isActive
                  ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300"
                  : "border-[var(--border)] text-[var(--muted-foreground)]",
              )}
            >
              {form.isActive ? <ToggleRight className="size-4" /> : <ToggleLeft className="size-4" />}
              {form.isActive ? "啟用" : "停用"}
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-xs text-[var(--muted-foreground)]">名稱</span>
              <input
                value={form.name}
                onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))}
                maxLength={80}
                required
                placeholder="例如：每週一提醒回訪未成交客戶"
                className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs text-[var(--muted-foreground)]">行為類型</span>
              <select
                value={form.behaviorKind}
                onChange={(e) =>
                  setForm((current) => ({
                    ...current,
                    behaviorKind: e.target.value as ScheduleBehaviorKind,
                  }))
                }
                className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
              >
                {BEHAVIOR_OPTIONS.map((kind) => (
                  <option key={kind} value={kind}>
                    {BEHAVIOR_LABELS[kind]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs text-[var(--muted-foreground)]">說明</span>
            <textarea
              value={form.description}
              onChange={(e) =>
                setForm((current) => ({ ...current, description: e.target.value }))
              }
              rows={2}
              maxLength={2000}
              placeholder="描述這條規則要解決的場景、對象或注意事項。"
              className="w-full resize-y rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </label>

          <div className="grid gap-3 md:grid-cols-3">
            <label className="space-y-1.5">
              <span className="text-xs text-[var(--muted-foreground)]">週期</span>
              <select
                value={form.recurrence}
                onChange={(e) =>
                  setForm((current) => ({
                    ...current,
                    recurrence: e.target.value as ScheduleRecurrence,
                  }))
                }
                className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
              >
                {RECURRENCE_OPTIONS.map((recurrence) => (
                  <option key={recurrence} value={recurrence}>
                    {RECURRENCE_LABELS[recurrence]}
                  </option>
                ))}
              </select>
            </label>

            {form.recurrence !== "INTERVAL" ? (
              <label className="space-y-1.5">
                <span className="text-xs text-[var(--muted-foreground)]">時間</span>
                <input
                  type="time"
                  value={form.timeOfDay}
                  onChange={(e) =>
                    setForm((current) => ({ ...current, timeOfDay: e.target.value }))
                  }
                  required
                  className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
                />
              </label>
            ) : (
              <>
                <label className="space-y-1.5">
                  <span className="text-xs text-[var(--muted-foreground)]">每隔</span>
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={form.intervalEvery}
                    onChange={(e) =>
                      setForm((current) => ({
                        ...current,
                        intervalEvery: e.target.value,
                      }))
                    }
                    required
                    className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs text-[var(--muted-foreground)]">單位</span>
                  <select
                    value={form.intervalUnit}
                    onChange={(e) =>
                      setForm((current) => ({
                        ...current,
                        intervalUnit: e.target.value as ScheduleIntervalUnit,
                      }))
                    }
                    className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  >
                    {INTERVAL_UNIT_OPTIONS.map((unit) => (
                      <option key={unit} value={unit}>
                        {INTERVAL_UNIT_LABELS[unit]}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}

            {form.recurrence === "MONTHLY" && (
              <label className="space-y-1.5">
                <span className="text-xs text-[var(--muted-foreground)]">每月日期</span>
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={form.dayOfMonth}
                  onChange={(e) =>
                    setForm((current) => ({ ...current, dayOfMonth: e.target.value }))
                  }
                  required
                  className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
                />
              </label>
            )}

            {form.recurrence !== "INTERVAL" && (
              <label className="space-y-1.5">
                <span className="text-xs text-[var(--muted-foreground)]">時區</span>
                <input
                  value={form.timezone}
                  onChange={(e) =>
                    setForm((current) => ({ ...current, timezone: e.target.value }))
                  }
                  className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
                />
              </label>
            )}
          </div>

          {form.recurrence === "WEEKLY" && (
            <div className="space-y-1.5">
              <div className="text-xs text-[var(--muted-foreground)]">星期</div>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAY_LABELS.map((label, day) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => toggleWeekday(day)}
                    className={cn(
                      "rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                      form.daysOfWeek.includes(day)
                        ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                        : "border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--bg-secondary)]",
                    )}
                  >
                    週{label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-3">
            <label className="space-y-1.5">
              <span className="text-xs text-[var(--muted-foreground)]">綁定快選回覆</span>
              <select
                value={form.quickReplyId}
                onChange={(e) =>
                  setForm((current) => ({ ...current, quickReplyId: e.target.value }))
                }
                className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
              >
                <option value="">不綁定</option>
                {quickReplies.map((reply) => (
                  <option key={reply.id} value={reply.id}>
                    /{reply.shortcut} · {reply.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1.5">
              <span className="text-xs text-[var(--muted-foreground)]">開始時間</span>
              <input
                type="datetime-local"
                value={form.startsAt}
                onChange={(e) =>
                  setForm((current) => ({ ...current, startsAt: e.target.value }))
                }
                className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs text-[var(--muted-foreground)]">結束時間</span>
              <input
                type="datetime-local"
                value={form.endsAt}
                onChange={(e) =>
                  setForm((current) => ({ ...current, endsAt: e.target.value }))
                }
                className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
              />
            </label>
          </div>

          <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/40 px-3 py-2 text-xs text-[var(--muted-foreground)]">
            預覽：
            {summarizeSchedule({
              recurrence: form.recurrence,
              timeOfDay: form.timeOfDay,
              daysOfWeek: form.daysOfWeek,
              dayOfMonth: Number(form.dayOfMonth),
              intervalEvery: Number(form.intervalEvery),
              intervalUnit: form.intervalUnit,
            })}
            {form.quickReplyId ? " · 已綁定快選回覆" : " · 不綁定快選回覆"}
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "儲存中…" : "儲存"}
            </button>
            <button
              type="button"
              onClick={closeForm}
              className="rounded-md border border-[var(--border)] px-4 py-2 text-sm hover:bg-[var(--bg-secondary)]"
            >
              取消
            </button>
          </div>
        </form>
      )}

      {schedules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--card)] px-4 py-10 text-center text-sm text-[var(--muted-foreground)]">
          尚未建立週期性規則。點右上角「新增排程」開始。
        </div>
      ) : (
        <div className="space-y-2">
          {schedules.map((rule) => (
            <div
              key={rule.id}
              className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-3"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                        rule.isActive
                          ? "bg-green-500/10 text-green-700 dark:text-green-300"
                          : "bg-[var(--bg-secondary)] text-[var(--muted-foreground)]",
                      )}
                    >
                      <CalendarClock className="size-3" />
                      {rule.isActive ? "啟用" : "停用"}
                    </span>
                    <span className="rounded-full bg-[var(--accent-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]">
                      {BEHAVIOR_LABELS[rule.behaviorKind]}
                    </span>
                    <h2 className="text-sm font-semibold text-[var(--foreground)]">
                      {rule.name}
                    </h2>
                  </div>
                  <div className="text-sm text-[var(--foreground)]">
                    {summarizeSchedule(rule)}
                  </div>
                  {rule.description && (
                    <p className="line-clamp-2 whitespace-pre-wrap text-xs text-[var(--muted-foreground)]">
                      {rule.description}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted-foreground)]">
                    <span>時區：{rule.timezone}</span>
                    {rule.quickReply ? (
                      <span className="inline-flex items-center gap-1 rounded bg-[var(--bg-secondary)] px-1.5 py-0.5">
                        <Link2 className="size-3" />
                        /{rule.quickReply.shortcut} · {rule.quickReply.title}
                      </span>
                    ) : (
                      <span>未綁定快選回覆</span>
                    )}
                    {rule.createdByName && <span>建立者：{rule.createdByName}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => openEdit(rule)}
                    className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-secondary)]"
                  >
                    編輯
                  </button>
                  <button
                    onClick={() => handleDelete(rule)}
                    className="rounded px-2 py-1 text-xs text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                  >
                    刪除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
