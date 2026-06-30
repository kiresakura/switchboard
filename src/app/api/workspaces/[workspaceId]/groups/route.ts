import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";

type RouteParams = { params: Promise<{ workspaceId: string }> };

type LastMessagePreview = {
  content: string;
  timestamp: string;
  senderName: string | null;
  senderPlatformId: string | null;
  /** "incoming" (from TG) or "outgoing" (CS staff sent). */
  direction: "incoming" | "outgoing";
  messageType: string;
};

// GET /api/workspaces/:id/groups
export async function GET(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const side = url.searchParams.get("side");
  const chatType = url.searchParams.get("chatType"); // GROUP | PRIVATE | CHANNEL
  const includeHidden = url.searchParams.get("includeHidden") === "true";
  // TG-style chat previews: opt-in so non-chat consumers (groups-management)
  // don't pay the cost. When true, returns the latest message per group
  // (from DirectChatMessage) plus sorts groups by last-activity DESC.
  // (broker-strip 2026-05-20: INTERNAL tag filter removed — no more
  // pairing candidate list, no more internal-chat page, so the tag is
  // unused. scope/includeInternal flags also dropped.)
  const includePreview = url.searchParams.get("includePreview") === "true";

  // 四層權限可見性 (Backend-first 2026-05-21):非 admin 員工只看得到歸自己的帳號的對話。
  // 此 set 包含:admin = 工作區全部帳號;主管 = 監督 Team 內帳號;
  // 員工 = AccountAssignment 指派 + 有效 AccountDelegation 接管的帳號。
  const visibleAccountIds = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  // 沒任何帳號可見 → 直接回空清單,避免後續 query 全表掃描。
  if (visibleAccountIds.size === 0) {
    return NextResponse.json({ groups: [] });
  }

  // 對話列表(includePreview)必須顯示「有往來但尚未 opt-in」的新私訊:
  // bridge 對新私訊 auto-register 成 isActive=false + isHidden=true(opt-in 模式,
  // 不跑審核/轉發 pipeline),CS 一定要能看到新客戶來訊並回覆。
  // 安全收窄(2026-06):只放行這個「opt-in 待辦」的明確組合(isActive=false +
  // isHidden=true),不是整個 chatType=PRIVATE — 否則任何被停用/封鎖/手動清理而
  // isActive=false 的舊私訊都會冒回列表,洩漏本應隱藏的對話。已啟用的私訊走第一條
  // OR;群組/頻道與非 includePreview 維持嚴格。
  const activeVisibilityFilter = includePreview
    ? {
        OR: [
          { isActive: true, ...(!includeHidden && { isHidden: false }) },
          { chatType: "PRIVATE" as const, isActive: false, isHidden: true },
        ],
      }
    : { isActive: true, ...(!includeHidden && { isHidden: false }) };

  const groups = await prisma.group.findMany({
    where: {
      workspaceId,
      ...activeVisibilityFilter,
      ...(side && ["CUSTOMER", "INTERNAL", "UNASSIGNED"].includes(side) && { side: side as "CUSTOMER" | "INTERNAL" | "UNASSIGNED" }),
      ...(chatType && ["GROUP", "PRIVATE", "CHANNEL"].includes(chatType) && { chatType }),
      // visibility scope:此 group 至少有一個 accountMembership 落在可見帳號集合
      accountMemberships: {
        some: { accountId: { in: Array.from(visibleAccountIds) } },
      },
    },
    include: {
      accountMemberships: {
        include: {
          account: { select: { id: true, displayName: true } },
        },
      },
      _count: {
        // (pairingLinks 計數在 H4 broker-strip 拿掉。)
        select: { accountMemberships: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!includePreview || groups.length === 0) {
    return NextResponse.json({ groups });
  }

  // Fetch the latest message per group from DirectChatMessage. (H4 broker-strip
  // removed Message + MessageForward — DCM is the single source now.)
  // DISTINCT ON gives just the latest row per group in one round trip,
  // O(1) regardless of group count (was previously N+1 across two extra tables).
  const groupIds = groups.map((g) => g.id);
  type DirectRow = {
    groupId: string;
    content: string;
    createdAt: Date;
    direction: "INBOUND" | "OUTBOUND";
    messageType: string;
    senderDisplayName: string | null;
    senderPlatformId: string | null;
    senderUserDisplayName: string | null;
    accountDisplayName: string | null;
  };
  const directRows = await prisma.$queryRaw<DirectRow[]>`
    SELECT DISTINCT ON (dcm."groupId")
      dcm."groupId", dcm.content, dcm."createdAt", dcm.direction::text AS direction,
      dcm."messageType"::text AS "messageType",
      dcm."senderDisplayName", dcm."senderPlatformId",
      u."displayName" AS "senderUserDisplayName",
      ca."displayName" AS "accountDisplayName"
    FROM "DirectChatMessage" dcm
    LEFT JOIN "User" u ON u.id = dcm."senderId"
    LEFT JOIN "CommunicationAccount" ca ON ca.id = dcm."accountId"
    WHERE dcm."workspaceId" = ${workspaceId}
      AND dcm."groupId" = ANY(${groupIds}::text[])
    ORDER BY dcm."groupId", dcm."createdAt" DESC
  `;

  const directByGroup = new Map(directRows.map((r) => [r.groupId, r]));

  const previews = groups.map(
    (g): { id: string; last: LastMessagePreview | null } => {
      const direct = directByGroup.get(g.id) ?? null;
      if (!direct) return { id: g.id, last: null };

      const isInbound = direct.direction === "INBOUND";
      // OUTBOUND preview 跟詳細聊天頁一致：「TG帳號名(Switchboard 操作者)」
      // 兩者都在 → 顯示「TG名(操作者)」；只有其一 → 退化只顯示一個；都沒有 → "(系統)"
      let outboundLabel: string;
      const tgName = direct.accountDisplayName ?? direct.senderDisplayName ?? null;
      const opName = direct.senderUserDisplayName ?? null;
      if (tgName && opName) outboundLabel = `${tgName}(${opName})`;
      else outboundLabel = tgName ?? opName ?? "(系統)";

      const last: LastMessagePreview = {
        content: direct.content,
        timestamp: direct.createdAt.toISOString(),
        senderName: isInbound
          ? (direct.senderDisplayName ?? direct.senderPlatformId ?? "Unknown")
          : outboundLabel,
        senderPlatformId: isInbound ? direct.senderPlatformId : null,
        direction: isInbound ? "incoming" : "outgoing",
        messageType: direct.messageType,
      };
      return { id: g.id, last };
    },
  );

  const previewMap = new Map(previews.map((p) => [p.id, p.last]));
  const enriched = groups
    .map((g) => ({ ...g, lastMessage: previewMap.get(g.id) ?? null }))
    .sort((a, b) => {
      // P1 釘選對話置頂:有 conversationPinnedAt 的排最上面,同樣置頂的依
      // pinnedAt DESC(後釘的更上面)。pinned vs unpinned 一律 pinned 優先,
      // 不管 lastMessage 時間。
      const aP = a.conversationPinnedAt?.getTime() ?? 0;
      const bP = b.conversationPinnedAt?.getTime() ?? 0;
      if (aP && !bP) return -1;
      if (bP && !aP) return 1;
      if (aP && bP) return bP - aP;
      // 沒釘的依最後訊息時間排
      const aTs = a.lastMessage?.timestamp ?? "";
      const bTs = b.lastMessage?.timestamp ?? "";
      if (aTs && bTs) return bTs.localeCompare(aTs);
      if (aTs) return -1;
      if (bTs) return 1;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

  return NextResponse.json({ groups: enriched });
}
