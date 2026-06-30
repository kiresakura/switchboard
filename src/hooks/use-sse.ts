"use client";

import { useEffect, useRef, useState } from "react";

type SSEMessage = {
  type: string;
  data?: Record<string, unknown>;
  userId?: string;
  eventId?: string;
};

type UseSSEOptions = {
  workspaceId: string;
  onMessage?: (message: SSEMessage) => void;
};

// Stop auto-reconnect after this many consecutive failures; EventSource
// cannot surface HTTP status codes, so a retry cap is the only practical
// defence against an infinite loop against a persistently-failing server
// (e.g. 401 after session expiry).
const MAX_RETRIES = 10;

export function useSSE({ workspaceId, onMessage }: UseSSEOptions) {
  const [connected, setConnected] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const onMessageRef = useRef(onMessage);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unmountedRef = useRef(false);
  const retryCountRef = useRef(0);
  const lastEventIdRef = useRef<string | null>(null);
  const pollSinceRef = useRef(Date.now());
  const seenEventIdsRef = useRef<Set<string>>(new Set());

  // Keep callback ref fresh without triggering reconnect
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    unmountedRef.current = false;
    pollSinceRef.current = Date.now();

    if (!workspaceId) {
      setConnected(false);
      setExhausted(false);
      return;
    }

    function dispatchMessage(message: SSEMessage, eventId?: string) {
      if (eventId) {
        if (seenEventIdsRef.current.has(eventId)) return;
        seenEventIdsRef.current.add(eventId);
        lastEventIdRef.current = eventId;
        message.eventId = eventId;
      }
      onMessageRef.current?.(message);
    }

    function connect() {
      if (unmountedRef.current) return;

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      let url = `/api/realtime?workspaceId=${encodeURIComponent(workspaceId)}`;
      if (lastEventIdRef.current) {
        url += `&lastEventId=${encodeURIComponent(lastEventIdRef.current)}`;
      }

      const es = new EventSource(url);

      es.onopen = () => {
        if (!unmountedRef.current) {
          setConnected(true);
          setExhausted(false);
        }
        retryCountRef.current = 0;
      };

      es.onmessage = (event) => {
        if (unmountedRef.current) return;
        try {
          const data = JSON.parse(event.data) as SSEMessage;
          dispatchMessage(data, event.lastEventId || undefined);
        } catch {
          // Ignore parse errors (heartbeats, etc.)
        }
      };

      es.onerror = () => {
        if (!unmountedRef.current) {
          setConnected(false);
        }
        es.close();
        if (unmountedRef.current) return;
        if (retryCountRef.current >= MAX_RETRIES) {
          setExhausted(true);
          return;
        }
        const delay = Math.min(1000 * Math.pow(2, retryCountRef.current), 30000);
        retryCountRef.current += 1;
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      };

      eventSourceRef.current = es;
    }

    async function pollReplay() {
      if (unmountedRef.current) return;
      const params = new URLSearchParams({
        workspaceId,
        mode: "poll",
        since: String(pollSinceRef.current),
      });
      if (lastEventIdRef.current) params.set("lastEventId", lastEventIdRef.current);
      try {
        const res = await fetch(`/api/realtime?${params.toString()}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          events?: Array<{
            id?: string;
            type: string;
            data?: Record<string, unknown>;
          }>;
        };
        for (const event of data.events ?? []) {
          dispatchMessage({ type: event.type, data: event.data }, event.id);
        }
      } catch {
        // SSE remains the primary path; polling is best-effort compensation.
      }
    }

    connect();
    pollIntervalRef.current = setInterval(() => {
      void pollReplay();
    }, 2000);

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [workspaceId]);

  return { connected, exhausted };
}
