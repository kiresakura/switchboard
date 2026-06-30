"use client";

import { useState } from "react";
import { Bug } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface BugReportButtonProps {
  page?: string;
  className?: string;
}

export function BugReportButton({ page, className = "" }: BugReportButtonProps) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<"low" | "medium" | "high" | "critical">("medium");
  const [reproduction, setReproduction] = useState("");

  const handleSubmit = async () => {
    if (!title.trim() || !description.trim()) {
      toast({ title: "請填寫標題和描述", variant: "destructive" });
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/bug-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          page: page || window.location.pathname,
          severity,
          reproduction: reproduction.trim() || undefined,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        toast({
          title: data.sent ? "已通報至開發團隊" : "已記錄問題",
          description: data.sent ? "感謝您的回報！" : "系統暫時無法連接通報群組",
        });
        setOpen(false);
        setTitle("");
        setDescription("");
        setReproduction("");
      } else {
        toast({ title: data.error || "通報失敗", variant: "destructive" });
      }
    } catch {
      toast({ title: "網路錯誤", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`fixed bottom-20 right-4 z-40 rounded-full bg-[var(--primary)] p-3 text-white shadow-lg hover:opacity-90 md:bottom-4 md:right-6 ${className}`}
        title="回報問題"
        aria-label="回報問題"
      >
        <Bug className="size-6" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg bg-[var(--card)] p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold">回報問題</h2>
              <button
                onClick={() => setOpen(false)}
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm">標題 *</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="簡短描述問題"
                  maxLength={200}
                  className="w-full rounded border border-[var(--input)] bg-[var(--background)] px-3 py-2"
                  disabled={submitting}
                />
              </div>

              <div>
                <label className="mb-1 block text-sm">嚴重程度</label>
                <select
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value as typeof severity)}
                  className="w-full rounded border border-[var(--input)] bg-[var(--background)] px-3 py-2"
                  disabled={submitting}
                >
                  <option value="low">🟢 低（小問題，不影響使用）</option>
                  <option value="medium">🟡 中（造成不便但可繼續使用）</option>
                  <option value="high">🟠 高（嚴重影響使用）</option>
                  <option value="critical">🔴 緊急（系統無法使用）</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-sm">描述 *</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="請詳細描述問題發生的情況..."
                  maxLength={5000}
                  rows={4}
                  className="w-full rounded border border-[var(--input)] bg-[var(--background)] px-3 py-2 resize-none"
                  disabled={submitting}
                />
              </div>

              <div>
                <label className="mb-1 block text-sm">重現步驟（選填）</label>
                <textarea
                  value={reproduction}
                  onChange={(e) => setReproduction(e.target.value)}
                  placeholder="如何重現此問題？"
                  maxLength={5000}
                  rows={3}
                  className="w-full rounded border border-[var(--input)] bg-[var(--background)] px-3 py-2 resize-none"
                  disabled={submitting}
                />
              </div>

              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setOpen(false)}
                  className="rounded border border-[var(--border)] px-4 py-2 hover:bg-[var(--bg-secondary)]"
                  disabled={submitting}
                >
                  取消
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={submitting || !title.trim() || !description.trim()}
                  className="rounded bg-[var(--primary)] px-4 py-2 text-white hover:opacity-90 disabled:opacity-50"
                >
                  {submitting ? "傳送中..." : "送出"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
