import { forwardRef, ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  fullWidth?: boolean;
};

const variantStyles: Record<ButtonVariant, string> = {
  primary: "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-md shadow-[var(--primary)]/20 hover:bg-[var(--primary)]/90 hover:shadow-lg hover:shadow-[var(--primary)]/30",
  secondary: "bg-[var(--secondary)] text-[var(--secondary-foreground)] hover:bg-[var(--secondary)]/80",
  outline: "border border-[var(--border)] bg-transparent text-[var(--foreground)] hover:bg-[var(--bg-secondary)]",
  ghost: "bg-transparent text-[var(--foreground)] hover:bg-[var(--bg-secondary)]",
  danger: "bg-[var(--destructive)] text-[var(--destructive-foreground)] shadow-md shadow-red-500/20 hover:bg-[var(--destructive)]/90",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-5 py-2.5 text-base",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "primary",
      size = "md",
      loading = false,
      disabled,
      leftIcon,
      rightIcon,
      fullWidth = false,
      children,
      type = "button",
      ...props
    },
    ref
  ) => {
    return (
      <button
        type={type}
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all duration-200",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2",
          "active:scale-[0.98]",
          "disabled:pointer-events-none disabled:opacity-50",
          variantStyles[variant],
          sizeStyles[size],
          fullWidth && "w-full",
          className
        )}
        {...props}
      >
        {loading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : leftIcon ? (
          <span className="flex size-4 items-center justify-center">{leftIcon}</span>
        ) : null}
        {children}
        {!loading && rightIcon ? (
          <span className="flex size-4 items-center justify-center">{rightIcon}</span>
        ) : null}
      </button>
    );
  }
);

Button.displayName = "Button";
