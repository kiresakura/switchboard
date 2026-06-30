import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { logger } from "@/lib/logger";

const log = logger("ReactorList");

type RouteParams = {
  params: Promise<{
    workspaceId: string;
    groupId: string;
    messageId: string;
  }>;
};

const BRIDGE_URL = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

/**
 * P2 2026-05-20:列出 DCM 訊息的「reaction 反應者」。
 *
 * 用 DCM id 在 DB 找到 platformMessageId / accountId / platformGroupId,
 * 然後呼叫 bridge `/get-reaction-list`。回傳 shape 對齊 UI popover 需要的
 * { platformUserId, displayName, emoji, date }。
 *
 * 若訊息還沒同步到 TG (platformMessageId null) → 回空陣列(本地草稿沒有
 * reactor)。
 */
export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId, groupId, messageId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const dcm = await prisma.directChatMessage.findFirst({
    where: { id: messageId, workspaceId, groupId },
    select: {
      id: true,
      accountId: true,
      platformMessageId: true,
      group: { select: { platformGroupId: true } },
    },
  });
  if (!dcm) {
    return NextResponse.json({ error: "找不到訊息" }, { status: 404 });
  }
  if (!dcm.platformMessageId || !dcm.group.platformGroupId) {
    return NextResponse.json({ reactors: [] });
  }
  if (!INTERNAL_SECRET) {
    return NextResponse.json(
      { error: "bridge 未設定 INTERNAL_SECRET" },
      { status: 500 }
    );
  }

  try {
    const res = await fetch(`${BRIDGE_URL}/get-reaction-list`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET}`,
      },
      body: JSON.stringify({
        accountId: dcm.accountId,
        chatId: dcm.group.platformGroupId,
        messageId: Number(dcm.platformMessageId),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return NextResponse.json({ reactors: [] });
    }
    const data = (await res.json()) as {
      reactions?: Array<{
        platformUserId: string;
        firstName: string | null;
        lastName: string | null;
        username: string | null;
        emoji: string;
        date: string | null;
      }>;
    };
    return NextResponse.json({
      reactors: (data.reactions ?? []).map((r) => ({
        platformUserId: r.platformUserId,
        displayName:
          [r.firstName, r.lastName].filter(Boolean).join(" ").trim() ||
          r.username ||
          "(未知)",
        username: r.username,
        emoji: r.emoji,
        date: r.date,
      })),
    });
  } catch (err) {
    log.warn("bridge /get-reaction-list failed", { error: String(err).slice(0, 200) });
    return NextResponse.json({ reactors: [] });
  }
}
