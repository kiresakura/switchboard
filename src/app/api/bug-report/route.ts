import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";
import { logger } from "@/lib/logger";

const log = logger("BugReport");

// Telegram Bot API configuration
// Get from @BotFather: https://t.me/BotFather
const BUG_REPORT_BOT_TOKEN = process.env.BUG_REPORT_BOT_TOKEN;
const BUG_REPORT_CHAT_ID = process.env.BUG_REPORT_CHAT_ID;

interface TelegramResponse {
  ok: boolean;
  result?: {
    message_id: number;
  };
  description?: string;
}

// POST /api/bug-report
// Send a bug report to the configured Telegram group via Bot API
export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  if (!BUG_REPORT_BOT_TOKEN || !BUG_REPORT_CHAT_ID) {
    return NextResponse.json(
      { error: "Bug 通報功能未設定" },
      { status: 503 }
    );
  }

  let body: {
    title?: string;
    description?: string;
    page?: string;
    severity?: "low" | "medium" | "high" | "critical";
    reproduction?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const { title, description, page, severity = "medium", reproduction } = body;

  if (!title || !description) {
    return NextResponse.json(
      { error: "標題和描述為必填" },
      { status: 400 }
    );
  }

  if (title.length > 200 || description.length > 5000) {
    return NextResponse.json(
      { error: "標題上限 200 字元，描述上限 5000 字元" },
      { status: 400 }
    );
  }

  // Format the bug report message
  const severityEmoji = {
    low: "🟢",
    medium: "🟡",
    high: "🟠",
    critical: "🔴",
  }[severity];

  const now = new Date().toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const message = [
    `${severityEmoji} *Bug Report*`,
    "",
    `*標題:* ${title}`,
    `*嚴重程度:* ${severity.toUpperCase()}`,
    `*回報人:* ${auth.displayName} (@${auth.username})`,
    `*時間:* ${now}`,
    page ? `*頁面:* ${page}` : "",
    "",
    "*描述:*",
    description,
    reproduction ? "" : "",
    reproduction ? "*重現步驟:*" : "",
    reproduction || "",
  ].filter(Boolean).join("\n");

  // Send via Telegram Bot API
  let sent = false;
  let messageId: number | undefined;
  let errorMessage: string | undefined;

  try {
    const botUrl = `https://api.telegram.org/bot${BUG_REPORT_BOT_TOKEN}/sendMessage`;
    const response = await fetch(botUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 10s — Telegram Bot API 通常 < 1s 回，慢網路下避免無限等
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        chat_id: BUG_REPORT_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
      }),
    });

    const data: TelegramResponse = await response.json();

    if (data.ok && data.result) {
      sent = true;
      messageId = data.result.message_id;
    } else {
      errorMessage = data.description || "未知錯誤";
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    log.warn("Failed to send bug report via Telegram Bot API", { error: errorMessage });
  }

  // Log the bug report to audit trail regardless of Telegram success
  await logAudit({
    workspaceId: null as unknown as string,
    userId: auth.userId,
    action: "bug_report.submitted",
    entityType: "BugReport",
    entityId: crypto.randomUUID(),
    details: {
      title,
      severity,
      page,
      sentViaTelegram: sent,
      telegramError: errorMessage,
    },
  }).catch(() => {});

  return NextResponse.json({
    success: true,
    sent,
    messageId,
    error: errorMessage,
  });
}

// GET /api/bug-report
// Check if bug reporting is configured
export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({
    enabled: !!(BUG_REPORT_BOT_TOKEN && BUG_REPORT_CHAT_ID),
  });
}
