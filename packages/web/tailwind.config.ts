import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class"],
  theme: {
    extend: {
      colors: {
        bg: "var(--color-bg)",
        "bg-sidebar": "var(--color-bg-sidebar)",
        "bg-raised": "var(--color-bg-raised)",
        "bg-sunken": "var(--color-bg-sunken)",
        "bg-hover": "var(--color-bg-hover)",
        border: "var(--color-border)",
        "border-strong": "var(--color-border-strong)",
        fg: "var(--color-fg)",
        "fg-muted": "var(--color-fg-muted)",
        "fg-subtle": "var(--color-fg-subtle)",
        accent: "var(--color-accent)",
        "accent-hover": "var(--color-accent-hover)",
        "accent-fg": "var(--color-accent-fg)",
        "accent-wash": "var(--color-accent-wash)",
        danger: "var(--color-danger)",
        "danger-wash": "var(--color-danger-wash)",
        success: "var(--color-success)",
        "success-wash": "var(--color-success-wash)",
        warning: "var(--color-warning)",
        "warning-wash": "var(--color-warning-wash)",
        info: "var(--color-info)",
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "'JetBrains Mono'",
          "Menlo",
          "Consolas",
          "monospace",
        ],
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "'Segoe UI'",
          "'Inter'",
          "sans-serif",
        ],
      },
      borderRadius: {
        DEFAULT: "var(--radius-sm)",
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        popover: "var(--shadow-popover)",
      },
    },
  },
  plugins: [],
} satisfies Config;
