import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { type Prisma, MessageType } from "@prisma/client";

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/:id/direct-chat/history
export async function GET(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canDirectMessage");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const groupId = url.searchParams.get("group");
  const accountId = url.searchParams.get("account");
  const search = url.searchParams.get("search");
  const date = url.searchParams.get("date");
  const type = url.searchParams.get("type");
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1") || 1);
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "30") || 30, 100));
  const isExport = url.searchParams.get("export") === "true";

  if (!groupId) {
    return NextResponse.json({ error: "group 為必填參數" }, { status: 400 });
  }

  const validType =
    type && (Object.values(MessageType) as string[]).includes(type)
      ? (type as MessageType)
      : null;

  const where: Prisma.DirectChatMessageWhereInput = {
    workspaceId,
    groupId,
    ...(accountId && { accountId }),
    ...(search && {
      content: { contains: search, mode: "insensitive" as const },
    }),
    ...(validType && { messageType: validType }),
    ...(date && {
      createdAt: {
        gte: new Date(`${date}T00:00:00.000Z`),
        lt: new Date(`${date}T23:59:59.999Z`),
      },
    }),
  };

  if (isExport) {
    const messages = await prisma.directChatMessage.findMany({
      where,
      include: {
        sender: { select: { displayName: true } },
        account: { select: { displayName: true } },
      },
      orderBy: { createdAt: "asc" },
      take: 5000,
    });

    const csvHeader = "時間,方向,發送者,帳號,類型,內容\n";
    const csvRows = messages
      .map((m) => {
        const time = m.createdAt.toISOString();
        const dirLabel = m.direction === "INBOUND" ? "收到" : "發送";
        const sender =
          m.direction === "INBOUND"
            ? (m.senderDisplayName ?? m.senderPlatformId ?? "未知")
            : (m.sender?.displayName ?? "系統");
        const account = m.account.displayName;
        const msgType = m.messageType;
        const content = m.content.replace(/"/g, '""');
        return `"${time}","${dirLabel}","${sender}","${account}","${msgType}","${content}"`;
      })
      .join("\n");

    return new Response(csvHeader + csvRows, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="chat_history_${date || "all"}.csv"`,
      },
    });
  }

  const [messages, total] = await Promise.all([
    prisma.directChatMessage.findMany({
      where,
      include: {
        sender: { select: { displayName: true } },
        account: { select: { displayName: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.directChatMessage.count({ where }),
  ]);

  // Map to format expected by ConversationHistory component. INBOUND /
  // OUTBOUND legend: outbound (CS staff sent) uses OUTBOUND slot;
  // inbound (archived from TG) uses INBOUND slot. The component
  // only cares about left/right bucketing and treats these two enums as
  // opposite sides.
  const formatted = messages.reverse().map((m) => {
    const isOutbound = m.direction === "OUTBOUND";
    return {
      id: m.id,
      originalContent: m.content,
      messageType: m.messageType,
      direction: isOutbound ? "OUTBOUND" : "INBOUND",
      senderDisplayName: isOutbound
        ? (m.sender?.displayName ?? "System")
        : (m.senderDisplayName ?? m.senderPlatformId ?? "Unknown"),
      senderPlatformId: isOutbound ? null : m.senderPlatformId,
      receivedAt: m.createdAt.toISOString(),
      mediaUrl: m.mediaUrl,
      mediaType: m.mediaType,
      mediaFileName: m.mediaFileName,
      status: isOutbound ? (m.sentViaTelegram ? "SENT" : "PENDING") : "RECEIVED",
      accountName: m.account.displayName,
    };
  });

  return NextResponse.json({
    messages: formatted,
    hasMore: page * limit < total,
    total,
  });
}
