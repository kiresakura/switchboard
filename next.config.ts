import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// Dev mode needs 'unsafe-eval' for Next.js HMR/Turbopack
const scriptSrc = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval';"
  : "script-src 'self' 'unsafe-inline';";

const csp = [
  "default-src 'self';",
  scriptSrc,
  "style-src 'self' 'unsafe-inline';",
  "img-src 'self' data: blob:;",
  "connect-src 'self' ws: wss:;",
  "font-src 'self' data:;",
  "worker-src 'self';",
  "manifest-src 'self';",
  "frame-ancestors 'none';",
].join(" ");

const tunnelDevOrigins = [
  "robert-increased-downtown-queens.trycloudflare.com",
  ...(process.env.NEXT_ALLOWED_DEV_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
];

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {},
  allowedDevOrigins: tunnelDevOrigins,
  serverExternalPackages: ["bcryptjs", "pg"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
