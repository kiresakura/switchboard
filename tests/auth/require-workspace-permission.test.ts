import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

// 以記憶體 mock 取代 Prisma 與 session，測試不需要資料庫
const db = vi.hoisted(() => ({
  workspace: { findUnique: vi.fn() },
  workspaceMembership: { findUnique: vi.fn() },
  userRole: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
}));
const getSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth/session", () => ({ getSession }));

import {
  ALL_PERMISSIONS,
  requireSystemAdmin,
  requireWorkspacePermission,
  type WorkspaceContext,
} from "@/lib/auth/middleware";

const WS = "ws_1";

function signIn(isSystemAdmin = false) {
  getSession.mockResolvedValue({
    user: { id: "u_1", username: "agent", displayName: "Agent", isSystemAdmin },
  });
}

function withRoles(...roles: Array<Record<string, unknown>>) {
  db.userRole.findMany.mockResolvedValue(roles.map((role) => ({ role })));
}

function expectStatus(result: unknown, status: number) {
  expect(result).toBeInstanceOf(NextResponse);
  expect((result as NextResponse).status).toBe(status);
}

function context(result: WorkspaceContext | NextResponse): WorkspaceContext {
  if (result instanceof NextResponse) {
    throw new Error(`expected a workspace context, got HTTP ${result.status}`);
  }
  return result;
}

beforeEach(() => {
  vi.resetAllMocks();
  db.workspace.findUnique.mockResolvedValue({ isActive: true });
  db.workspaceMembership.findUnique.mockResolvedValue({ isActive: true });
  db.userRole.findMany.mockResolvedValue([]);
  db.auditLog.create.mockResolvedValue({});
});

describe("requireWorkspacePermission", () => {
  it("returns 401 without a session", async () => {
    getSession.mockResolvedValue(null);
    expectStatus(await requireWorkspacePermission(WS), 401);
  });

  it("returns 404 for an unknown workspace", async () => {
    signIn();
    db.workspace.findUnique.mockResolvedValue(null);
    expectStatus(await requireWorkspacePermission(WS), 404);
  });

  it("blocks a deactivated workspace even for system admins", async () => {
    signIn(true);
    db.workspace.findUnique.mockResolvedValue({ isActive: false });
    expectStatus(await requireWorkspacePermission(WS), 403);
    expect(db.workspaceMembership.findUnique).not.toHaveBeenCalled();
  });

  it("rejects non-members and deactivated members before loading roles", async () => {
    signIn();
    db.workspaceMembership.findUnique.mockResolvedValue(null);
    expectStatus(await requireWorkspacePermission(WS), 403);

    db.workspaceMembership.findUnique.mockResolvedValue({ isActive: false });
    expectStatus(await requireWorkspacePermission(WS), 403);

    expect(db.userRole.findMany).not.toHaveBeenCalled();
  });

  it("unions permissions across all of the member's roles", async () => {
    signIn();
    withRoles(
      { name: "Agent", canDirectMessage: true },
      { name: "Role admin", canManageRoles: true, canDirectMessage: false },
    );

    const { permissions } = context(await requireWorkspacePermission(WS));

    expect(Object.keys(permissions).sort()).toEqual([...ALL_PERMISSIONS].sort());
    const granted = ALL_PERMISSIONS.filter((key) => permissions[key]);
    expect(granted.sort()).toEqual(["canDirectMessage", "canManageRoles"]);
  });

  it("only grants a permission for a strict boolean true", async () => {
    signIn();
    withRoles({ canManageRoles: "true", canDirectMessage: 1 });

    const { permissions } = context(await requireWorkspacePermission(WS));

    expect(permissions.canManageRoles).toBe(false);
    expect(permissions.canDirectMessage).toBe(false);
  });

  it("requires every requested permission", async () => {
    signIn();
    withRoles({ canDirectMessage: true });

    expectStatus(
      await requireWorkspacePermission(WS, "canDirectMessage", "canManageRoles"),
      403,
    );
    const ctx = context(await requireWorkspacePermission(WS, "canDirectMessage"));
    expect(ctx).toMatchObject({ userId: "u_1", workspaceId: WS });
  });

  it("loads only active roles that belong to the requested workspace", async () => {
    signIn();
    await requireWorkspacePermission(WS);

    expect(db.userRole.findMany).toHaveBeenCalledWith({
      where: { userId: "u_1", role: { workspaceId: WS, isActive: true } },
      include: { role: true },
    });
  });

  it("gives system admins every permission and audits cross-workspace access", async () => {
    signIn(true);
    db.workspaceMembership.findUnique.mockResolvedValue(null);

    const { permissions } = context(
      await requireWorkspacePermission(WS, "canManageRoles"),
    );

    expect(ALL_PERMISSIONS.every((key) => permissions[key])).toBe(true);
    expect(db.userRole.findMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "SYSTEM_ADMIN_CROSS_WORKSPACE_ACCESS",
        userId: "u_1",
        workspaceId: WS,
      }),
    });
  });

  it("does not audit system admins who are members of the workspace", async () => {
    signIn(true);
    await requireWorkspacePermission(WS);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("still authorizes a system admin when the audit write fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    signIn(true);
    db.workspaceMembership.findUnique.mockResolvedValue(null);
    db.auditLog.create.mockRejectedValue(new Error("db down"));

    const ctx = context(await requireWorkspacePermission(WS));

    expect(ctx.permissions.canEditWorkspaceSettings).toBe(true);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("requireSystemAdmin", () => {
  it("rejects regular users and admits system admins", async () => {
    signIn(false);
    expectStatus(await requireSystemAdmin(), 403);

    signIn(true);
    expect(await requireSystemAdmin()).toMatchObject({
      userId: "u_1",
      isSystemAdmin: true,
    });
  });
});
