import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline" | "ink";
type ButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white border border-accent hover:bg-accent-hover hover:border-accent-hover active:scale-[0.98]",
  secondary: "bg-bg-sunken text-fg border border-border hover:bg-bg-hover hover:border-border-strong active:scale-[0.98]",
  ghost: "text-fg-muted hover:text-fg hover:bg-bg-sunken border border-transparent active:scale-[0.98]",
  danger: "bg-danger text-white border border-danger hover:brightness-110 active:scale-[0.98]",
  outline: "text-fg border border-border-strong bg-transparent hover:bg-bg-sunken active:scale-[0.98]",
  ink: "bg-fg text-fg-inverse border border-fg hover:brightness-110 active:scale-[0.98]",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-[32px] px-4 text-[12.5px] gap-1.5 rounded-full",
  md: "h-[38px] px-5 text-[13.5px] gap-2 rounded-full",
  lg: "h-[46px] px-7 text-[14.5px] gap-2.5 rounded-full",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "secondary", size = "md", className = "", ...props }, ref) => (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center font-[600] tracking-[-0.01em] disabled:cursor-not-allowed disabled:opacity-45 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className = "", ...props }, ref) => (
    <button
      ref={ref}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-transparent text-fg-muted hover:bg-bg-sunken hover:text-fg active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...props}
    />
  ),
);
IconButton.displayName = "IconButton";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className = "", ...props }, ref) => (
    <input
      ref={ref}
      className={`h-[40px] w-full rounded-full border border-border bg-bg-sunken px-4 text-[14px] leading-none text-fg placeholder:text-fg-subtle outline-none focus:border-accent disabled:opacity-50 ${className}`}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className = "", ...props }, ref) => (
    <textarea
      ref={ref}
      className={`w-full resize-none rounded-[16px] border border-border bg-bg-sunken px-4 py-3 text-[14px] leading-relaxed text-fg placeholder:text-fg-subtle outline-none focus:border-accent disabled:opacity-50 ${className}`}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <label className={`mb-1.5 block text-[11px] font-[600] tracking-[0.06em] text-fg-muted ${className}`}>{children}</label>;
}

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "live";

const BADGE_TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-bg-sunken text-fg-muted border border-border",
  accent: "bg-accent-wash text-accent border border-accent/25",
  success: "bg-success-wash text-success border border-success/15",
  warning: "bg-warning-wash text-warning border border-warning/15",
  danger: "bg-danger-wash text-danger border border-danger/15",
  live: "bg-live-wash text-live border border-live/15",
};

export function Badge({ children, tone = "neutral", className = "" }: { children: ReactNode; tone?: BadgeTone; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-[600] leading-none ${BADGE_TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Avatar({
  label,
  color,
  mascot,
}: {
  label: string;
  color?: string;
  mascot?: string | null;
}) {
  if (mascot) {
    return (
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-border bg-bg-sunken text-[16px] leading-none">
        {mascot}
      </span>
    );
  }
  return (
    <span
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[12px] font-[700]"
      style={color ? { backgroundColor: color, color: "#fff" } : { backgroundColor: "var(--color-bg-sunken)", color: "var(--color-fg-muted)" }}
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Card({ children, className = "", padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <div className={`rounded-[20px] border border-border bg-bg-raised ${padded ? "p-4" : ""} ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mb-3 ${className}`}>{children}</div>;
}

export function CardTitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <h3 className={`text-[14px] font-[600] tracking-[-0.015em] text-fg ${className}`}>{children}</h3>;
}

export function CardDescription({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`mt-1 text-[12.5px] leading-relaxed text-fg-muted ${className}`}>{children}</p>;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-8 py-14 text-center">
      {icon && <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-bg-sunken text-fg-subtle">{icon}</div>}
      <div>
        <p className="text-[15px] font-[600] tracking-[-0.02em] text-fg">{title}</p>
        {description && <p className="mx-auto mt-1 max-w-[40ch] text-[13px] leading-relaxed text-fg-muted">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function Separator({ className = "" }: { className?: string }) {
  return <div className={`h-px w-full bg-border ${className}`} />;
}

export function StatusDot({ status = "active", className = "" }: { status?: "active" | "idle" | "offline"; className?: string }) {
  const colors = { active: "bg-live", idle: "bg-warning", offline: "bg-fg-faint" };
  return <span className={`inline-block h-2 w-2 rounded-full ${colors[status]} ${className}`} />;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-[12px] bg-bg-sunken ${className}`} />;
}
