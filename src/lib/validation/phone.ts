/**
 * 電話號碼正規化 + 驗證 — 給 TG 帳號註冊用。
 *
 * 設計原則：
 *   - 接受使用者各種輸入方式（含空格、破折號、括號），自動清乾淨
 *   - 預設國家：台灣（+886）。台灣本地式 09XX 自動補成 +886 9XX
 *   - 其他國家不假設 — 必須使用者明確帶 + 國碼
 *   - 嚴格遵守 E.164：總長 8–15 位數字（不含 +），第一位非 0
 */

const TAIWAN_CC = "886";

export type PhoneValidationResult =
  | { ok: true; e164: string }
  | { ok: false; error: string };

/**
 * 把使用者輸入清成「只有 + 跟數字」。
 *   "+886 912-345-678"   → "+886912345678"
 *   "(02) 1234-5678"     → "0212345678"
 *   "0912.345.678"       → "0912345678"
 */
export function stripPhoneFormatting(raw: string): string {
  if (!raw) return "";
  // 保留第一個 +（如果有）；其他全部去掉，只留數字
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D+/g, "");
  return (hasPlus ? "+" : "") + digits;
}

/**
 * 把使用者輸入正規化成 E.164 格式（+ + 國碼 + 號碼）。
 *
 * 優先順序：
 *   1. 已帶 + → 維持，去格式化
 *   2. 台灣本地 0 開頭（09XX / 02 / 03...）→ 視為台灣，去 0 補 +886
 *   3. 純數字、無 + 無 0 → 假設使用者忘了 + → 補上 +
 *   4. 其他 → 空字串（無法正規化）
 */
export function normalizePhone(raw: string): string {
  const cleaned = stripPhoneFormatting(raw);
  if (!cleaned) return "";

  if (cleaned.startsWith("+")) {
    return cleaned;
  }

  // 台灣本地式 0 開頭（09XX / 02 / 03 / 04 / 05 / 06 / 07 / 08）
  if (cleaned.startsWith("0") && cleaned.length >= 9) {
    return `+${TAIWAN_CC}${cleaned.slice(1)}`;
  }

  // 純數字 → 假設使用者忘了 +，自動補上
  if (/^\d+$/.test(cleaned)) {
    return `+${cleaned}`;
  }

  return "";
}

/**
 * 驗證 E.164 格式：
 *   - 必須以 + 開頭
 *   - 接著 7–15 位數字
 *   - 第一位數字不可為 0（國碼第一位非 0）
 *
 * 回傳 ok=true 並附上正規化後的 e164 字串，或 ok=false 並附人類可讀錯誤。
 */
export function validatePhone(raw: string): PhoneValidationResult {
  if (!raw || !raw.trim()) {
    return { ok: false, error: "請輸入電話號碼" };
  }

  const normalized = normalizePhone(raw);
  if (!normalized) {
    return {
      ok: false,
      error: "格式不正確 — 請輸入國際格式（例：+886912345678 或 0912345678）",
    };
  }

  // 形式：+ + (1-15 位數字)，第一位非 0
  const m = /^\+([1-9])(\d{6,14})$/.exec(normalized);
  if (!m) {
    const digits = normalized.replace(/\D/g, "");
    if (digits.length < 7) {
      return { ok: false, error: `太短了 — 國際格式至少 8 位數字（目前 ${digits.length} 位）` };
    }
    if (digits.length > 15) {
      return { ok: false, error: `太長了 — 國際格式最多 15 位數字（目前 ${digits.length} 位）` };
    }
    if (normalized.startsWith("+0")) {
      return { ok: false, error: "國碼第一位不可為 0" };
    }
    return { ok: false, error: "格式不正確" };
  }

  return { ok: true, e164: normalized };
}

/**
 * 給輸入過程中的「即時提示」用：判斷使用者打到目前的字串「看起來合法但還沒打完」，
 * 還是「已經能解析成有效號碼」。沒打完不顯示錯誤，已 OK 才顯示綠色勾。
 */
export type PhoneLiveStatus = "empty" | "incomplete" | "valid" | "invalid";

export function getPhoneLiveStatus(raw: string): {
  status: PhoneLiveStatus;
  hint?: string;
  e164?: string;
} {
  if (!raw || !raw.trim()) return { status: "empty" };

  const normalized = normalizePhone(raw);
  const digits = normalized.replace(/\D/g, "");

  if (digits.length === 0) {
    return { status: "invalid", hint: "只能輸入數字、空格、破折號、括號或 +" };
  }

  // 太短（< 7 數字） — 可能還在打，不算錯
  if (digits.length < 7) {
    return { status: "incomplete", hint: "繼續輸入..." };
  }

  const result = validatePhone(raw);
  if (result.ok) {
    return { status: "valid", e164: result.e164 };
  }
  return { status: "invalid", hint: result.error };
}
