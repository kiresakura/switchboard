import { describe, expect, it } from "vitest";
import {
  getPhoneLiveStatus,
  normalizePhone,
  stripPhoneFormatting,
  validatePhone,
} from "@/lib/validation/phone";

describe("stripPhoneFormatting", () => {
  it("keeps a leading + and digits only", () => {
    expect(stripPhoneFormatting("+886 912-345-678")).toBe("+886912345678");
    expect(stripPhoneFormatting("(02) 1234-5678")).toBe("0212345678");
    expect(stripPhoneFormatting("0912.345.678")).toBe("0912345678");
    expect(stripPhoneFormatting("")).toBe("");
  });
});

describe("normalizePhone", () => {
  it("treats a local number with a leading 0 as Taiwanese", () => {
    expect(normalizePhone("0912 345 678")).toBe("+886912345678");
    expect(normalizePhone("(02) 1234-5678")).toBe("+886212345678");
  });

  it("keeps explicit country codes and adds a missing +", () => {
    expect(normalizePhone("+1 (415) 555-2671")).toBe("+14155552671");
    expect(normalizePhone("886912345678")).toBe("+886912345678");
  });

  it("returns an empty string when there are no digits", () => {
    expect(normalizePhone("call me")).toBe("");
  });
});

describe("validatePhone", () => {
  it("returns the E.164 form for valid numbers", () => {
    expect(validatePhone("0912-345-678")).toEqual({ ok: true, e164: "+886912345678" });
    expect(validatePhone("+44 20 7946 0958")).toEqual({ ok: true, e164: "+442079460958" });
  });

  it("explains why a number is rejected", () => {
    expect(validatePhone("   ")).toEqual({ ok: false, error: "請輸入電話號碼" });
    expect(validatePhone("call me")).toMatchObject({ ok: false, error: expect.stringContaining("格式不正確") });
    expect(validatePhone("+1234567890123456")).toMatchObject({ ok: false, error: expect.stringContaining("太長了") });
    expect(validatePhone("+0912345678")).toEqual({ ok: false, error: "國碼第一位不可為 0" });
  });

  it("accepts 7 digits and reports the same minimum when shorter", () => {
    expect(validatePhone("+2901234")).toEqual({ ok: true, e164: "+2901234" });
    expect(validatePhone("+290123")).toEqual({
      ok: false,
      error: "太短了 — 國際格式至少 7 位數字（目前 6 位）",
    });
  });
});

describe("getPhoneLiveStatus", () => {
  it("does not flag a number that is still being typed", () => {
    expect(getPhoneLiveStatus("")).toEqual({ status: "empty" });
    expect(getPhoneLiveStatus("0912")).toMatchObject({ status: "incomplete" });
  });

  it("reports valid and invalid input", () => {
    expect(getPhoneLiveStatus("0912345678")).toEqual({ status: "valid", e164: "+886912345678" });
    expect(getPhoneLiveStatus("+0912345678")).toMatchObject({ status: "invalid" });
    expect(getPhoneLiveStatus("---")).toMatchObject({ status: "invalid" });
  });
});
