import { NextResponse } from "next/server";
import { type UIMessage } from "ai";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logger } from "@/lib/logger";
import {
  isAIProviderConfigError,
  isAIProviderRequestError,
  streamProviderUIMessageResponse,
} from "@/lib/ai/provider";

const log = logger("AICopilot");

type RouteParams = { params: Promise<{ workspaceId: string }> };

/**
 * 2026-05-21 AI 副駕(round 4):Supervisor 監看 + 員工副駕 — 對「正在進行中的對話」
 * 給建議。
 *
 * POST /api/workspaces/[ws]/ai/copilot
 *   body:{
 *     groupId,        // 對話所屬群組(我們從中拉最近 N 則訊息當 context)
 *     messages: UIMessage[],  // Vercel AI SDK 5 UI message 格式(歷史對話)
 *   }
 *   ↳ SSE streaming response(Vercel AI SDK 規格)
 *
 * 設計:
 *   - LLM provider 由 src/lib/ai/provider.ts 決定。Anthropic 路徑保留 AI SDK
 *     streamText;Codex 路徑走 ChatGPT Codex Responses API 並轉成 AI SDK UI stream。
 *   - 對話 context:撈 groupId 最近 20 則 DCM 餵進 system prompt。
 *   - 不做工具呼叫(MVP)— 純文字建議。下回合接 tool calls(查客戶資料 / 發訊息 / 標籤)。
 *   - pgvector embedding 走 setup-pgvector.ts 後另開「historical similar conversations」工具。
 *   - 沒設 AI_PROVIDER / LLM_PROVIDER → 422,UI 顯示 provider 未設定。
 *
 * 權限:呼叫者必須能看到此 group(account-visibility join)— admin/supervisor/員工本人。
 * 計費:Anthropic 走原生 prompt caching,每次 system prompt 重複部分自動扣費降低。
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId);
  if (auth instanceof NextResponse) return auth;

  let body: { groupId?: string; messages?: UIMessage[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }
  const { groupId, messages } = body;
  if (!groupId || !Array.isArray(messages)) {
    return NextResponse.json(
      { error: "groupId, messages 為必填" },
      { status: 400 },
    );
  }

  // 可見性檢查 — 員工只能對自己看得到的 group 用 AI
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
        ? { accountMemberships: { some: { accountId: { in: Array.from(visible) } } } }
        : { id: "__never_match__" }),
    },
    select: { id: true, title: true, chatType: true, customerName: true, tags: true },
  });
  if (!group) {
    return NextResponse.json({ error: "找不到對話" }, { status: 404 });
  }

  // 拉最近 20 則 DCM 當 context
  const recent = await prisma.directChatMessage.findMany({
    where: { workspaceId, groupId, isDeleted: false },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      direction: true,
      content: true,
      senderDisplayName: true,
      messageType: true,
      createdAt: true,
    },
  });
  // reverse 成「舊→新」自然閱讀順序
  recent.reverse();

  const transcript = recent
    .map((m) => {
      const who =
        m.direction === "INBOUND"
          ? m.senderDisplayName ?? "Customer"
          : "Operator";
      const when = m.createdAt.toISOString();
      const body =
        m.messageType === "TEXT"
          ? m.content
          : `[${m.messageType}${m.content ? ": " + m.content : ""}]`;
      return `[${when}] ${who}: ${body}`;
    })
    .join("\n");

  const systemPrompt = `你是 Switchboard 客服 CRM 的 AI 副駕。你在幫 Operator(我方員工)回覆 Customer。

對話脈絡:
- 群組標題:${group.title}
- 群組類型:${group.chatType}
${group.customerName ? `- 客戶名稱:${group.customerName}` : ""}
${group.tags && group.tags.length > 0 ? `- 標籤:${group.tags.join(", ")}` : ""}

最近對話歷史(舊→新):
${transcript || "(尚無對話歷史)"}

你的任務:
- 回答 Operator 提出的問題 / 給出回覆建議
- 用繁體中文,語氣專業但不冷漠
- 直接給可貼上的回覆建議,不要包過多前言
- 若需澄清,先簡短反問 Operator 一句
- 永遠不要冒充自己是 Customer 或假裝你已經發送訊息`;

  try {
    return await streamProviderUIMessageResponse({
      system: systemPrompt,
      messages,
    });
  } catch (err) {
    if (isAIProviderConfigError(err)) {
      return NextResponse.json(
        { error: `${err.message} — 副駕未啟用` },
        { status: 422 },
      );
    }
    if (isAIProviderRequestError(err)) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status },
      );
    }

    log.warn("AI copilot failed", {
      workspaceId,
      groupId,
      err: String(err).slice(0, 200),
    });
    return NextResponse.json(
      { error: "AI 服務暫時無法使用" },
      { status: 502 },
    );
  }
}
