import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class"],
  theme: {
    extend: {
      colors: {
        // Background colors
        bg: "var(--color-bg)",
        "bg-sidebar": "var(--color-bg-sidebar)",
        "bg-raised": "var(--color-bg-raised)",
        "bg-sunken": "var(--color-bg-sunken)",
        "bg-hover": "var(--color-bg-hover)",
        "bg-overlay": "var(--color-bg-overlay)",
        
        // Border colors
        border: "var(--color-border)",
        "border-strong": "var(--color-border-strong)",
        "border-accent": "var(--color-border-accent)",
        
        // Foreground colors
        fg: "var(--color-fg)",
        "fg-muted": "var(--color-fg-muted)",
        "fg-subtle": "var(--color-fg-subtle)",
        "fg-inverse": "var(--color-fg-inverse)",
        
        // Accent colors
        accent: "var(--color-accent)",
        "accent-hover": "var(--color-accent-hover)",
        "accent-fg": "var(--color-accent-fg)",
        "accent-wash": "var(--color-accent-wash)",
        "accent-glow": "var(--color-accent-glow)",
        
        // Status colors
        danger: "var(--color-danger)",
        "danger-wash": "var(--color-danger-wash)",
        "danger-glow": "var(--color-danger-glow)",
        
        success: "var(--color-success)",
        "success-wash": "var(--color-success-wash)",
        "success-glow": "var(--color-success-glow)",
        
        warning: "var(--color-warning)",
        "warning-wash": "var(--color-warning-wash)",
        "warning-glow": "var(--color-warning-glow)",
        
        info: "var(--color-info)",
        "info-wash": "var(--color-info-wash)",
        "info-glow": "var(--color-info-glow)",
      },
      fontFamily: {
        mono: [
          "'JetBrains Mono'",
          "'Fira Code'",
          "'Cascadia Code'",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
        sans: [
          "'Inter'",
          "-apple-system",
          "BlinkMacSystemFont",
          "'Segoe UI'",
          "Roboto",
          "'Helvetica Neue'",
          "Arial",
          "sans-serif",
        ],
      },
      fontSize: {
        xs: "var(--font-size-xs)",
        sm: "var(--font-size-sm)",
        base: "var(--font-size-base)",
        lg: "var(--font-size-lg)",
        xl: "var(--font-size-xl)",
        "2xl": "var(--font-size-2xl)",
      },
      fontWeight: {
        normal: "var(--font-weight-normal)",
        medium: "var(--font-weight-medium)",
        semibold: "var(--font-weight-semibold)",
        bold: "var(--font-weight-bold)",
      },
      lineHeight: {
        tight: "var(--line-height-tight)",
        normal: "var(--line-height-normal)",
        relaxed: "var(--line-height-relaxed)",
      },
      borderRadius: {
        DEFAULT: "var(--radius-sm)",
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        full: "var(--radius-full)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        popover: "var(--shadow-popover)",
        glow: "var(--shadow-glow)",
        "glow-sm": "var(--shadow-glow-sm)",
      },
      spacing: {
        xs: "var(--spacing-xs)",
        sm: "var(--spacing-sm)",
        md: "var(--spacing-md)",
        lg: "var(--spacing-lg)",
        xl: "var(--spacing-xl)",
        "2xl": "var(--spacing-2xl)",
      },
      animation: {
        "fade-in": "fade-in var(--transition-normal) ease-out forwards",
        "fade-in-scale": "fade-in-scale var(--transition-normal) ease-out forwards",
        "slide-in": "slide-in var(--transition-normal) ease-out forwards",
        pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        shimmer: "shimmer 1.5s infinite",
        glow: "glow 2s ease-in-out infinite",
      },
      transitionDuration: {
        fast: "var(--transition-fast)",
        normal: "var(--transition-normal)",
        slow: "var(--transition-slow)",
      },
      transitionTimingFunction: {
        DEFAULT: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
    },
  },
  plugins: [],
} satisfies Config;
