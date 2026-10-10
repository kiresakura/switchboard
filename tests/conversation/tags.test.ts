import { describe, expect, it } from "vitest";
import { normalizeConversationTags } from "@/lib/conversation/tags";

describe("normalizeConversationTags", () => {
  it("rejects anything that is not an array", () => {
    expect(() => normalizeConversationTags("vip")).toThrow(TypeError);
    expect(() => normalizeConversationTags(null)).toThrow(TypeError);
  });

  it("trims, drops invalid entries and de-duplicates in order", () => {
    expect(
      normalizeConversationTags([" vip ", "vip", "", "   ", 42, null, "x".repeat(33), "refund"]),
    ).toEqual(["vip", "refund"]);
  });

  it("keeps a 32-character tag", () => {
    expect(normalizeConversationTags(["x".repeat(32)])).toEqual(["x".repeat(32)]);
  });

  it("caps the list at 20 tags", () => {
    const tags = Array.from({ length: 25 }, (_, i) => `tag-${i}`);
    expect(normalizeConversationTags(tags)).toEqual(tags.slice(0, 20));
  });
});
