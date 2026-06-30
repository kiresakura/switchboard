import { randomBytes } from "crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { assertRealSecret } from "@/lib/security/secret-guard";

// Fail fast in production if SESSION_SECRET is missing OR is a known build-time/
// dev placeholder — catches misconfigured deployments before the first request
// rather than silently running on a publicly-known key. (C3)
assertRealSecret("SESSION_SECRET", process.env.SESSION_SECRET);

const SESSION_COOKIE_NAME = "switchboard_session";
// 內部 CS 工具，使用者在班別間會帶著手機跑、跨午夜要繼續用同一條 session。
// 原本 8h idle / 24h absolute 的設計太嚴格 — 早上登入、隔天上班就過期，
// 頁面看起來是登入狀態但任何操作都會 401「尚未登入」。
// 改成 7 天 idle、30 天 absolute，比照業界做法（Slack / 常見 SaaS 後台）。
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days idle
const SESSION_ABSOLUTE_MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30 days absolute

export async function createSession(userId: string, request?: Request) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  const session = await prisma.session.create({
    data: {
      userId,
      token,
      expiresAt,
      ipAddress: request?.headers.get("x-forwarded-for") ?? undefined,
      userAgent: request?.headers.get("user-agent") ?? undefined,
    },
  });

  // Determine if we should use secure cookies (HTTPS only)
  // In production, use secure cookies UNLESS accessing via localhost/127.0.0.1 for testing
  const isProduction = process.env.NODE_ENV === "production";
  const host = request?.headers.get("host") ?? "";
  const isLocalhost = host.includes("localhost") || host.includes("127.0.0.1") || host.startsWith("192.168.") || host.startsWith("10.") || host.startsWith("172.");
  const useSecureCookie = isProduction && !isLocalhost;

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: useSecureCookie,
    sameSite: "strict",
    path: "/",
    expires: expiresAt,
  });

  return session;
}

/**
 * 取出當前 request 的 session（包含 user + 工作區成員身份）。
 *
 * 用 React `cache()` 包起來:同一個 server request 內,多個 layout / page
 * 重複呼叫 getSession() 只會打一次 DB。Next.js 16 的 nested layout 模式下
 * `(dashboard)/layout.tsx` 跟 `(workspace)/layout.tsx` 都要 session,
 * 若不 cache 就會跑兩次 session.findUnique(帶深 include),是每次切頁
 * ~50-200ms 的隱形成本。React.cache 的作用域是 request-scoped,不會
 * 跨 request 洩漏狀態。
 */
export const getSession = cache(_getSession);

async function _getSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { token },
    include: {
      user: {
        include: {
          memberships: {
            where: { isActive: true },
            include: { workspace: true },
          },
        },
      },
    },
  });

  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: session.id } });
    return null;
  }
  if (!session.user.isActive) {
    await prisma.session.delete({ where: { id: session.id } });
    return null;
  }

  // Enforce absolute session lifetime (regardless of activity)
  if (Date.now() - session.createdAt.getTime() > SESSION_ABSOLUTE_MAX_MS) {
    await prisma.session.delete({ where: { id: session.id } });
    return null;
  }

  // Extend session on activity (sliding window) — but only when close to
  // expiry, to avoid writing to the DB on every single request.
  const remainingMs = session.expiresAt.getTime() - Date.now();
  const EXTEND_WHEN_BELOW_MS = SESSION_DURATION_MS / 4; // when <25% of lifetime remains
  if (remainingMs < EXTEND_WHEN_BELOW_MS) {
    const newExpiry = new Date(Date.now() + SESSION_DURATION_MS);
    await prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: newExpiry },
    });
  }

  return session;
}

export async function deleteSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (token) {
    // token is unique in schema; tolerate already-deleted sessions
    // (e.g., logout after expiry sweep) instead of throwing.
    try {
      await prisma.session.delete({ where: { token } });
    } catch {
      // Session no longer exists — treat as already logged out
    }
    cookieStore.delete(SESSION_COOKIE_NAME);
  }
}

export async function deleteAllUserSessions(userId: string): Promise<number> {
  const result = await prisma.session.deleteMany({ where: { userId } });
  return result.count;
}

/**
 * 清掉這個 user 已過絕對上限的「殭屍 session」— 不影響活著的 session。
 * 比 deleteAllUserSessions 溫和：不踢使用者的其他活躍裝置，只做表 housekeeping。
 * Login 流程呼叫一次，避免 Session 表無限長大。
 */
export async function cleanupZombieSessions(userId: string): Promise<number> {
  const cutoff = new Date(Date.now() - SESSION_ABSOLUTE_MAX_MS);
  const result = await prisma.session.deleteMany({
    where: { userId, createdAt: { lt: cutoff } },
  });
  return result.count;
}
