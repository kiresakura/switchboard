"use client";

import { useState, useEffect } from "react";
import { Monitor, Sun, Moon } from "lucide-react";
import { cn } from "@/lib/utils";

const THEME_KEY = "switchboard_theme";

type ThemeMode = "system" | "light" | "dark";

const modes: { value: ThemeMode; icon: typeof Monitor; label: string }[] = [
  { value: "system", icon: Monitor, label: "跟隨系統" },
  { value: "light", icon: Sun, label: "淺色模式" },
  { value: "dark", icon: Moon, label: "深色模式" },
];

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  if (mode === "light" || mode === "dark") {
    root.classList.add(mode);
  }
  // When "system", no class is added — the CSS @media query handles it
}

export function ThemeToggle({ collapsed }: { collapsed?: boolean }) {
  const [mode, setMode] = useState<ThemeMode>("system");

  // Read saved preference on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY) as ThemeMode | null;
      if (saved && (saved === "system" || saved === "light" || saved === "dark")) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setMode(saved);
        applyTheme(saved);
      }
    } catch {
      // localStorage unavailable
    }
  }, []);

  const cycle = () => {
    const currentIndex = modes.findIndex((m) => m.value === mode);
    const next = modes[(currentIndex + 1) % modes.length];
    setMode(next.value);
    applyTheme(next.value);
    try {
      localStorage.setItem(THEME_KEY, next.value);
    } catch {
      // localStorage unavailable
    }
  };

  const current = modes.find((m) => m.value === mode) || modes[0];
  const Icon = current.icon;

  return (
    <button
      onClick={cycle}
      className={cn(
        "rounded p-2 md:p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-secondary)] transition-colors",
        collapsed && "mx-auto"
      )}
      title={current.label}
      aria-label={current.label}
    >
      <Icon size={16} />
    </button>
  );
}
