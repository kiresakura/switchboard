import { NextResponse } from "next/server";
import { requireWorkspacePermission } from "@/lib/auth/middleware";

type RouteParams = { params: Promise<{ workspaceId: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageCommunicationAccounts");
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({
    message: "Telegram API 測試成功",
    timestamp: new Date().toISOString()
  });
}

export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageCommunicationAccounts");
  if (auth instanceof NextResponse) return auth;

  try {
    await req.json();

    // 模擬註冊成功
    return NextResponse.json({
      accountId: "test_account_" + Date.now(),
      authRequired: true,
      codeSent: true,
      message: "測試註冊成功"
    });
  } catch {
    return NextResponse.json(
      { error: "測試失敗" },
      { status: 500 }
    );
  }
}
