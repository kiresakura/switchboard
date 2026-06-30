"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Calendar, Search, Filter, Download, ChevronUp } from "lucide-react";
import { MessageDisplay } from "@/components/ui/message-display";

interface HistoryMessage {
  id: string;
  originalContent: string;
  messageType: "TEXT" | "IMAGE" | "DOCUMENT" | "AUDIO" | "VIDEO" | "STICKER" | "VOICE" | "VIDEO_NOTE" | "LOCATION" | "CONTACT" | "POLL" | "DICE" | "STORY";
  direction: "INBOUND" | "OUTBOUND";
  senderDisplayName?: string;
  receivedAt: string;
  mediaUrl?: string;
  mediaType?: string;
  mediaFileName?: string;
  status: string;
  accountName?: string;
}

interface ConversationHistoryProps {
  workspaceId: string;
  selectedGroup: string;
  selectedAccount: string;
}

export function ConversationHistory({
  workspaceId,
  selectedGroup,
  selectedAccount,
}: ConversationHistoryProps) {
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [total, setTotal] = useState(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [exporting, setExporting] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Debounce search
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setDebouncedSearch(searchTerm);
    }, 300);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [searchTerm]);

  const loadHistory = useCallback(
    async (pageNum: number, reset: boolean = false) => {
      if (loading || !selectedGroup) return;

      setLoading(true);
      try {
        const params = new URLSearchParams({
          page: pageNum.toString(),
          limit: "30",
          group: selectedGroup,
          ...(selectedAccount && { account: selectedAccount }),
          ...(debouncedSearch && { search: debouncedSearch }),
          ...(dateFilter && { date: dateFilter }),
          ...(typeFilter && { type: typeFilter }),
        });

        const response = await fetch(
          `/api/workspaces/${workspaceId}/direct-chat/history?${params}`
        );
        if (response.ok) {
          const data = await response.json();

          if (reset) {
            setMessages(data.messages || []);
          } else {
            // Prepend older messages (loading more = older)
            setMessages((prev) => [...(data.messages || []), ...prev]);
          }

          setHasMore(data.hasMore || false);
          setTotal(data.total || 0);
          setPage(pageNum);
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    },
    [workspaceId, selectedGroup, selectedAccount, debouncedSearch, dateFilter, typeFilter, loading]
  );

  useEffect(() => {
    if (selectedGroup) {
      loadHistory(1, true);
    } else {
      setMessages([]);
      setTotal(0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loadHistory depends on `loading` which would cause loops
  }, [selectedGroup, selectedAccount, debouncedSearch, dateFilter, typeFilter]);

  // Auto-scroll to bottom on initial load
  useEffect(() => {
    if (page === 1 && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, page]);

  const handleLoadMore = () => {
    if (hasMore && !loading) {
      loadHistory(page + 1);
    }
  };

  const exportHistory = async () => {
    if (!selectedGroup || exporting) return;
    setExporting(true);
    try {
      const params = new URLSearchParams({
        group: selectedGroup,
        ...(selectedAccount && { account: selectedAccount }),
        ...(debouncedSearch && { search: debouncedSearch }),
        ...(dateFilter && { date: dateFilter }),
        ...(typeFilter && { type: typeFilter }),
        export: "true",
      });

      const response = await fetch(
        `/api/workspaces/${workspaceId}/direct-chat/history?${params}`
      );
      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `conversation_history_${new Date().toISOString().split("T")[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      }
    } catch {
      // ignore
    } finally {
      setExporting(false);
    }
  };

  const highlightSearch = (text: string) => {
    if (!debouncedSearch) return text;
    const regex = new RegExp(`(${debouncedSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    const parts = text.split(regex);
    return parts.map((part, i) =>
      regex.test(part) ? (
        <mark key={i} className="bg-yellow-200 rounded px-0.5">
          {part}
        </mark>
      ) : (
        part
      )
    );
  };

  if (!selectedGroup) {
    return (
      <div className="flex items-center justify-center h-64 bg-[var(--card)] rounded-lg">
        <div className="text-center">
          <Calendar className="w-12 h-12 text-[var(--muted-foreground)] mx-auto mb-4" />
          <p className="text-[var(--muted-foreground)]">請選擇群組以查看對話歷史</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search & Filters */}
      <div className="space-y-3 mb-4">
        <div className="flex items-center space-x-2">
          <div className="flex-1 relative">
            <Search className="w-4 h-4 absolute left-3 top-3 text-[var(--muted-foreground)]" />
            <input
              type="text"
              placeholder="搜索訊息內容..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-[var(--border)] rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`p-2 border border-[var(--border)] rounded-lg hover:bg-[var(--card)] ${showFilters ? "bg-blue-50 border-blue-200" : ""}`}
            aria-label="篩選"
          >
            <Filter className="w-4 h-4" />
          </button>
          <button
            onClick={exportHistory}
            disabled={exporting}
            className="p-2 border border-[var(--border)] rounded-lg hover:bg-[var(--card)] disabled:opacity-50"
            title="匯出歷史記錄"
            aria-label="匯出歷史記錄"
          >
            <Download className={`w-4 h-4 ${exporting ? "animate-bounce" : ""}`} />
          </button>
        </div>

        {showFilters && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 bg-[var(--card)] rounded-lg">
            <div>
              <label className="block text-sm font-medium text-[var(--foreground)] mb-1">日期篩選</label>
              <input
                type="date"
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
                className="w-full px-3 py-2 border border-[var(--border)] rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--foreground)] mb-1">訊息類型</label>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="w-full px-3 py-2 border border-[var(--border)] rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="">全部類型</option>
                <option value="TEXT">文字訊息</option>
                <option value="IMAGE">圖片</option>
                <option value="DOCUMENT">文檔</option>
                <option value="AUDIO">音頻</option>
                <option value="VIDEO">視頻</option>
              </select>
            </div>
          </div>
        )}

        {total > 0 && (
          <div className="text-xs text-[var(--muted-foreground)] text-right">
            共 {total} 則訊息
          </div>
        )}
      </div>

      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 min-h-0">
        {loading && messages.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-blue-500 border-t-transparent"></div>
            <span className="ml-2 text-sm text-[var(--muted-foreground)]">載入歷史記錄...</span>
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-8 text-[var(--muted-foreground)]">
            <Calendar className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>暫無對話歷史</p>
          </div>
        ) : (
          <>
            {/* Load more button at top */}
            {hasMore && (
              <div className="text-center py-2">
                <button
                  onClick={handleLoadMore}
                  disabled={loading}
                  className="inline-flex items-center gap-1 px-4 py-1.5 text-sm text-blue-600 hover:bg-blue-50 rounded-lg disabled:opacity-50"
                >
                  <ChevronUp className="w-4 h-4" />
                  {loading ? "載入中..." : "載入更多"}
                </button>
              </div>
            )}

            {messages.map((message, index) => {
              const showDate =
                index === 0 ||
                new Date(message.receivedAt).toDateString() !==
                  new Date(messages[index - 1].receivedAt).toDateString();

              return (
                <div key={message.id}>
                  {showDate && (
                    <div className="text-center py-2 sticky top-0 z-10">
                      <span className="px-3 py-1 bg-[var(--muted)] text-[var(--muted-foreground)] text-xs rounded-full shadow-sm">
                        {new Date(message.receivedAt).toLocaleDateString("zh-TW", {
                          year: "numeric",
                          month: "long",
                          day: "numeric",
                          weekday: "short",
                        })}
                      </span>
                    </div>
                  )}
                  <div className={`flex ${message.direction === "OUTBOUND" ? "justify-end" : "justify-start"}`}>
                    <div className="max-w-xs lg:max-w-md">
                      {message.accountName && message.direction !== "OUTBOUND" && (
                        <div className="text-xs text-[var(--muted-foreground)] mb-0.5 ml-1">
                          {message.senderDisplayName || message.accountName}
                        </div>
                      )}
                      {debouncedSearch && message.messageType === "TEXT" ? (
                        <div className={`rounded-lg px-3 py-2 text-sm ${
                          message.direction === "OUTBOUND"
                            ? "bg-blue-500 text-white"
                            : "bg-[var(--background)] border border-[var(--border)]"
                        }`}>
                          <div>{highlightSearch(message.originalContent)}</div>
                          <div className={`text-xs mt-1 ${
                            message.direction === "OUTBOUND" ? "text-blue-100" : "text-[var(--muted-foreground)]"
                          }`}>
                            {new Date(message.receivedAt).toLocaleTimeString("zh-TW", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>
                        </div>
                      ) : (
                        <MessageDisplay
                          message={{
                            id: message.id,
                            originalContent: message.originalContent,
                            messageType: message.messageType,
                            mediaUrl: message.mediaUrl,
                            mediaType: message.mediaType,
                            mediaFileName: message.mediaFileName,
                            senderDisplayName: message.senderDisplayName,
                            platformTimestamp: message.receivedAt ? new Date(message.receivedAt) : null,
                          }}
                        />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
