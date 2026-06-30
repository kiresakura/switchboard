import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logger } from "@/lib/logger";
import {
  generateProviderText,
  isAIProviderConfigError,
  isAIProviderRequestError,
} from "@/lib/ai/provider";

const log = logger("AIAnalyze");

type RouteParams = {
  params: Promise<{ workspaceId: string; groupId: string }>;
};

/**
 * 2026-05-21 Batch 3 — AI 預析。
 *
 * POST /api/workspaces/[ws]/groups/[groupId]/ai/analyze
 *   ↳ { analysis: string, messageCount: number, generatedAt: string }
 *
 * 跟「AI 副駕」(/ai/copilot)的差別:
 *   - 副駕 = 互動式問答(streaming chat),員工主動問。
 *   - 預析 = 一次性結構化 brief,員工「開對話前」先掃一眼 —— 摘要 / 客戶意圖 /
 *     情緒急迫度 / 建議下一步。click-to-generate(不自動跑,省 API 預算)。
 *
 * 權限與可見性同副駕:requireWorkspacePermission + account-visibility join。
 */
export async function POST(_req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  const auth = await requireWorkspacePermission(workspaceId);
  if (auth instanceof NextResponse) return auth;

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
        ? {
            accountMemberships: {
              some: { accountId: { in: Array.from(visible) } },
            },
          }
        : { id: "__never_match__" }),
    },
    select: { id: true, title: true, chatType: true, customerName: true, tags: true },
  });
  if (!group) {
    return NextResponse.json({ error: "找不到對話" }, { status: 404 });
  }

  // 拉最近 30 則 DCM 當分析素材
  const recent = await prisma.directChatMessage.findMany({
    where: { workspaceId, groupId, isDeleted: false },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      direction: true,
      content: true,
      senderDisplayName: true,
      messageType: true,
    },
  });
  if (recent.length === 0) {
    return NextResponse.json(
      { error: "這個對話還沒有訊息可供分析" },
      { status: 400 },
    );
  }
  // reverse 成「舊→新」自然閱讀順序
  recent.reverse();

  const transcript = recent
    .map((m) => {
      const who =
        m.direction === "INBOUND" ? m.senderDisplayName ?? "Customer" : "Operator";
      const body =
        m.messageType === "TEXT"
          ? m.content
          : `[${m.messageType}${m.content ? ": " + m.content : ""}]`;
      return `${who}: ${body}`;
    })
    .join("\n");

  const systemPrompt = `你是 Switchboard 客服 CRM 的 AI 分析助理。針對一段「我方員工(Operator)與客戶(Customer)」的對話,在員工開始處理前,給一份精簡的「預先分析」brief,讓員工 30 秒內掌握狀況。

請務必用繁體中文,並嚴格照以下格式輸出(每段用【】標題,不要加 Markdown 符號、不要加額外前言或結語):

【對話摘要】
2-3 句話講清楚這段對話在談什麼。

【客戶意圖 / 需求】
條列客戶想要什麼(每點一行,用「・」開頭)。

【情緒與急迫度】
一句話描述客戶目前情緒,並標明急迫度(高 / 中 / 低)。

【建議下一步】
員工接下來該做什麼或回覆方向,條列 1-3 點(每點一行,用「・」開頭)。

若對話內容太少不足以分析,就如實說明,不要編造。`;

  const userPrompt = `對話資訊:
- 群組標題:${group.title}
- 類型:${group.chatType}${group.customerName ? `\n- 客戶名稱:${group.customerName}` : ""}${
    group.tags && group.tags.length > 0
      ? `\n- 既有標籤:${group.tags.join(", ")}`
      : ""
  }

最近對話(舊→新,共 ${recent.length} 則):
${transcript}`;

  try {
    const text = await generateProviderText({
      system: systemPrompt,
      prompt: userPrompt,
    });
    return NextResponse.json({
      analysis: text,
      messageCount: recent.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (isAIProviderConfigError(err)) {
      return NextResponse.json(
        { error: `${err.message} — AI 預析未啟用` },
        { status: 422 },
      );
    }
    if (isAIProviderRequestError(err)) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status },
      );
    }

    log.warn("AI analysis failed", {
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
