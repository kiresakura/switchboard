import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function createUser() {
  try {
    // 新用戶資訊
    const username = "user17";
    const password = "user1234";
    const displayName = "普通用戶17";
    const targetRoleName = "直面客服";

    // 檢查用戶是否已存在
    const existing = await prisma.user.findUnique({
      where: { username },
    });

    if (existing) {
      console.log(`用戶已存在: ${username}`);
      return;
    }

    // 建立密碼雜湊
    const passwordHash = await bcrypt.hash(password, 12);

    // 建立新用戶（非管理員）
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        displayName,
        isSystemAdmin: false, // 重要：設定為非管理員
        isActive: true,
      },
    });

    console.log(`成功建立用戶：`);
    console.log(`   用戶名: ${username}`);
    console.log(`   密碼: ${password}`);
    console.log(`   顯示名稱: ${displayName}`);
    console.log(`   管理員權限: ${user.isSystemAdmin ? "是" : "否"}`);
    console.log(`   用戶 ID: ${user.id}`);

    // 取得工作空間 (第一團隊)
    const workspace = await prisma.workspace.findFirst({
      where: { name: "第一團隊" }
    });

    if (workspace) {
      // 建立工作空間成員關係（無 role 欄位）
      await prisma.workspaceMembership.create({
        data: {
          userId: user.id,
          workspaceId: workspace.id,
          isActive: true,
        },
      });

      // 查找目標角色
      const role = await prisma.role.findFirst({
        where: {
          workspaceId: workspace.id,
          name: targetRoleName,
          isActive: true,
        },
      });

      if (role) {
        await prisma.userRole.create({
          data: {
            userId: user.id,
            roleId: role.id,
          },
        });
        console.log(`已加入工作空間: ${workspace.name}`);
        console.log(`   角色: ${role.name}`);
      } else {
        console.log(`已加入工作空間: ${workspace.name}`);
        console.log(`   警告: 找不到角色 "${targetRoleName}"，未指派角色`);
      }
    }

    console.log(`\n登入資訊：`);
    console.log(`   帳號: ${username}`);
    console.log(`   密碼: ${password}`);
    console.log(`\n建議首次登入後修改密碼！`);

  } catch (error) {
    console.error("建立用戶時發生錯誤:", error);
  } finally {
    await prisma.$disconnect();
  }
}

createUser();
