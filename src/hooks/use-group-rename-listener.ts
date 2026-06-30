"use client";

/**
 * useGroupRenameListener — fires a callback when any group in this workspace
 * is renamed on Telegram (bridge detects UpdateChatParticipantAdd / etc. and
 * publishes SSE "group:renamed"). The caller typically wires it to their
 * existing data refetch function so the UI stays in sync without a manual
 * reload.
 *
 * The event payload is { groupId, oldTitle, newTitle }; we forward that
 * straight to the callback so pages that cache data can do a targeted
 * update instead of a full refetch if they want.
 */

import { useSSE } from "@/hooks/use-sse";

type Payload = { groupId: string; oldTitle: string; newTitle: string };

export function useGroupRenameListener(
  workspaceId: string,
  onRename: (payload: Payload) => void,
) {
  useSSE({
    workspaceId,
    onMessage: (evt: { type: string; data?: Record<string, unknown> }) => {
      if (evt.type !== "group:renamed" || !evt.data) return;
      const { groupId, oldTitle, newTitle } = evt.data as Partial<Payload>;
      if (!groupId || !newTitle) return;
      onRename({
        groupId,
        oldTitle: oldTitle ?? "",
        newTitle,
      });
    },
  });
}
