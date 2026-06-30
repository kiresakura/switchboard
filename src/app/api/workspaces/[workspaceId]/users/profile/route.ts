import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";

type RouteParams = { params: Promise<{ workspaceId: string }> };

const BRIDGE_URL =
  process.env.BRIDGE_URL ||
  `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

// GET /api/workspaces/:id/users/profile?platformUserId=N
//
// 回傳：
//   {
//     platformUserId,
//     displayName,        // 從訊息紀錄取最近的 senderDisplayName
//     username?,          // 從 bridge getEntity 拿
//     bio?,               // 從 bridge GetFullUser 拿
//     accounts: [
//       { accountId, accountName, sharedGroups: [{ id, title }] }
//     ]
//   }
//
// 「共同群」= 此 TG user 在裡面說過話（DB 有 Message senderPlatformId 紀錄）
//             且我們Telegram 帳號也是該 group 的 member。
export async function GET(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const platformUserId = url.searchParams.get("platformUserId");
  if (!platformUserId) {
    return NextResponse.json(
      { error: "platformUserId 必填" },
      { status: 400 },
    );
  }

  // ── 1. displayName: 取最近一則 DCM 的 senderDisplayName ──
  // (Broker Message arm dropped in H4 — DCM is the only source now.)
  const directMsg = await prisma.directChatMessage.findFirst({
    where: {
      workspaceId,
      senderPlatformId: platformUserId,
      senderDisplayName: { not: null },
    },
    select: { senderDisplayName: true },
    orderBy: { createdAt: "desc" },
  });
  const displayName = directMsg?.senderDisplayName ?? "(未知用戶)";

  // ── 2. 此用戶說過話的 groupId 集合（純 DirectChatMessage） ──
  const dcGroups = await prisma.directChatMessage.findMany({
    where: {
      workspaceId,
      senderPlatformId: platformUserId,
    },
    distinct: ["groupId"],
    select: { groupId: true },
  });
  const groupIdSet = new Set<string>();
  for (const m of dcGroups) groupIdSet.add(m.groupId);

  // ── 3. 把這些 group 配上「我們的Telegram 帳號 membership」 ──
  const memberships =
    groupIdSet.size === 0
      ? []
      : await prisma.accountGroupMembership.findMany({
          where: {
            groupId: { in: Array.from(groupIdSet) },
            account: { workspaceId, status: "ACTIVE" },
          },
          include: {
            account: { select: { id: true, displayName: true } },
            group: { select: { id: true, title: true, isActive: true } },
          },
        });

  // 依帳號分組
  type AccountBucket = {
    accountId: string;
    accountName: string;
    sharedGroups: { id: string; title: string }[];
  };
  const accountMap = new Map<string, AccountBucket>();
  for (const m of memberships) {
    if (!m.group?.isActive) continue;
    const acc = accountMap.get(m.account.id) ?? {
      accountId: m.account.id,
      accountName: m.account.displayName ?? "(未命名)",
      sharedGroups: [],
    };
    acc.sharedGroups.push({ id: m.group.id, title: m.group.title });
    accountMap.set(m.account.id, acc);
  }
  const accounts = Array.from(accountMap.values());

  // ── 4. 透過 bridge 拿 username / bio / status / phone + commonChats
  //       (盡力,失敗也回基本資料) ──
  let username: string | undefined;
  let bio: string | undefined;
  let phone: string | undefined;
  let status:
    | {
        kind: "online" | "offline" | "recently" | "lastWeek" | "lastMonth" | "hidden";
        onlineUntil?: string;
        lastSeenAt?: string;
      }
    | undefined;
  let commonChatsByAccount: Record<string, Array<{ chatId: string; title: string }>> = {};
  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/user-info`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET || ""}`,
      },
      body: JSON.stringify({ platformUserId, workspaceId }),
      signal: AbortSignal.timeout(15000),
    });
    if (bridgeRes.ok) {
      const data = await bridgeRes.json();
      username = data?.info?.username || undefined;
      bio = data?.info?.bio || undefined;
      phone = data?.info?.phone || undefined;
      status = data?.info?.status || undefined;
      commonChatsByAccount = data?.commonChatsByAccount || {};
    }
  } catch {
    // bridge 不可達 → 沒 username / bio / commonChats 就算了
  }

  // ── 5. 把 bridge GetCommonChats 結果合併進 accounts.sharedGroups ──
  // 這條才是「TG-native 真實共同群」— 包含此 user 從未在裡面說過話的群。
  // 之前只靠 Message.senderPlatformId 找，user 沒發言過的群會缺。
  const commonChatIds = new Set<string>();
  for (const list of Object.values(commonChatsByAccount)) {
    for (const c of list) commonChatIds.add(c.chatId);
  }
  if (commonChatIds.size > 0) {
    const groupsByPlatformId = await prisma.group.findMany({
      where: {
        workspaceId,
        platformGroupId: { in: Array.from(commonChatIds) },
        isActive: true,
      },
      select: { id: true, title: true, platformGroupId: true },
    });
    const groupByPlatformId = new Map(
      groupsByPlatformId.map((g) => [g.platformGroupId, g]),
    );

    for (const [accountId, list] of Object.entries(commonChatsByAccount)) {
      // 找 / 建這個 account 的 bucket
      let acc = accounts.find((a) => a.accountId === accountId);
      if (!acc) {
        const accountRow = await prisma.communicationAccount.findUnique({
          where: { id: accountId },
          select: { displayName: true },
        });
        acc = {
          accountId,
          accountName: accountRow?.displayName ?? "(未命名)",
          sharedGroups: [],
        };
        accounts.push(acc);
      }
      const seen = new Set(acc.sharedGroups.map((g) => g.id));
      for (const c of list) {
        const g = groupByPlatformId.get(c.chatId);
        if (!g || seen.has(g.id)) continue;
        acc.sharedGroups.push({ id: g.id, title: g.title });
        seen.add(g.id);
      }
    }
  }

  return NextResponse.json({
    platformUserId,
    displayName,
    username,
    bio,
    phone,
    status,
    accounts,
  });
}
