"use client";

/**
 * useTypingIndicator — subscribes to the workspace SSE channel and exposes
 * an auto-expiring list of users currently typing in a specific group.
 *
 * Telegram emits UpdateUserTyping roughly every 5 seconds while the user is
 * typing, then stops (no explicit "stopped" event). We keep each typer in
 * state for 6 seconds past the latest event, so a single missed update
 * won't cause the indicator to flicker.
 *
 * useMultiGroupTyping — same idea but keyed by groupId, so views like the
 * pairing message history (which doesn't have one "current group") can show
 * "X 正在於 Y 群組輸入…" aggregated across many groups.
 */

import { useEffect, useMemo, useState } from "react";
import { useSSE } from "@/hooks/use-sse";

const TYPING_TTL_MS = 6000;

export type Typer = {
  platformUserId: string;
  displayName: string | null;
  expiresAt: number;
};

export type GroupTyper = Typer & {
  groupId: string;
};

export function useTypingIndicator(workspaceId: string, groupId: string | null) {
  const [typers, setTypers] = useState<Typer[]>([]);

  useSSE({
    workspaceId,
    onMessage: (evt: { type: string; data?: Record<string, unknown> }) => {
      if (evt.type !== "chat:typing" || !evt.data) return;
      if (!groupId) return;
      if (evt.data.groupId !== groupId) return;

      const platformUserId = evt.data.platformUserId as string;
      const displayName = (evt.data.displayName as string | null | undefined) ?? null;
      if (!platformUserId) return;

      setTypers((prev) => {
        const now = Date.now();
        const without = prev.filter((t) => t.platformUserId !== platformUserId);
        return [...without, { platformUserId, displayName, expiresAt: now + TYPING_TTL_MS }];
      });
    },
  });

  // Periodic sweep to drop expired entries. Uses the functional setter so
  // we read the latest state without violating the "no refs during render"
  // rule — setTypers skips a render when nothing actually changed.
  useEffect(() => {
    const tick = setInterval(() => {
      const now = Date.now();
      setTypers((prev) => {
        const kept = prev.filter((t) => t.expiresAt > now);
        return kept.length === prev.length ? prev : kept;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  return typers;
}

/**
 * Multi-group variant: returns typers bucketed by groupId for any
 * (workspace, groupId in set) tuple seen on SSE.
 *
 * Passing `groupIds=null` disables filtering (accepts any group). Pass a
 * stable array reference where possible; we already memoize internally but
 * a fresh array every render forces re-subscription.
 */
export function useMultiGroupTyping(
  workspaceId: string,
  groupIds: string[] | null,
): Map<string, Typer[]> {
  const [typers, setTypers] = useState<GroupTyper[]>([]);
  const groupSet = useMemo(
    () => (groupIds ? new Set(groupIds) : null),
    // Re-derive only when the joined id list actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groupIds?.join("|")],
  );

  useSSE({
    workspaceId,
    onMessage: (evt: { type: string; data?: Record<string, unknown> }) => {
      if (evt.type !== "chat:typing" || !evt.data) return;
      const groupId = evt.data.groupId as string | undefined;
      const platformUserId = evt.data.platformUserId as string | undefined;
      if (!groupId || !platformUserId) return;
      if (groupSet && !groupSet.has(groupId)) return;
      const displayName = (evt.data.displayName as string | null | undefined) ?? null;

      setTypers((prev) => {
        const now = Date.now();
        const without = prev.filter(
          (t) => !(t.groupId === groupId && t.platformUserId === platformUserId),
        );
        return [
          ...without,
          { groupId, platformUserId, displayName, expiresAt: now + TYPING_TTL_MS },
        ];
      });
    },
  });

  useEffect(() => {
    const tick = setInterval(() => {
      const now = Date.now();
      setTypers((prev) => {
        const kept = prev.filter((t) => t.expiresAt > now);
        return kept.length === prev.length ? prev : kept;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  return useMemo(() => {
    const byGroup = new Map<string, Typer[]>();
    for (const t of typers) {
      const arr = byGroup.get(t.groupId) ?? [];
      arr.push({ platformUserId: t.platformUserId, displayName: t.displayName, expiresAt: t.expiresAt });
      byGroup.set(t.groupId, arr);
    }
    return byGroup;
  }, [typers]);
}
