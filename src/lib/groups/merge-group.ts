import { prisma } from "@/lib/db";

/**
 * Move every relation off `fromGroupId` onto `intoGroupId`, then soft-delete
 * `fromGroupId`. Used when:
 *   - a basic group migrates to a supergroup → new platformGroupId row appears,
 *     old row needs to fold in,
 *   - sync runs find same-title duplicates created by prior bridge confusion.
 *
 * Post broker-strip (H4 2026-05-20) the relations are just two tables:
 *   - AccountGroupMembership   ← move; on unique [accountId, groupId] collision
 *                                  delete the loser (drops the duplicate listening
 *                                  account, intoGroupId keeps its existing one)
 *   - DirectChatMessage        ← move all rows
 *
 * Wrapped in a single transaction so a half-merged state can't leak.
 */
export async function mergeGroupInto(
  fromGroupId: string,
  intoGroupId: string,
): Promise<void> {
  if (fromGroupId === intoGroupId) return;
  await prisma.$transaction(async (tx) => {
    const fromMemberships = await tx.accountGroupMembership.findMany({
      where: { groupId: fromGroupId },
    });
    for (const m of fromMemberships) {
      const targetExists = await tx.accountGroupMembership.findUnique({
        where: {
          accountId_groupId: { accountId: m.accountId, groupId: intoGroupId },
        },
      });
      if (targetExists) {
        await tx.accountGroupMembership.delete({ where: { id: m.id } });
      } else {
        await tx.accountGroupMembership.update({
          where: { id: m.id },
          data: { groupId: intoGroupId },
        });
      }
    }

    await tx.directChatMessage.updateMany({
      where: { groupId: fromGroupId },
      data: { groupId: intoGroupId },
    });

    await tx.group.update({
      where: { id: fromGroupId },
      data: { isActive: false },
    });
  });
}
