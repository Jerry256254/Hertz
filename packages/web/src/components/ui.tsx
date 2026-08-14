import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover disabled:hover:bg-accent",
  secondary: "bg-bg-raised text-fg border border-border hover:bg-bg-hover",
  ghost: "text-fg-muted hover:text-fg hover:bg-bg-hover",
  danger: "bg-danger-wash text-danger hover:brightness-110",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "secondary", size = "md", className = "", ...props }, ref) => (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center rounded-md font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className = "", ...props }, ref) => (
    <button
      ref={ref}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...props}
    />
  ),
);
IconButton.displayName = "IconButton";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className = "", ...props }, ref) => (
    <input
      ref={ref}
      className={`h-9 w-full rounded-md border border-border bg-bg-raised px-3 text-sm text-fg placeholder:text-fg-subtle outline-none transition-colors focus:border-accent disabled:opacity-50 ${className}`}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className = "", ...props }, ref) => (
    <textarea
      ref={ref}
      className={`w-full resize-none rounded-md border border-border bg-bg-raised px-3 py-2 text-sm text-fg placeholder:text-fg-subtle outline-none transition-colors focus:border-accent disabled:opacity-50 ${className}`}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <label className={`mb-1.5 block text-xs font-medium text-fg-muted ${className}`}>{children}</label>;
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
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-none ${BADGE_TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Avatar({ label, tone = "neutral" }: { label: string; tone?: "accent" | "neutral" }) {
  const bg = tone === "accent" ? "bg-accent text-accent-fg" : "bg-bg-sunken text-fg-muted";
  return (
    <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold ${bg}`}>
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-border bg-bg-raised ${className}`}>{children}</div>;
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
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon && <div className="text-fg-subtle">{icon}</div>}
      <div>
        <p className="text-sm font-medium text-fg">{title}</p>
        {description && <p className="mx-auto mt-1 max-w-sm text-sm text-fg-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
