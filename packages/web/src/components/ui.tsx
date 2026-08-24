import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type ButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-gradient-accent text-accent-fg shadow-lg shadow-accent-glow hover:shadow-md hover:shadow-accent-glow transition-all",
  secondary: "bg-bg-raised text-fg border border-border hover:bg-bg-hover hover:border-border-strong transition-all",
  ghost: "text-fg-muted hover:text-fg hover:bg-bg-hover transition-all",
  danger: "bg-danger-wash text-danger hover:bg-danger hover:text-danger-fg transition-all",
  outline: "text-accent border border-accent hover:bg-accent-wash hover:text-accent-fg transition-all",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-7 px-3 text-xs gap-1.5",
  md: "h-9 px-4 text-sm gap-2",
  lg: "h-11 px-6 text-base gap-2.5",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "secondary", size = "md", className = "", ...props }, ref) => (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center rounded-lg font-medium disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className = "", ...props }, ref) => (
    <button
      ref={ref}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-fg-muted hover:bg-bg-hover hover:text-accent transition-all disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...props}
    />
  ),
);
IconButton.displayName = "IconButton";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className = "", ...props }, ref) => (
    <input
      ref={ref}
      className={`h-9 w-full rounded-md border border-border bg-bg-raised px-3.5 text-base text-fg placeholder:text-fg-subtle outline-none transition-all focus:border-accent focus:shadow-glow-sm disabled:opacity-50 ${className}`}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className = "", ...props }, ref) => (
    <textarea
      ref={ref}
      className={`w-full resize-none rounded-md border border-border bg-bg-raised px-3.5 py-2.5 text-base text-fg placeholder:text-fg-subtle outline-none transition-all focus:border-accent focus:shadow-glow-sm disabled:opacity-50 ${className}`}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <label className={`mb-2 block text-sm font-medium text-fg-muted ${className}`}>{children}</label>;
}

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const BADGE_TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-bg-sunken text-fg-muted",
  accent: "bg-accent-wash text-accent",
  success: "bg-success-wash text-success",
  warning: "bg-warning-wash text-warning",
  danger: "bg-danger-wash text-danger",
};

export function Badge({ children, tone = "neutral", className = "" }: { children: ReactNode; tone?: BadgeTone; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium leading-none ${BADGE_TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Avatar({
  label,
  tone = "neutral",
  color,
  mascot,
  animate = false,
}: {
  label: string;
  tone?: "accent" | "neutral";
  /** Deterministic per-agent color (see lib/agent-color.ts) — overrides `tone` when given, for telling colleagues apart in a shared feed. */
  color?: string;
  /** Mascot emoji — when present it IS the avatar (Grok-Bot style), floating gently. */
  mascot?: string | null;
  /** Animate (bounce) — used while the agent is running. */
  animate?: boolean;
}) {
  const bg = tone === "accent" ? "bg-accent text-accent-fg" : "bg-bg-sunken text-fg-muted";
  void animate;
  if (mascot) {
    return (
      <span className="agent-mascot flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl text-lg leading-none shadow-sm">
        {mascot}
      </span>
    );
  }
  return (
    <span
      className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-sm font-semibold shadow-sm ${color ? "" : bg}`}
      style={color ? { backgroundColor: color, color: "#fff" } : undefined}
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Card({ children, className = "", padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <div className={`rounded-xl border border-border bg-bg-raised shadow-sm ${padded ? "p-5" : ""} ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`mb-4 border-b border-border pb-4 ${className}`}>
      {children}
    </div>
  );
}

export function CardTitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <h3 className={`text-lg font-semibold text-fg ${className}`}>
      {children}
    </h3>
  );
}

export function CardDescription({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`mt-1 text-sm text-fg-muted ${className}`}>
      {children}
    </p>
  );
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
    <div className="flex flex-col items-center justify-center gap-4 px-8 py-16 text-center">
      {icon && <div className="text-fg-subtle text-4xl">{icon}</div>}
      <div>
        <p className="text-lg font-semibold text-fg">{title}</p>
        {description && <p className="mx-auto mt-2 max-w-md text-base text-fg-muted">{description}</p>}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// Modern separator
export function Separator({ className = "" }: { className?: string }) {
  return <div className={`h-px w-full bg-border ${className}`} />;
}

// Modern hover card
export function HoverCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-border bg-bg-raised p-4 shadow-sm transition-all hover:border-border-strong hover:shadow-md ${className}`}>
      {children}
    </div>
  );
}

// Status indicator
export function StatusDot({ status = "active", className = "" }: { status?: "active" | "idle" | "offline"; className?: string }) {
  const colors = {
    active: "bg-success",
    idle: "bg-warning",
    offline: "bg-danger",
  };
  return (
    <span className={`inline-block h-2 w-2 rounded-full ${colors[status]} ${className}`} />
  );
}

// Skeleton loader
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-bg-sunken ${className}`} />;
}

// Text skeleton
export function TextSkeleton({ lines = 1, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-4 w-full" />
      ))}
    </div>
  );
}
