import { describe, expect, it } from "vitest";
import { mediaThumbUrl, safeTitle } from "@/lib/utils";

describe("safeTitle", () => {
  it("strips zero-width and bidi override characters", () => {
    expect(safeTitle("Support​ Team‮gnp.exe")).toBe("Support Teamgnp.exe");
    expect(safeTitle("⁦Sales⁩")).toBe("Sales");
  });

  it("keeps right-to-left scripts intact", () => {
    expect(safeTitle("שלום مرحبا")).toBe("שלום مرحبا");
  });

  it("truncates long titles with an ellipsis", () => {
    expect(safeTitle("abcdef", 3)).toBe("abc…");
    expect(safeTitle("abc", 3)).toBe("abc");
    expect(safeTitle(null)).toBe("");
  });
});

describe("mediaThumbUrl", () => {
  it("adds the width only to internal media URLs", () => {
    expect(mediaThumbUrl("/api/media/abc", 400)).toBe("/api/media/abc?w=400");
    expect(mediaThumbUrl("https://example.com/a.png", 400)).toBe("https://example.com/a.png");
    expect(mediaThumbUrl("blob:http://localhost/123", 200)).toBe("blob:http://localhost/123");
  });
});
