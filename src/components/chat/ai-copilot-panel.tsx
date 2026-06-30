"use client";

/**
 * AICopilotPanel — Supervisor / 員工副駕的浮動側面板。
 *
 * 2026-05-21 Round 4 — Vercel AI SDK 6 + Anthropic streaming。
 *
 * 設計:
 *   - Floating action button(FAB)右下角,點擊展開側板(寬 380, 高 70vh)
 *   - 對「目前選定的 group」操作 — 員工切換對話時 panel context 跟著切
 *   - 訊息以 streaming 顯示(useChat)
 *   - 不替使用者「自動發送」TG 訊息;只給「複製」+「貼入 composer」兩個 action
 *
 * 為什麼分離成 component:
 *   - direct-chat/page.tsx 已經夠大,新功能要避免再塞
 *   - 之後接 supervisor 監看頁面也可以重用此 panel(傳不同 groupId)
 *
 * 範圍邊界(round 4 MVP):
 *   - 不接 tool calls(查客戶 / 自動標籤 / 發訊息)
 *   - 不接 pgvector retrieval(historical similar conversation)
 *   - 不接 prompt 版本管理(Langfuse 之後)
 *   - 不接 supervisor 模式的「同時看多個對話 + 警示」
 */

import { useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Sparkles, X, Copy, Send } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  workspaceId: string;
  groupId: string | null;
  /** 點「貼入 composer」時呼叫;parent 把建議字串塞進 textarea。 */
  onPaste?: (text: string) => void;
};

export function AICopilotPanel({ workspaceId, groupId, onPaste }: Props) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");

  const { messages, sendMessage, status, error } = useChat({
    // 不同 group 用獨立的 chat 狀態 — 切換 group 時 useChat 會 reset
    id: groupId ? `copilot-${groupId}` : "copilot-idle",
    transport: new DefaultChatTransport({
      api: `/api/workspaces/${workspaceId}/ai/copilot`,
      body: groupId ? { groupId } : undefined,
    }),
  });

  const isStreaming = status === "submitted" || status === "streaming";

  return (
    <>
      {/* FAB — 右下角浮動按鈕 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "fixed bottom-6 right-6 z-30 flex items-center justify-center rounded-full shadow-lg transition-all",
          "size-12 bg-[var(--primary)] text-[var(--primary-foreground)] hover:scale-105",
        )}
        aria-label="AI 副駕"
        title="AI 副駕(實驗中)"
      >
        <Sparkles className="size-5" />
      </button>

      {/* 側板 — 從右側 slide-in,寬 380 高 70vh */}
      {open && (
        <div
          className="fixed bottom-20 right-6 z-30 flex flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-2xl"
          style={{ width: 380, maxHeight: "70vh" }}
        >
          <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-[var(--primary)]" />
              <span className="text-sm font-semibold">AI 副駕</span>
              <span className="text-[10px] text-[var(--text-muted)]">實驗中</span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]"
              aria-label="關閉"
            >
              <X className="size-4" />
            </button>
          </div>

          {!groupId ? (
            <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)] p-6">
              請先選擇一個對話,我才能幫你
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {messages.length === 0 && (
                  <div className="text-sm text-[var(--text-muted)] leading-relaxed">
                    我會看完你跟客戶的最近對話、給回覆建議。
                    試試:
                    <ul className="mt-2 space-y-1 list-disc list-inside text-xs">
                      <li>「客戶最後一則訊息怎麼回比較好?」</li>
                      <li>「整理這次對話的需求,寫個 3 行摘要」</li>
                      <li>「他這句是抱怨還是疑問?」</li>
                    </ul>
                  </div>
                )}
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={cn(
                      "rounded-lg p-2.5 text-sm",
                      m.role === "user"
                        ? "bg-[var(--bg-secondary)]/60 ml-6"
                        : "bg-[var(--accent-bg)]/40 mr-6",
                    )}
                  >
                    {m.parts
                      .filter((p) => p.type === "text")
                      .map((p, i) => (
                        <p key={i} className="whitespace-pre-wrap break-words">
                          {"text" in p ? p.text : ""}
                        </p>
                      ))}
                    {m.role === "assistant" && m.parts.some((p) => p.type === "text") && !isStreaming && (
                      <div className="mt-2 flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
                        <button
                          type="button"
                          onClick={() => {
                            const text = m.parts
                              .filter((p) => p.type === "text")
                              .map((p) => ("text" in p ? p.text : ""))
                              .join("");
                            navigator.clipboard.writeText(text).catch(() => {});
                          }}
                          className="flex items-center gap-1 hover:text-[var(--foreground)]"
                          title="複製到剪貼簿"
                        >
                          <Copy className="size-3" />
                          複製
                        </button>
                        {onPaste && (
                          <button
                            type="button"
                            onClick={() => {
                              const text = m.parts
                                .filter((p) => p.type === "text")
                                .map((p) => ("text" in p ? p.text : ""))
                                .join("");
                              onPaste(text);
                              setOpen(false);
                            }}
                            className="flex items-center gap-1 hover:text-[var(--foreground)]"
                            title="貼入訊息輸入框"
                          >
                            <Send className="size-3" />
                            貼入 composer
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {isStreaming && (
                  <div className="text-xs text-[var(--text-muted)] italic">思考中…</div>
                )}
                {error && (
                  <div className="text-xs text-[var(--destructive)]">
                    錯誤:{String(error.message ?? error).slice(0, 200)}
                  </div>
                )}
              </div>

              {/* Input — Enter 送出,Shift+Enter 換行 */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const text = input.trim();
                  if (!text || isStreaming) return;
                  setInput("");
                  void sendMessage({ text });
                }}
                className="border-t border-[var(--border)] p-2 flex gap-2"
              >
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      const text = input.trim();
                      if (!text || isStreaming) return;
                      setInput("");
                      void sendMessage({ text });
                    }
                  }}
                  rows={1}
                  placeholder="問我什麼…"
                  className="flex-1 resize-none rounded-md border border-[var(--border)] px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-[var(--primary)]"
                  style={{ minHeight: 36, maxHeight: 100 }}
                />
                <button
                  type="submit"
                  disabled={!input.trim() || isStreaming}
                  className="shrink-0 rounded-md bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-foreground)] disabled:opacity-50"
                >
                  送
                </button>
              </form>
            </>
          )}
        </div>
      )}
    </>
  );
}
