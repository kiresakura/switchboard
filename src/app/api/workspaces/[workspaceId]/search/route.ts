import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { MessageType } from "@prisma/client";

type RouteParams = { params: Promise<{ workspaceId: string }> };

/**
 * GET /api/workspaces/:id/search
 *
 * 全域搜尋，支援兩種模式：
 *
 * 1. **訊息文字搜尋**（預設，type 未傳或 type=message）
 *    - q 必填，≥ 2 字元。
 *    - 以 content ILIKE %q% 搜尋 DCM，回傳前 50 筆。
 *
 * 2. **媒體搜尋**（type=photo|video|file）
 *    - q 可選，傳入時以 content（標題）或 mediaFileName ILIKE %q% 過濾。
 *    - 未傳 q 回傳最新 100 筆（TG 照片/影片/檔案瀏覽流）。
 *    - 額外回傳 mediaUrl / mediaFileName / mediaType 欄位。
 */
export async function GET(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const type = (url.searchParams.get("type") ?? "message") as
    | "message"
    | "photo"
    | "video"
    | "file";
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") || "50", 10) || 50,
    200,
  );

  // ── 媒體搜尋 ─────────────────────────────────────────────────────────────
  if (type === "photo" || type === "video" || type === "file") {
    const messageTypes: MessageType[] =
      type === "photo"
        ? [MessageType.IMAGE]
        : type === "video"
          ? [MessageType.VIDEO]
          : [
              MessageType.DOCUMENT,
              MessageType.AUDIO,
              MessageType.VOICE,
              MessageType.VIDEO_NOTE,
            ];

    const matches = await prisma.directChatMessage.findMany({
      where: {
        workspaceId,
        isDeleted: false,
        messageType: { in: messageTypes },
        group: { isActive: true, isHidden: false },
        // q 有值時過濾標題(caption) 或 檔名
        ...(q.length >= 1
          ? {
              OR: [
                { content: { contains: q, mode: "insensitive" } },
                { mediaFileName: { contains: q, mode: "insensitive" } },
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
        messageType: true,
        mediaUrl: true,
        mediaFileName: true,
        mediaType: true,
        senderDisplayName: true,
        groupId: true,
        group: {
          select: {
            id: true,
            title: true,
            customerName: true,
            chatType: true,
            platformGroupId: true,
          },
        },
      },
    });

    return NextResponse.json({
      matches: matches.map((m) => ({
        dcmId: m.id,
        groupId: m.groupId,
        groupTitle: m.group.title,
        groupCustomerName: m.group.customerName,
        groupChatType: m.group.chatType,
        groupPlatformId: m.group.platformGroupId,
        content: m.content,
        timestamp: m.createdAt.toISOString(),
        direction: m.direction === "INBOUND" ? "incoming" : "outgoing",
        senderDisplayName: m.senderDisplayName ?? null,
        messageType: m.messageType,
        mediaUrl: m.mediaUrl,
        mediaFileName: m.mediaFileName,
        mediaType: m.mediaType,
      })),
      totalCount: matches.length,
    });
  }

  // ── 訊息文字搜尋（預設）────────────────────────────────────────────────
  if (q.length === 0) {
    return NextResponse.json({ matches: [], totalCount: 0 });
  }
  if (q.length < 2) {
    return NextResponse.json(
      { error: "搜尋字串至少 2 個字元" },
      { status: 400 },
    );
  }

  const matches = await prisma.directChatMessage.findMany({
    where: {
      workspaceId,
      isDeleted: false,
      content: { contains: q, mode: "insensitive" },
      group: {
        isActive: true,
        isHidden: false,
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      content: true,
      createdAt: true,
      direction: true,
      messageType: true,
      senderDisplayName: true,
      senderPlatformId: true,
      groupId: true,
      group: {
        select: {
          id: true,
          title: true,
          customerName: true,
          chatType: true,
          platformGroupId: true,
        },
      },
    },
  });

  return NextResponse.json({
    matches: matches.map((m) => ({
      dcmId: m.id,
      groupId: m.groupId,
      groupTitle: m.group.title,
      groupCustomerName: m.group.customerName,
      groupChatType: m.group.chatType,
      groupPlatformId: m.group.platformGroupId,
      content: m.content,
      timestamp: m.createdAt.toISOString(),
      direction: m.direction === "INBOUND" ? "incoming" : "outgoing",
      senderDisplayName: m.senderDisplayName ?? m.senderPlatformId ?? null,
      messageType: m.messageType,
    })),
    totalCount: matches.length,
  });
}
