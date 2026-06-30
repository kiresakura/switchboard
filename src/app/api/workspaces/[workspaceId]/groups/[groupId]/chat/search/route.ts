import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";

type RouteParams = {
  params: Promise<{ workspaceId: string; groupId: string }>;
};

/**
 * P1 2026-05-20: 在「整個對話歷史」搜尋訊息文字。
 *
 * 客戶端 in-chat 搜尋只 filter 目前載入的 50~N 則訊息,搜不到更舊的歷史。
 * 這支端點用 `content ILIKE %q%` 一次撈完(上限 200 筆),caller 可依此知道
 * 「更早歷史中還有幾筆命中」並選擇性地往前 loadMore 直到 match 進入視野。
 *
 * 安全:跟 chat history endpoint 同一條 RBAC(requireWorkspaceMember),透過
 * groupId 確認 workspace 歸屬。匹配字串會傳給 Prisma,Prisma 端會自動
 * 用 parameterized query 防 injection。
 */
export async function GET(req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  // 可見性:員工只能搜尋自己被指派 / 代理帳號的對話(2026-05-21 review 補)。
  const visible = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });

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
    select: { id: true },
  });
  if (!group) {
    return NextResponse.json({ error: "找不到群組" }, { status: 404 });
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  /**
   * 2026-05-21 媒體 filter — 對齊 TG 的 InputMessagesFilter*。
   *   photo    → IMAGE
   *   video    → VIDEO + VIDEO_NOTE(TG 把圓形短片也視為「video」)
   *   document → DOCUMENT
   *   voice    → VOICE
   *   audio    → AUDIO
   *   sticker  → STICKER
   *   url      → 不靠 messageType,改用 content 包含 http(s):// 為判斷
   * none / 空 = 不過濾。多個用 comma 隔開(filter=photo,video)。
   *
   * 規格選擇:filter 跟 q 是 AND 關係;只給 filter 沒給 q 也允許(media browser 模式)。
   * 對應 UI:右側面板「媒體 / 文件 / 連結」分頁。
   */
  const filterParam = url.searchParams.get("filter") ?? "";
  const filterTypes = filterParam
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const wantsMedia = filterTypes.length > 0;

  // 沒給 q 且沒給 filter → 空查詢
  if (q.length === 0 && !wantsMedia) {
    return NextResponse.json({ matches: [], totalCount: 0 });
  }
  if (q.length > 0 && q.length < 2) {
    // 太短 (1 字元) 容易 timeout / 用處小,直接拒絕
    return NextResponse.json(
      { error: "搜尋字串至少 2 個字元" },
      { status: 400 }
    );
  }

  // 把 UI 的 filter 名稱對到 MessageType enum。url filter 特殊:不靠 enum,
  // 改用 content 內含 URL pattern;此時 messageTypeIn=null,後面另外加 condition。
  const filterToTypes: Record<string, string[]> = {
    photo: ["IMAGE"],
    image: ["IMAGE"],
    video: ["VIDEO", "VIDEO_NOTE"],
    document: ["DOCUMENT"],
    voice: ["VOICE"],
    audio: ["AUDIO"],
    sticker: ["STICKER"],
    location: ["LOCATION"],
    contact: ["CONTACT"],
    poll: ["POLL"],
  };
  const messageTypeIn = filterTypes
    .filter((f) => f !== "url")
    .flatMap((f) => filterToTypes[f] ?? []);
  const wantsUrlFilter = filterTypes.includes("url");

  const limit = Math.min(
    parseInt(url.searchParams.get("limit") || "200", 10) || 200,
    500,
  );

  const matches = await prisma.directChatMessage.findMany({
    where: {
      workspaceId,
      groupId,
      isDeleted: false,
      ...(q.length > 0
        ? { content: { contains: q, mode: "insensitive" as const } }
        : {}),
      ...(messageTypeIn.length > 0
        ? {
            messageType: {
              in: messageTypeIn as Array<
                "TEXT" | "IMAGE" | "DOCUMENT" | "AUDIO" | "VIDEO" | "STICKER"
                  | "VOICE" | "VIDEO_NOTE" | "LOCATION" | "CONTACT" | "POLL"
                  | "DICE" | "STORY"
              >,
            },
          }
        : {}),
      // URL filter:訊息內容包含 http(s):// 視為含連結。
      // 與 messageType filter 之間是 AND(都符合才命中),沒 messageType filter 時純看 URL。
      ...(wantsUrlFilter
        ? {
            OR: [
              { content: { contains: "http://", mode: "insensitive" as const } },
              { content: { contains: "https://", mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      content: true,
      createdAt: true,
      direction: true,
      senderDisplayName: true,
      senderPlatformId: true,
      platformMessageId: true,
      replyToPlatformId: true,
      messageType: true,
      mediaUrl: true,
      mediaType: true,
      mediaFileName: true,
    },
  });

  // 回傳 client 可直接拼進 messages 陣列的 shape(對齊 /chat endpoint 形狀)
  return NextResponse.json({
    matches: matches.map((m) => ({
      id: m.id,
      content: m.content,
      timestamp: m.createdAt.toISOString(),
      sender: m.senderDisplayName ?? m.senderPlatformId ?? "Unknown",
      senderPlatformId: m.senderPlatformId,
      direction: m.direction === "INBOUND" ? "incoming" : "outgoing",
      source: "direct" as const,
      messageType: m.messageType,
      platformMessageId: m.platformMessageId,
      replyToPlatformId: m.replyToPlatformId,
      mediaUrl: m.mediaUrl,
      mediaType: m.mediaType,
      mediaFileName: m.mediaFileName,
    })),
    totalCount: matches.length,
  });
}
