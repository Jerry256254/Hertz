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
  // ink = black on paper, the default primary — stark, editorial
  primary: "bg-fg text-bg-raised border border-fg hover:bg-accent-hover hover:border-accent-hover active:scale-[0.98]",
  secondary: "bg-bg-raised text-fg border border-border hover:bg-bg-hover hover:border-border-strong active:scale-[0.98]",
  ghost: "text-fg-muted hover:text-fg hover:bg-bg-sunken border border-transparent active:scale-[0.98]",
  danger: "bg-danger text-white border border-danger hover:bg-[#9F1E14] hover:border-[#9F1E14] active:scale-[0.98]",
  outline: "text-fg border border-border-strong bg-transparent hover:bg-bg-sunken hover:border-fg active:scale-[0.98]",
  ink: "bg-fg text-bg-raised border border-fg hover:bg-accent-hover active:scale-[0.98]",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-[30px] px-3 text-[12px] gap-1.5 rounded-[8px]",
  md: "h-[36px] px-4 text-[13px] gap-2 rounded-[8px]",
  lg: "h-[44px] px-6 text-[14px] gap-2.5 rounded-[10px]",
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
      className={`inline-flex h-8 w-8 items-center justify-center rounded-[8px] border border-transparent text-fg-muted hover:bg-bg-sunken hover:text-fg hover:border-border active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...props}
    />
  ),
);
IconButton.displayName = "IconButton";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className = "", ...props }, ref) => (
    <input
      ref={ref}
      className={`h-[36px] w-full rounded-[8px] border border-border bg-bg-raised px-3 text-[14px] leading-none text-fg placeholder:text-fg-subtle outline-none focus:border-fg focus:bg-bg-raised disabled:opacity-50 ${className}`}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className = "", ...props }, ref) => (
    <textarea
      ref={ref}
      className={`w-full resize-none rounded-[8px] border border-border bg-bg-raised px-3 py-2.5 text-[14px] leading-relaxed text-fg placeholder:text-fg-subtle outline-none focus:border-fg disabled:opacity-50 ${className}`}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <label className={`mb-1.5 block mono text-[10px] font-[600] tracking-[0.08em] text-fg-muted ${className}`}>{children}</label>;
}

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "live";

const BADGE_TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-bg-sunken text-fg-muted border border-border",
  accent: "bg-fg text-bg-raised border border-fg",
  success: "bg-success-wash text-success border border-success/15",
  warning: "bg-warning-wash text-warning border border-warning/15",
  danger: "bg-danger-wash text-danger border border-danger/15",
  live: "bg-live-wash text-live border border-live/15",
};

export function Badge({ children, tone = "neutral", className = "" }: { children: ReactNode; tone?: BadgeTone; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[6px] px-1.5 py-1 mono text-[10px] font-[700] leading-none tracking-[0.06em] ${BADGE_TONE_CLASSES[tone]} ${className}`}
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
  color?: string;
  mascot?: string | null;
  animate?: boolean;
}) {
  void animate;
  if (mascot) {
    return (
      <span className="agent-mascot flex h-7 w-7 flex-shrink-0 items-center justify-center text-[15px] leading-none">
        {mascot}
      </span>
    );
  }
  const bg = tone === "accent" ? "bg-fg text-bg-raised border border-fg" : "bg-bg-sunken text-fg-muted border border-border";
  return (
    <span
      className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[8px] text-[11px] font-[700] tracking-[-0.02em] ${color ? "" : bg}`}
      style={color ? { backgroundColor: color, color: "#fff", border: "1px solid transparent" } : undefined}
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Card({ children, className = "", padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <div className={`rounded-[14px] border border-border bg-bg-raised ${padded ? "p-4" : ""} ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mb-3 ${className}`}>{children}</div>;
}

export function CardTitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <h3 className={`text-[14px] font-[650] tracking-[-0.015em] text-fg ${className}`}>{children}</h3>;
}

export function CardDescription({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`mt-1 mono text-[12px] leading-relaxed text-fg-muted ${className}`}>{children}</p>;
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
      {icon && <div className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-border bg-bg-sunken text-fg-subtle">{icon}</div>}
      <div>
        <p className="text-[14px] font-[650] tracking-[-0.02em] text-fg">{title}</p>
        {description && <p className="mx-auto mt-1 max-w-[40ch] text-[13px] leading-relaxed text-fg-muted">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function Separator({ className = "" }: { className?: string }) {
  return <div className={`h-px w-full bg-border ${className}`} />;
}

export function HoverCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`group rounded-[12px] border border-border bg-bg-raised p-3 hover:border-border-strong hover:bg-bg-raised ${className}`}>
      {children}
    </div>
  );
}

export function StatusDot({ status = "active", className = "" }: { status?: "active" | "idle" | "offline"; className?: string }) {
  const colors = { active: "bg-live", idle: "bg-warning", offline: "bg-fg-faint" };
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${colors[status]} ${className}`} />;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-[8px] bg-bg-sunken ${className}`} />;
}

export function TextSkeleton({ lines = 1, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-3.5 w-full" />
      ))}
    </div>
  );
}
