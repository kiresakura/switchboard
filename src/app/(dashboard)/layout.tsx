import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { WatermarkOverlay } from "@/components/layout/watermark-overlay";
import { SecurityProvider } from "@/components/layout/security-provider";
import { SessionWatchdog } from "@/components/layout/session-watchdog";
import { BugReportButton } from "@/components/ui/bug-report-button";
import { ToastProvider } from "@/hooks/use-toast";
import { LightboxHost } from "@/components/chat/image-lightbox";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { user } = session;

  return (
    <SecurityProvider>
      <ToastProvider>
        <SessionWatchdog />
        {children}
        <WatermarkOverlay userName={user.displayName} />
        <BugReportButton />
        <LightboxHost />
      </ToastProvider>
    </SecurityProvider>
  );
}
