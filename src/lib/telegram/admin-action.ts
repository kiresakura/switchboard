import type { TelegramAdminAction } from "./client-manager";

const CHANNEL_ADMIN_RIGHT_KEYS = new Set([
  "changeInfo",
  "postMessages",
  "editMessages",
  "deleteMessages",
  "banUsers",
  "inviteUsers",
  "pinMessages",
  "addAdmins",
  "anonymous",
  "manageCall",
  "other",
  "manageTopics",
  "postStories",
  "editStories",
  "deleteStories",
]);

function nonEmptyString(value: unknown, maxLength = 256): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.floor(value);
  return n > 0 ? n : null;
}

function chatIdArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const id = nonEmptyString(raw, 64);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeRights(value: unknown): Record<string, boolean | undefined> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, boolean | undefined> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!CHANNEL_ADMIN_RIGHT_KEYS.has(key)) continue;
    if (typeof raw === "boolean") out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Validate and normalize the small Telegram management action envelope that the
 * Next API forwards to the bridge. Returns null for malformed / unsafe input.
 */
export function normalizeTelegramAdminAction(input: unknown): TelegramAdminAction | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const action = input as Record<string, unknown>;
  const kind = action.kind;

  if (kind === "pin-message") {
    const chatId = nonEmptyString(action.chatId, 64);
    const messageId = positiveInteger(action.messageId);
    if (!chatId || messageId == null) return null;
    return {
      kind,
      chatId,
      messageId,
      ...(typeof action.silent === "boolean" ? { silent: action.silent } : {}),
      ...(typeof action.unpin === "boolean" ? { unpin: action.unpin } : {}),
    };
  }

  if (kind === "dialog-pin") {
    const chatId = nonEmptyString(action.chatId, 64);
    if (!chatId || typeof action.pinned !== "boolean") return null;
    return {
      kind,
      chatId,
      pinned: action.pinned,
      ...(positiveInteger(action.folderId) != null ? { folderId: positiveInteger(action.folderId)! } : {}),
    };
  }

  if (kind === "folder-update") {
    const filterId = positiveInteger(action.filterId);
    const title = nonEmptyString(action.title, 64);
    const includeChatIds = chatIdArray(action.includeChatIds);
    if (filterId == null || !title || !includeChatIds || includeChatIds.length === 0) return null;
    const pinnedChatIds = chatIdArray(action.pinnedChatIds ?? []);
    const excludeChatIds = chatIdArray(action.excludeChatIds ?? []);
    return {
      kind,
      filterId,
      title,
      includeChatIds,
      ...(pinnedChatIds && pinnedChatIds.length > 0 ? { pinnedChatIds } : {}),
      ...(excludeChatIds && excludeChatIds.length > 0 ? { excludeChatIds } : {}),
      ...(typeof action.emoticon === "string" && action.emoticon.trim() ? { emoticon: action.emoticon.trim().slice(0, 16) } : {}),
    };
  }

  if (kind === "folder-delete") {
    const filterId = positiveInteger(action.filterId);
    return filterId == null ? null : { kind, filterId };
  }

  if (kind === "channel-title") {
    const chatId = nonEmptyString(action.chatId, 64);
    const title = nonEmptyString(action.title, 128);
    return !chatId || !title ? null : { kind, chatId, title };
  }

  if (kind === "channel-admin") {
    const chatId = nonEmptyString(action.chatId, 64);
    const userId = nonEmptyString(action.userId, 64);
    const rights = normalizeRights(action.rights);
    if (!chatId || !userId || !/^\d+$/.test(userId) || !rights) return null;
    return {
      kind,
      chatId,
      userId,
      rights,
      ...(typeof action.rank === "string" && action.rank.trim() ? { rank: action.rank.trim().slice(0, 32) } : {}),
    };
  }

  return null;
}
