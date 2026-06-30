import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/health", "/offline"];
const INTERNAL_PATHS = ["/api/internal/"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow static assets and Next.js internals
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    /\.(js|css|png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|eot|map|json)$/i.test(pathname)
  ) {
    return NextResponse.next();
  }

  // Internal API paths bypass session check (use their own auth via INTERNAL_SECRET)
  if (INTERNAL_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Note: Workspace active status is validated in API routes (requireWorkspacePermission),
  // not in edge middleware, because edge runtime cannot access Prisma directly.

  // Check for session cookie
  const sessionToken = request.cookies.get("switchboard_session")?.value;
  if (!sessionToken) {
    // API routes: return 401 JSON instead of redirect
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "尚未登入" }, { status: 401 });
    }
    // Page routes: redirect to login
    const loginUrl = new URL("/login", request.url);
    // Guard against open redirect: only allow same-origin relative paths
    const safeRedirect =
      pathname.startsWith("/") && !pathname.startsWith("//")
        ? pathname
        : "/";
    loginUrl.searchParams.set("redirect", safeRedirect);
    return NextResponse.redirect(loginUrl);
  }

  // Add security headers
  const response = NextResponse.next();
  if (process.env.NODE_ENV === "production") {
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
