import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  // Create default system admin
  const adminUsername = process.env.SEED_ADMIN_USERNAME || "admin";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || "admin1234";
  if (!process.env.SEED_ADMIN_PASSWORD) {
    // C2: never seed a production database with the public default password.
    if (process.env.NODE_ENV === "production") {
      throw new Error("SEED_ADMIN_PASSWORD must be set when seeding a production database");
    }
    console.warn("⚠️  SEED_ADMIN_PASSWORD not set — using INSECURE dev default. Never use this in production.");
  }

  const existing = await prisma.user.findUnique({
    where: { username: adminUsername },
  });

  if (existing) {
    console.log(`System admin already exists: ${adminUsername}`);
    // M8 fix: also check workspace to ensure seed is fully idempotent
    const existingWs = await prisma.workspace.findUnique({ where: { slug: "team-1" } });
    if (existingWs) {
      console.log(`Workspace already exists: ${existingWs.name}`);
    }
    return;
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);

  const admin = await prisma.user.create({
    data: {
      username: adminUsername,
      passwordHash,
      displayName: "System Admin",
      isSystemAdmin: true,
    },
  });

  // Create a default workspace
  const workspace = await prisma.workspace.create({
    data: {
      name: "第一團隊",
      slug: "team-1",
    },
  });

  // Create 3 default roles for the workspace
  // 注意：這個 「工作空間管理員」身份組僅有「該工作空間」的管理權限。
  // 跟 User.isSystemAdmin 那種跨工作空間的「系統管理員」是兩件事。
  // 沿用過往的「管理員」會跟 System Admin 混淆 — 改名清楚表達 scope。
  const adminRole = await prisma.role.create({
    data: {
      workspaceId: workspace.id,
      name: "工作空間管理員",
      isSystemDefault: true,
      canEditWorkspaceSettings: true,
      canManageCommunicationAccounts: true,
      canManageGroupRegistry: true,
      canManageRouting: true,
      canManageModerationRules: true,
      canManageRoles: true,
      canAssignMemberRoles: true,
      canModerateMessages: true,
      canSendManualMessages: true,
      canDirectMessage: true,
      canManagePostPermissions: true,
      canViewAllAuditLogs: true,
      canViewOwnAuditLogs: true,
      canSuperviseTeam: true,
      canDelegateAccounts: true,
    },
  });

  const forwardCSRole = await prisma.role.create({
    data: {
      workspaceId: workspace.id,
      name: "轉傳客服",
      isSystemDefault: true,
      canModerateMessages: true,
      canSendManualMessages: true,
      canViewOwnAuditLogs: true,
    },
  });

  await prisma.role.create({
    data: {
      workspaceId: workspace.id,
      name: "直面客服",
      isSystemDefault: true,
      canDirectMessage: true,
      canViewOwnAuditLogs: true,
    },
  });

  // Create workspace membership for admin
  await prisma.workspaceMembership.create({
    data: {
      userId: admin.id,
      workspaceId: workspace.id,
    },
  });

  // Link admin to the 管理員 role
  await prisma.userRole.create({
    data: {
      userId: admin.id,
      roleId: adminRole.id,
    },
  });

  // Create test CS user (轉傳客服)
  if (!process.env.SEED_CS_PASSWORD && process.env.NODE_ENV === "production") {
    // C2: never seed a production database with the public default password.
    throw new Error("SEED_CS_PASSWORD must be set when seeding a production database");
  }
  const csPassword = process.env.SEED_CS_PASSWORD || "cs1234";
  const csPasswordHash = await bcrypt.hash(csPassword, 12);

  const csUser = await prisma.user.create({
    data: {
      username: "cs_user",
      passwordHash: csPasswordHash,
      displayName: "測試客服",
      isSystemAdmin: false,
    },
  });

  await prisma.workspaceMembership.create({
    data: {
      userId: csUser.id,
      workspaceId: workspace.id,
    },
  });

  await prisma.userRole.create({
    data: {
      userId: csUser.id,
      roleId: forwardCSRole.id,
    },
  });

  // ── 四層權限示範資料 ────────────────────────────────────────────────────────
  // 1. Team「客服組」— admin 擔任主管，csUser 為一般成員
  const team = await prisma.team.create({
    data: {
      workspaceId: workspace.id,
      name: "客服組",
      supervisorUserId: admin.id,
      sortOrder: 0,
    },
  });

  await prisma.teamMembership.create({
    data: { teamId: team.id, userId: csUser.id },
  });

  // 2. 示範用 TG 帳號（INACTIVE，不綁真實 session，純 UI 展示用）
  const demoAccount = await prisma.communicationAccount.create({
    data: {
      workspaceId: workspace.id,
      displayName: "示範帳號",
      phoneNumber: "+886900000000",
      status: "PENDING_AUTH",   // no real TG session — demo/display only
      teamId: team.id,
    },
  });

  // 3. AccountAssignment — csUser 被指派此示範帳號（員工默認只看自己帳號）
  await prisma.accountAssignment.create({
    data: {
      accountId: demoAccount.id,
      userId: csUser.id,
      isPrimary: true,
    },
  });

  // 4. 合成 TgFolder（2 筆）— 讓 TG 資料夾 UI 段在無真實 TG 連線時也能渲染
  //    groupIds 為空陣列：fresh seed 沒有群組，UI 點選後清單為空是預期行為。
  await prisma.tgFolder.createMany({
    data: [
      {
        workspaceId: workspace.id,
        accountId: demoAccount.id,
        tgFilterId: 1,
        title: "工作",
        emoticon: "💼",
        groupIds: [],
      },
      {
        workspaceId: workspace.id,
        accountId: demoAccount.id,
        tgFilterId: 2,
        title: "VIP 客戶",
        emoticon: "⭐",
        groupIds: [],
      },
    ],
  });

  console.log(`Created system admin:`);
  console.log(`  Username: ${adminUsername}`);
  console.log(`  ID: ${admin.id}`);
  console.log(`  Workspace: ${workspace.name} (${workspace.id})`);
  console.log(`  Role: 管理員`);
  console.log(`\nCreated test CS user:`);
  console.log(`  Username: cs_user`);
  console.log(`  Password: ${csPassword}`);
  console.log(`  Role: 轉傳客服`);
  console.log(`\nDemo team & account:`);
  console.log(`  Team: ${team.name} (supervisor: ${adminUsername})`);
  console.log(`  Demo account: ${demoAccount.displayName} (INACTIVE, no real session)`);
  console.log(`  TgFolders seeded: 工作, VIP 客戶`);
  console.log(`\nDefault roles created: 管理員, 轉傳客服, 直面客服`);
  console.log(`\n⚠️  Default passwords are set. Change them after first login!`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
