import { cn } from "@/lib/utils";

type SkeletonProps = {
  className?: string;
  variant?: "text" | "circular" | "rectangular";
  width?: string;
  height?: string;
};

export function Skeleton({
  className,
  variant = "rectangular",
  width,
  height,
}: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-[var(--muted)]",
        variant === "circular" && "rounded-full",
        variant === "text" && "h-4 w-full",
        className
      )}
      style={{ width, height }}
    />
  );
}

type ReviewItemSkeletonProps = {
  count?: number;
};

export function ReviewItemSkeleton({ count = 3 }: ReviewItemSkeletonProps) {
  return (
    <div className="space-y-2 p-2">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3"
        >
          {/* Color indicator */}
          <Skeleton variant="rectangular" width="4px" height="48px" className="shrink-0" />

          <div className="flex-1 space-y-2">
            {/* Route row */}
            <div className="flex items-center gap-2">
              <Skeleton variant="text" width="80px" />
              <Skeleton variant="text" width="16px" />
              <Skeleton variant="text" width="80px" />
              <Skeleton variant="text" width="40px" className="ml-auto" />
            </div>
            {/* Content row */}
            <div className="flex items-center gap-2">
              <Skeleton variant="text" width="60px" />
              <Skeleton variant="text" className="flex-1" />
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex gap-1">
            <Skeleton variant="circular" width="28px" height="28px" />
            <Skeleton variant="circular" width="28px" height="28px" />
          </div>
        </div>
      ))}
    </div>
  );
}
