import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { eventBus } from "@/lib/realtime/event-bus";
import type { SSEEventType } from "@/lib/realtime/event-bus";
import { isPlaceholderSecret } from "@/lib/security/secret-guard";

// S4 fix: timing-safe comparison for INTERNAL_SECRET
function verifyInternalSecret(authHeader: string | null): boolean {
  const expectedToken = process.env.INTERNAL_SECRET;
  // C3: never authenticate against a build-time/dev placeholder secret.
  if (!expectedToken || isPlaceholderSecret(expectedToken) || !authHeader) return false;
  const expected = `Bearer ${expectedToken}`;
  if (authHeader.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
}

// POST /api/internal/telegram-event
// Called by the Telegram bridge worker to push events to SSE clients
export async function POST(request: Request) {
  // Verify internal secret
  if (!verifyInternalSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "未授權" }, { status: 401 });
  }

  let body: { type?: string; workspaceId?: string; data?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }
  const { type, workspaceId, data } = body;

  if (!type || !workspaceId) {
    return NextResponse.json(
      { error: "type 與 workspaceId 為必填" },
      { status: 400 }
    );
  }

  eventBus.publish({
    type: type as SSEEventType,
    workspaceId,
    data: data || {},
  });

  return NextResponse.json({ success: true });
}
