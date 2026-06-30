import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { logger } from "@/lib/logger";

const log = logger("GroupMembers");

type RouteParams = {
  params: Promise<{ workspaceId: string; groupId: string }>;
};

const BRIDGE_URL = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

/**
 * P2 2026-05-20:列出 TG 群組 / 頻道的成員清單。
 *
 * 流程:
 *   1) 找此 workspace 在 group 內的 ACTIVE 帳號(任一個能拿來打 TG)
 *   2) 呼叫 bridge `/list-participants`(包 GramJS iterParticipants)
 *   3) 回傳 { members: [{platformUserId, displayName, avatarUrl?}] }
 *
 * 上限 200(bridge 那邊 default),超大群組超出範圍會被截掉。1:1 PRIVATE
 * 不適用 — 直接回 [](members 概念對單人不存在)。
 */
export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const group = await prisma.group.findFirst({
    where: { id: groupId, workspaceId },
    select: {
      id: true,
      chatType: true,
      platformGroupId: true,
      accountMemberships: {
        where: { account: { status: "ACTIVE" } },
        select: { accountId: true },
        take: 1,
      },
    },
  });
  if (!group) {
    return NextResponse.json({ error: "找不到群組" }, { status: 404 });
  }
  if (group.chatType === "PRIVATE") {
    return NextResponse.json({ members: [] });
  }
  const accountId = group.accountMemberships[0]?.accountId;
  if (!accountId || !INTERNAL_SECRET) {
    return NextResponse.json({ members: [] });
  }

  try {
    const res = await fetch(`${BRIDGE_URL}/list-participants`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET}`,
      },
      body: JSON.stringify({ accountId, chatId: group.platformGroupId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return NextResponse.json({ members: [] });
    }
    const data = (await res.json()) as {
      participants?: Array<{ platformUserId: string; displayName: string | null }>;
    };
    return NextResponse.json({
      members: (data.participants ?? []).map((p) => ({
        platformUserId: p.platformUserId,
        displayName: p.displayName || "(未命名)",
        avatarUrl: `/api/workspaces/${workspaceId}/avatars/${encodeURIComponent(p.platformUserId)}`,
      })),
    });
  } catch (err) {
    log.warn("bridge /list-participants failed", { error: String(err).slice(0, 200) });
    return NextResponse.json({ members: [] });
  }
}
