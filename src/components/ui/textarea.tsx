import { forwardRef } from "react";
import { cn } from "@/lib/utils";

type TextareaProps = React.ComponentProps<"textarea"> & {
  label?: string;
  error?: string;
  helperText?: string;
  maxChars?: number;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, error, helperText, maxChars, ...props }, ref) => {
    const currentLength = props.value?.toString().length || 0;
    const hasMaxChars = maxChars !== undefined;

    return (
      <div className="space-y-1.5">
        {label && (
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-[var(--foreground)]">
              {label}
            </label>
            {hasMaxChars && (
              <span
                className={cn(
                  "text-[11px]",
                  currentLength > maxChars
                    ? "text-red-600"
                    : "text-[var(--muted-foreground)]"
                )}
              >
                {currentLength} / {maxChars}
              </span>
            )}
          </div>
        )}
        <textarea
          ref={ref}
          className={cn(
            "w-full rounded-lg border border-[var(--input)] bg-[var(--background)] px-3 py-2.5 text-sm text-[var(--foreground)] outline-none transition-all resize-y",
            "placeholder:text-[var(--muted-foreground)]",
            "focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/20",
            "disabled:cursor-not-allowed disabled:opacity-50",
            error && "border-red-500 focus:border-red-500 focus:ring-red-500/20",
            className
          )}
          {...props}
        />
        {(error || helperText) && (
          <p className={cn("text-xs", error ? "text-red-600" : "text-[var(--muted-foreground)]")}>
            {error || helperText}
          </p>
        )}
      </div>
    );
  }
);

Textarea.displayName = "Textarea";
