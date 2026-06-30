import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { AuditLog, Prisma } from "@prisma/client";

const log = logger("Audit");

const CRITICAL_AUDIT_ACTIONS = new Set([
  "SYSTEM_ADMIN_CROSS_WORKSPACE_ACCESS",
  "USER_DEACTIVATED",
  "ROLE_DELETED",
  "WORKSPACE_DEACTIVATED",
  "ACCOUNT_DELETED",
]);

type AuditLogEntry = {
  workspaceId: string;
  userId?: string;
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
};

export async function logAudit(entry: AuditLogEntry): Promise<AuditLog | null> {
  try {
    return await prisma.auditLog.create({
      data: {
        workspaceId: entry.workspaceId,
        userId: entry.userId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        details: (entry.details as Prisma.InputJsonValue) ?? undefined,
        ipAddress: entry.ipAddress,
      },
    });
  } catch (error) {
    const isCritical = CRITICAL_AUDIT_ACTIONS.has(entry.action);
    log.error(
      `Failed to write ${isCritical ? "CRITICAL" : "standard"} audit log`,
      { error: String(error), action: entry.action }
    );
    if (isCritical) {
      throw new Error(`Critical audit log failure for action: ${entry.action}`);
    }
    return null;
  }
}
