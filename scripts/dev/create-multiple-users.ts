import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function createMultipleUsers() {
  try {
    const users = [
      {
        username: "relay_cs",
        password: "relay1234",
        displayName: "轉接客服小王",
        isSystemAdmin: false,
        roleName: "轉傳客服"
      },
      {
        username: "workspace_admin",
        password: "admin1234",
        displayName: "工作空間管理員",
        isSystemAdmin: false,
        roleName: "管理員"
      },
      {
        username: "direct_cs2",
        password: "direct1234",
        displayName: "直客服小李",
        isSystemAdmin: false,
        roleName: "直面客服"
      }
    ];

    // 取得工作空間
    const workspace = await prisma.workspace.findFirst({
      where: { name: "第一團隊" }
    });

    if (!workspace) {
      console.log("找不到工作空間：第一團隊");
      return;
    }

    console.log("目標工作空間：", workspace.name);
    console.log("工作空間 ID：", workspace.id);
    console.log("");

    // 預先取得所有角色
    const allRoles = await prisma.role.findMany({
      where: { workspaceId: workspace.id, isActive: true },
    });

    for (const userData of users) {
      console.log(`\n建立用戶：${userData.username}...`);

      // 檢查是否已存在
      const existing = await prisma.user.findUnique({
        where: { username: userData.username },
      });

      if (existing) {
        console.log(`用戶已存在：${userData.username}`);
        continue;
      }

      // 建立密碼雜湊
      const passwordHash = await bcrypt.hash(userData.password, 12);

      // 建立用戶
      const user = await prisma.user.create({
        data: {
          username: userData.username,
          passwordHash,
          displayName: userData.displayName,
          isSystemAdmin: userData.isSystemAdmin,
          isActive: true,
        },
      });

      // 建立工作空間成員關係（無 role 欄位）
      await prisma.workspaceMembership.create({
        data: {
          userId: user.id,
          workspaceId: workspace.id,
          isActive: true,
        },
      });

      // 指派角色 via UserRole
      const role = allRoles.find((r) => r.name === userData.roleName);
      let assignedRoleName = "(未指派)";
      if (role) {
        await prisma.userRole.create({
          data: {
            userId: user.id,
            roleId: role.id,
          },
        });
        assignedRoleName = role.name;
      }

      console.log(`成功建立：`);
      console.log(`   用戶名: ${userData.username}`);
      console.log(`   密碼: ${userData.password}`);
      console.log(`   顯示名稱: ${userData.displayName}`);
      console.log(`   系統管理員: ${user.isSystemAdmin ? "是" : "否"}`);
      console.log(`   角色: ${assignedRoleName}`);
      console.log(`   用戶 ID: ${user.id}`);
    }

    console.log("\n所有用戶建立完成！");
    console.log("\n完整用戶清單：");
    console.log("+-----------------+-------------+------------------+------------+----------------+");
    console.log("| 用戶名          | 密碼        | 顯示名稱         | 系統管理員 | 角色           |");
    console.log("+-----------------+-------------+------------------+------------+----------------+");
    console.log("| admin           | admin1234   | System Admin     | 是         | 管理員         |");
    console.log("| user17          | user1234    | 普通用戶17       | 否         | 直面客服       |");
    console.log("| relay_cs        | relay1234   | 轉接客服小王     | 否         | 轉傳客服       |");
    console.log("| workspace_admin | admin1234   | 工作空間管理員   | 否         | 管理員         |");
    console.log("| direct_cs2      | direct1234  | 直客服小李       | 否         | 直面客服       |");
    console.log("+-----------------+-------------+------------------+------------+----------------+");

  } catch (error) {
    console.error("建立用戶時發生錯誤:", error);
  } finally {
    await prisma.$disconnect();
  }
}

createMultipleUsers();
