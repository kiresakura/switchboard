import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

type NotificationVariant = "success" | "error" | "warning" | "info";

type NotificationProps = {
  variant?: NotificationVariant;
  title?: string;
  message: string;
  onClose?: () => void;
  className?: string;
};

const variantStyles = {
  success: {
    container: "border-green-500/30 bg-green-500/10",
    icon: "text-green-600",
    title: "text-green-900",
    message: "text-green-800",
  },
  error: {
    container: "border-red-500/30 bg-red-500/10",
    icon: "text-red-600",
    title: "text-red-900",
    message: "text-red-800",
  },
  warning: {
    container: "border-orange-500/30 bg-orange-500/10",
    icon: "text-orange-600",
    title: "text-orange-900",
    message: "text-orange-800",
  },
  info: {
    container: "border-blue-500/30 bg-blue-500/10",
    icon: "text-blue-600",
    title: "text-blue-900",
    message: "text-blue-800",
  },
};

const variantIcons = {
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};

export function Notification({
  variant = "info",
  title,
  message,
  onClose,
  className,
}: NotificationProps) {
  const styles = variantStyles[variant];
  const Icon = variantIcons[variant];

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border p-4 shadow-lg animate-slide-in-top",
        styles.container,
        className
      )}
    >
      <Icon className={cn("size-5 shrink-0 mt-0.5", styles.icon)} />
      <div className="flex-1 space-y-1">
        {title && (
          <p className={cn("text-sm font-semibold", styles.title)}>{title}</p>
        )}
        <p className={cn("text-sm", styles.message)}>{message}</p>
      </div>
      {onClose && (
        <button
          onClick={onClose}
          className="shrink-0 rounded-lg p-1 opacity-50 transition-opacity hover:opacity-100"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}
