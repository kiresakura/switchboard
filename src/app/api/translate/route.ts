import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/middleware";
import { logger } from "@/lib/logger";
import { createRateLimiter } from "@/lib/rate-limit";

const log = logger("Translate");

// Per-user translation limiter — Google's free endpoint is shared and easy
// to abuse; keep usage in line with realistic interactive review pace.
const translateLimiter = createRateLimiter({ max: 30, windowMs: 60_000 });

// POST /api/translate — translate text to target language
export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  if (!translateLimiter.consume(auth.userId)) {
    return NextResponse.json(
      { error: "翻譯次數過於頻繁，請稍後再試" },
      { status: 429 }
    );
  }

  let body: { text?: string; targetLang?: string; sourceLang?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const { text, targetLang = "zh-TW", sourceLang } = body;

  if (!text || text.trim().length === 0) {
    return NextResponse.json({ error: "text 為必填" }, { status: 400 });
  }

  if (text.length > 5000) {
    return NextResponse.json({ error: "文字過長（上限 5000 字）" }, { status: 400 });
  }

  try {
    // Use Google Translate free endpoint
    const params = new URLSearchParams({
      client: "gtx",
      sl: sourceLang || "auto",
      tl: targetLang,
      dt: "t",
      q: text,
    });

    const res = await fetch(
      `https://translate.googleapis.com/translate_a/single?${params}`,
      { signal: AbortSignal.timeout(10000) }
    );

    if (!res.ok) {
      log.warn("Google Translate API error", { status: res.status });
      return NextResponse.json(
        { error: "翻譯服務暫時不可用" },
        { status: 502 }
      );
    }

    const data = await res.json();

    // Google Translate returns [[["translated text","original text",...],...],...]
    let translated = "";
    if (Array.isArray(data) && Array.isArray(data[0])) {
      for (const segment of data[0]) {
        if (Array.isArray(segment) && segment[0]) {
          translated += segment[0];
        }
      }
    }

    const detectedLang = Array.isArray(data) && data[2] ? String(data[2]) : sourceLang || "auto";

    return NextResponse.json({
      original: text,
      translated: translated || text,
      sourceLang: detectedLang,
      targetLang,
    });
  } catch (err) {
    log.error("Translation failed", { error: String(err) });
    return NextResponse.json(
      { error: "翻譯失敗，請稍後再試" },
      { status: 500 }
    );
  }
}
