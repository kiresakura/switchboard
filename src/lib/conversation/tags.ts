const MAX_CONVERSATION_TAGS = 20;
const MAX_CONVERSATION_TAG_LENGTH = 32;

/**
 * Normalize free-form conversation tags before storing them on Group.tags.
 *
 * Group.tags is intentionally a free-string array (WorkspaceTag is only the
 * vocabulary/suggestion list), so every write path must enforce the same small
 * contract: trim, drop non-strings/empty/too-long values, de-dupe, cap count.
 */
export function normalizeConversationTags(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new TypeError("tags must be an array");
  }

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim();
    if (!tag || tag.length > MAX_CONVERSATION_TAG_LENGTH || seen.has(tag)) {
      continue;
    }

    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_CONVERSATION_TAGS) break;
  }

  return tags;
}
