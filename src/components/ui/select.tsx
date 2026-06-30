import { forwardRef } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

type SelectProps = React.ComponentProps<"select"> & {
  label?: string;
  error?: string;
  helperText?: string;
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, error, helperText, children, ...props }, ref) => {
    return (
      <div className="space-y-1.5">
        {label && (
          <label className="block text-sm font-medium text-[var(--foreground)]">
            {label}
          </label>
        )}
        <div className="relative">
          <select
            ref={ref}
            className={cn(
              "w-full appearance-none rounded-lg border border-[var(--input)] bg-[var(--background)] px-3 py-2.5 pr-10 text-sm text-[var(--foreground)] outline-none transition-all",
              "focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/20",
              "disabled:cursor-not-allowed disabled:opacity-50",
              error && "border-red-500 focus:border-red-500 focus:ring-red-500/20",
              className
            )}
            {...props}
          >
            {children}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
        </div>
        {(error || helperText) && (
          <p className={cn("text-xs", error ? "text-red-600" : "text-[var(--muted-foreground)]")}>
            {error || helperText}
          </p>
        )}
      </div>
    );
  }
);

Select.displayName = "Select";
