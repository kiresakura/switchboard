import { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type StatusBadgeProps = {
  status: "pending" | "progress" | "completed" | "cancelled" | "online" | "offline";
  children: React.ReactNode;
  icon?: LucideIcon;
  size?: "sm" | "md" | "lg";
  className?: string;
};

const statusStyles = {
  pending: "bg-[var(--status-pending-bg)] text-[var(--status-pending)] border-[var(--status-pending)]/20",
  progress: "bg-[var(--status-progress-bg)] text-[var(--status-progress)] border-[var(--status-progress)]/20",
  completed: "bg-[var(--status-completed-bg)] text-[var(--status-completed)] border-[var(--status-completed)]/20",
  cancelled: "bg-[var(--status-cancelled-bg)] text-[var(--status-cancelled)] border-[var(--status-cancelled)]/20",
  online: "bg-green-500/10 text-green-600 border-green-500/20",
  offline: "bg-gray-500/10 text-gray-500 border-gray-500/20",
};

const sizeStyles = {
  sm: "px-2 py-0.5 text-[10px]",
  md: "px-2.5 py-1 text-xs",
  lg: "px-3 py-1.5 text-sm",
};

export function StatusBadge({
  status,
  children,
  icon: Icon,
  size = "md",
  className,
}: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-medium",
        statusStyles[status],
        sizeStyles[size],
        className
      )}
    >
      {Icon && <Icon className="size-3" />}
      {children}
    </span>
  );
}

type PriorityBadgeProps = {
  priority: "HIGH" | "MEDIUM" | "LOW";
  size?: "sm" | "md" | "lg";
  className?: string;
};

const priorityLabels = {
  HIGH: "高",
  MEDIUM: "中",
  LOW: "低",
};

const priorityStyles = {
  HIGH: "bg-[var(--priority-high-bg)] text-[var(--priority-high)] border-[var(--priority-high)]/20",
  MEDIUM: "bg-[var(--priority-medium-bg)] text-[var(--priority-medium)] border-[var(--priority-medium)]/20",
  LOW: "bg-[var(--priority-low-bg)] text-[var(--priority-low)] border-[var(--priority-low)]/20",
};

export function PriorityBadge({
  priority,
  size = "md",
  className,
}: PriorityBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-medium",
        priorityStyles[priority],
        sizeStyles[size],
        className
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          priority === "HIGH" && "bg-[var(--priority-high)]",
          priority === "MEDIUM" && "bg-[var(--priority-medium)]",
          priority === "LOW" && "bg-[var(--priority-low)]"
        )}
      />
      {priorityLabels[priority]}
    </span>
  );
}
