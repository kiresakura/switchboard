import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";

type RouteParams = {
  params: Promise<{ workspaceId: string; groupId: string }>;
};

type ReactionSummary = {
  emoji: string;
  count: number;
  chosen: boolean;
};

/**
 * Bytes-less media metadata — shape mirrors `MediaMetadata` in
 * `src/lib/telegram/client-manager.ts`. Type-only here (we don't import
 * from the bridge module to keep this API route lean).
 */
type ChatMessageMediaMetadata = {
  geo?: { lat: number; lng: number; livePeriod?: number };
  contact?: { firstName?: string; lastName?: string; phone?: string; userId?: string };
  poll?: {
    question: string;
    options: Array<{ text: string; voters?: number }>;
    totalVoters?: number;
    closed?: boolean;
  };
};

type ChatMessageForwardedFrom = {
  senderName?: string;
  senderPlatformUserId?: string;
  channelTitle?: string;
  channelPlatformId?: string;
  originalMessageId?: string;
  date?: string;
};

type ChatMessage = {
  id: string;
  content: string;
  sender: string;
  /** Raw Telegram user id for bridge-originated messages; null otherwise. */
  senderPlatformId?: string | null;
  timestamp: string;
  source: "direct" | "bridge";
  direction: "outgoing" | "incoming";
  messageType: string;
  status?: string;
  isDeleted?: boolean;
  deletedAt?: string | null;
  editedAt?: string | null;
  mediaUrl?: string | null;
  mediaType?: string | null;
  mediaFileName?: string | null;
  /** Bytes-less payload(LOCATION / CONTACT / POLL)。 */
  mediaMetadata?: ChatMessageMediaMetadata | null;
  /** P2: 轉發來源 metadata;原生訊息為 null。 */
  forwardedFrom?: ChatMessageForwardedFrom | null;
  /** P2: TG forum topic id;非 forum 訊息為 null。 */
  topicId?: number | null;
  /** P3: Channel post view count;非 channel 訊息為 null。 */
  viewCount?: number | null;
  /** P3: TG quote reply 引用片段;一般回覆為 null。 */
  quoteText?: string | null;
  /** Telegram message id of this message — used for reply lookups. */
  platformMessageId?: string | null;
  /** Telegram message id this message is a reply to, if any. */
  replyToPlatformId?: string | null;
  /** Cached emoji reactions from TG（DirectChatMessage only）；null = 還沒收 reaction event */
  reactions?: ReactionSummary[] | null;
  /** 訊息釘選時間;null = 未釘。CS 內部標記,把重要訊息釘到對話視窗頂端。 */
  pinnedAt?: string | null;
};

// GET /api/workspaces/:workspaceId/groups/:groupId/chat?limit=50&before=<cursor>
export async function GET(req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;

  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  // 可見性:員工只能讀自己被指派 / 代理帳號的對話歷史(2026-05-21 review 補)。
  const visible = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });

  // 只驗 ownership — 不過濾 isActive。原本要求 isActive=true 會把「停用群組」
  // 的對話歷史擋掉，但 bridge 改為「停用 + 群組」會 archive-only（仍存歷史）
  // 之後，讀取端也應該對應放寬。否則使用者只能看到對話的「半邊」。
  const group = await prisma.group.findFirst({
    where: {
      id: groupId,
      workspaceId,
      ...(visible.size > 0
        ? {
            accountMemberships: {
              some: { accountId: { in: Array.from(visible) } },
            },
          }
        : { id: "__never_match__" }),
    },
  });

  if (!group) {
    return NextResponse.json({ error: "找不到群組" }, { status: 404 });
  }

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);
  const before = url.searchParams.get("before") || undefined;

  // 共用的 select 形狀（不含 reactions） — reactions 是 0009 才加的欄位，
  // 為了能在「程式已 deploy、migrate 還沒跑」的環境（典型 Railway auto-deploy
  // 不含自動 migrate）下不爆掉，先用基礎 select 撈、再用 raw SQL 補 reactions。
  // 這個降級在 reactions 欄位不存在時靜默跳過，整支 API 仍能回訊息給前端。
  const directSelectBase = {
    id: true,
    content: true,
    messageType: true,
    createdAt: true,
    sentViaTelegram: true,
    mediaUrl: true,
    mediaType: true,
    mediaFileName: true,
    mediaMetadata: true,
    forwardedFrom: true,
    topicId: true,
    viewCount: true,
    quoteText: true,
    direction: true,
    senderPlatformId: true,
    senderDisplayName: true,
    platformMessageId: true,
    replyToPlatformId: true,
    // 真實已讀回執 (2026-05-21 Backend-first) — bridge UpdateReadHistory* 回填,
    // OUTBOUND 才有意義。直接 select 不走 raw SQL 是因為這次 schema 跟 prisma client
    // 一起 push,沒有 "code deployed before migrate" 視窗;若部署順序顛倒會吃 prisma 警告。
    deliveredAt: true,
    readAt: true,
    // 2026-05-21 TG parity:Message entities + Album grouped_id。
    entities: true,
    groupedId: true,
    replyMarkup: true,
    sender: { select: { id: true, displayName: true } },
    account: { select: { id: true, displayName: true } },
  } as const;

  // Single-source chat history: DirectChatMessage. (Broker Message table
  // dropped in H4 — there is no second source to merge with any more.)
  const directMessages = await prisma.directChatMessage.findMany({
    where: { workspaceId, groupId },
    orderBy: { createdAt: "desc" },
    take: limit,
    ...(before ? { cursor: { id: before }, skip: 1 } : {}),
    select: directSelectBase,
  });

  // Reactions + soft-delete + editedAt：用 raw SQL 一次撈三個 0009/0010 才有的
  // 欄位，跑不過（欄位還沒套 migration）就靜默降級成 null/false。
  // 為什麼不放 select：Prisma 的 select 對欄位不存在會丟 PrismaClientKnownRequestError，
  // 整支 API 變 5xx → 前端看不到歷史。改 raw SQL + try-catch 確保是「有就帶、
  // 沒有就 null/false」的軟條件，跟前端 ChatBubble 的 isDeleted/editedAt 渲染相容。
  type DcmExtras = {
    reactions: ReactionSummary[] | null;
    isDeleted: boolean;
    deletedAt: string | null;
    editedAt: string | null;
    pinnedAt: string | null;
  };
  const extrasByDcmId = new Map<string, DcmExtras>();
  if (directMessages.length > 0) {
    const ids = directMessages.map((d) => d.id);
    // 1) reactions（0009）
    try {
      const rows = await prisma.$queryRaw<Array<{ id: string; reactions: unknown }>>`
        SELECT "id", "reactions"
          FROM "DirectChatMessage"
         WHERE "id" IN (${Prisma.join(ids)})
      `;
      for (const r of rows) {
        extrasByDcmId.set(r.id, {
          reactions: (r.reactions as ReactionSummary[] | null) ?? null,
          isDeleted: false,
          deletedAt: null,
          editedAt: null,
          pinnedAt: null,
        });
      }
    } catch {
      // schema 0009 未套 → 整支 query 失敗，下方 mapping 會看到全 null。
    }
    // 2) soft-delete + editedAt + pinnedAt — 獨立 try/catch 因為這些欄位可能不同步
    try {
      const rows = await prisma.$queryRaw<
        Array<{
          id: string;
          isDeleted: boolean;
          deletedAt: Date | null;
          editedAt: Date | null;
          pinnedAt: Date | null;
        }>
      >`
        SELECT "id", "isDeleted", "deletedAt", "editedAt", "pinnedAt"
          FROM "DirectChatMessage"
         WHERE "id" IN (${Prisma.join(ids)})
      `;
      for (const r of rows) {
        const cur = extrasByDcmId.get(r.id) ?? {
          reactions: null,
          isDeleted: false,
          deletedAt: null,
          editedAt: null,
          pinnedAt: null,
        };
        extrasByDcmId.set(r.id, {
          ...cur,
          isDeleted: !!r.isDeleted,
          deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
          editedAt: r.editedAt ? r.editedAt.toISOString() : null,
          pinnedAt: r.pinnedAt ? r.pinnedAt.toISOString() : null,
        });
      }
    } catch {
      // schema 未套 → soft-delete/edited/pinned 全部維持 null/false。
    }
  }

  // Map direct messages. OUTBOUND = CS staff sent; INBOUND = archived TG msg.
  const directMapped: ChatMessage[] = directMessages.map((dm) => ({
    id: dm.id,
    content: dm.content,
    // OUTBOUND 顯示格式：「TG帳號名(Switchboard 操作者)」例 「午夜的大叔(System Admin)」
    //   - dm.account.displayName = 連到 TG 的Telegram 帳號名（送出端）
    //   - dm.sender.displayName  = 在 Switchboard 後台操作這條送出的使用者
    // 兩者都在時顯示「TG名(操作者)」；只有其一時退化顯示；都沒有 fallback「(系統)」
    sender:
      dm.direction === "INBOUND"
        ? (dm.senderDisplayName ?? dm.senderPlatformId ?? "Unknown")
        : (() => {
            const tgName = dm.account?.displayName ?? dm.senderDisplayName ?? null;
            const opName = dm.sender?.displayName ?? null;
            if (tgName && opName) return `${tgName}(${opName})`;
            return tgName ?? opName ?? "(系統)";
          })(),
    senderPlatformId: dm.direction === "INBOUND" ? dm.senderPlatformId : null,
    timestamp: dm.createdAt.toISOString(),
    source: "direct" as const,
    direction: dm.direction === "INBOUND" ? ("incoming" as const) : ("outgoing" as const),
    messageType: dm.messageType,
    status:
      dm.direction === "INBOUND"
        ? "received"
        : dm.sentViaTelegram
          ? "sent"
          : "pending",
    mediaUrl: dm.mediaUrl,
    mediaType: dm.mediaType,
    mediaFileName: dm.mediaFileName,
    mediaMetadata: (dm.mediaMetadata as ChatMessageMediaMetadata | null) ?? null,
    forwardedFrom: (dm.forwardedFrom as ChatMessageForwardedFrom | null) ?? null,
    topicId: dm.topicId ?? null,
    viewCount: dm.viewCount ?? null,
    quoteText: dm.quoteText ?? null,
    platformMessageId: dm.platformMessageId,
    replyToPlatformId: dm.replyToPlatformId,
    // 從 raw SQL fetch 的 0009/0010 欄位（schema 未套就降級為 null/false）
    reactions: extrasByDcmId.get(dm.id)?.reactions ?? null,
    isDeleted: extrasByDcmId.get(dm.id)?.isDeleted ?? false,
    deletedAt: extrasByDcmId.get(dm.id)?.deletedAt ?? null,
    editedAt: extrasByDcmId.get(dm.id)?.editedAt ?? null,
    pinnedAt: extrasByDcmId.get(dm.id)?.pinnedAt ?? null,
    // 真實已讀回執 (2026-05-21 Backend-first):OUTBOUND 才有意義,
    // bridge UpdateReadHistoryOutbox/Inbox 回填。
    deliveredAt: dm.deliveredAt ? dm.deliveredAt.toISOString() : null,
    readAt: dm.readAt ? dm.readAt.toISOString() : null,
    // 2026-05-21 TG parity:Message entities (JSON 原樣 forward) + groupedId。
    entities: dm.entities ?? null,
    groupedId: dm.groupedId ?? null,
    replyMarkup: dm.replyMarkup ?? null,
  }));

  // DCM 已用 `orderBy: createdAt desc` + `take: limit` 取出，這裡 sort 只是
  // 保險（之後如果加入別的訊息來源 — 例如系統訊息 — 仍能正確排序）。
  const allMessages = directMapped
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);

  // Check if there are more messages beyond what we returned
  const hasMore = directMessages.length === limit;

  return NextResponse.json({ messages: allMessages, hasMore });
}
