import type { Metadata, Viewport } from "next";
import { Source_Serif_4, Inter, JetBrains_Mono } from "next/font/google";
import { ServiceWorkerRegistration } from "@/components/pwa/ServiceWorkerRegistration";
import { ThemeInit } from "@/components/layout/theme-init";
import "./globals.css";

// ── Warm editorial type stack ────────────────────────────────
//   Display / headlines : Source Serif 4 (free humanist serif, closest to
//                          Tiempos Headline / Iowan Old Style in the spec)
//   Body + UI           : Inter (the humanist-sans-by-default the prompt
//                          allows when Styrene A isn't available)
//   Code                : JetBrains Mono
//
// Each font binds a CSS var picked up by globals.css `--font-serif`,
// `--font-sans`, `--font-mono`. `display: swap` keeps the page visible
// during the brief network fetch — the cream surface + warm gray text
// behave gracefully in the system-font fallback too.
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-source-serif",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Switchboard - 客戶互動平台",
  description: "全通路客戶互動平台",
  // 不宣告 manifest / apple-web-app，避免瀏覽器顯示「安裝 App」提示
  icons: {
    icon: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  // Cream page background — matches --bg-primary in globals.css so the
  // browser chrome tinting (iOS Safari URL bar etc.) lines up with the app.
  themeColor: "#f4f3ee",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // 主題套用改在 client component（ThemeInit）做。Next.js 16 / React 19 對
  // 在 server component 直接渲染 <script> 標籤變嚴格，會跳「Encountered a script
  // tag while rendering React component」警告。改用 useLayoutEffect 在客戶端讀
  // localStorage 套用 className，會有極短 FOUC 但 console 乾淨。
  return (
    <html
      lang="zh-Hant"
      className={`${sourceSerif.variable} ${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased">
        <ThemeInit />
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
