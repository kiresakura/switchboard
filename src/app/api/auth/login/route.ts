import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/passwords";
import { createSession, cleanupZombieSessions } from "@/lib/auth/session";
import { logAudit } from "@/lib/audit/logger";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const log = logger("Login");

// S3 fix: rate limit login attempts per IP (5/min)
const loginLimiter = createRateLimiter({ max: 5, windowMs: 60_000 });
// H1: per-account throttle. Unlike the IP limiter, the username key cannot be
// spoofed via headers, so this is the real backstop against targeted brute
// force even if the proxy / IP extraction is misconfigured. 10 / 15 min.
const loginUserLimiter = createRateLimiter({ max: 10, windowMs: 15 * 60_000 });

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    if (!loginLimiter.consume(ip)) {
      return NextResponse.json(
        { error: "登入嘗試次數過多，請稍後再試" },
        { status: 429 }
      );
    }

    let body: { username?: string; password?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "無效的請求內容" },
        { status: 400 }
      );
    }

    const { username, password } = body;

    if (!username || !password) {
      return NextResponse.json(
        { error: "請輸入帳號與密碼" },
        { status: 400 }
      );
    }

    // Prevent overly long inputs
    if (username.length > 100 || password.length > 200) {
      return NextResponse.json(
        { error: "帳號或密碼錯誤" },
        { status: 401 }
      );
    }

    // H1: throttle per target account (header-spoof-proof backstop).
    if (!loginUserLimiter.consume(`u:${username.toLowerCase()}`)) {
      return NextResponse.json(
        { error: "登入嘗試次數過多，請稍後再試" },
        { status: 429 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { username: username.toLowerCase() },
    });

    // Always run password verification to prevent timing attacks
    const dummyHash = "$2a$12$R9h7cIPz0gi.URNNL3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW";
    const valid = await verifyPassword(password, user?.passwordHash ?? dummyHash);

    if (!user || !user.isActive || !valid) {
      // Audit failed login attempt (never block response on audit failure)
      try {
        const userAgent = request.headers.get("user-agent") ?? undefined;
        const reason = !user
          ? "user_not_found"
          : !user.isActive
          ? "user_inactive"
          : "wrong_password";
        if (user) {
          // Attach to user's first active workspace so it shows up in audit UI
          const membership = await prisma.workspaceMembership.findFirst({
            where: { userId: user.id, isActive: true },
            select: { workspaceId: true },
          });
          if (membership) {
            await logAudit({
              workspaceId: membership.workspaceId,
              userId: user.id,
              action: "LOGIN_FAILED",
              entityType: "User",
              entityId: user.id,
              details: {
                username,
                reason,
                userAgent,
              },
              ipAddress: ip,
            });
          } else {
            log.warn("LOGIN_FAILED (no workspace to attach)", {
              userId: user.id,
              username,
              reason,
              ip,
            });
          }
        } else {
          // No user — cannot attach to a workspace; log via structured logger for SIEM ingest
          log.warn("LOGIN_FAILED", {
            username,
            reason,
            ip,
            userAgent,
          });
        }
      } catch {
        // never block login response on audit failure
      }

      return NextResponse.json(
        { error: "帳號或密碼錯誤" },
        { status: 401 }
      );
    }

    // ── 多裝置 session 政策 ─────────────────────────────────
    // 之前這裡會 deleteAllUserSessions(user.id) 強制單一登入 — 但這對
    // 「同一個 CS 同時用手機 + 桌機」、「重新登入後另一個裝置應該還能用」
    // 等情境來說太嚴格：使用者會看到頁面看起來登入、但任何 API 都回 401
    // 「尚未登入」。
    //
    // 改成只清「已過絕對上限」的殭屍 session（housekeeping）。其他活著
    // 的 session 維持 valid，使用者多裝置都能用。若日後安全需求變回
    // 「單一登入」，把下面這行換成 deleteAllUserSessions(user.id) 即可。
    await cleanupZombieSessions(user.id).catch(() => null);

    await createSession(user.id, request);

    // Successful auth — clear the per-account throttle so legit repeated logins
    // (e.g. multi-device) aren't penalised. (H1)
    loginUserLimiter.reset(`u:${username.toLowerCase()}`);

    return NextResponse.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        isSystemAdmin: user.isSystemAdmin,
      },
    });
  } catch (error) {
    log.error("login handler error", { error: String(error) });
    return NextResponse.json(
      { error: "伺服器內部錯誤" },
      { status: 500 }
    );
  }
}
