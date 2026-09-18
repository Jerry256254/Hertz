import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "hertz-theme";

export function currentTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

export function applyTheme(theme: Theme): void {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORAGE_KEY, theme);
}

/** Applied by the inline script in index.html before first paint (no flash), re-applied here for SPA navigations. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  useEffect(() => applyTheme(theme), [theme]);
  return [theme, setTheme];
}

const ORDER: Theme[] = ["system", "light", "dark"];
const ICONS = { system: Monitor, light: Sun, dark: Moon } as const;
const LABELS: Record<Theme, string> = { system: "Systém", light: "Světlý", dark: "Tmavý" };

export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const Icon = ICONS[theme];
  return (
    <button
      onClick={() => setTheme(ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!)}
      title={`Motiv: ${LABELS[theme]} (klikni pro změnu)`}
      className="flex h-7 w-7 items-center justify-center rounded-[8px] border border-border text-fg-subtle hover:bg-bg-hover hover:text-fg"
    >
      <Icon size={13} strokeWidth={1.85} />
    </button>
  );
}
