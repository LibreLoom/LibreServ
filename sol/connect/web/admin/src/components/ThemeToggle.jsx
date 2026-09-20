import { useTheme } from "../context/ThemeContext.jsx";
import { Sun, Moon } from "lucide-react";
import { cn } from "../lib/utils.js";

export function ThemeToggle({ className }) {
  const { toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      className={cn("rounded-pill p-2 text-muted-foreground hover:bg-accent transition-colors", className)}
      aria-label="Toggle dark mode"
    >
      <Sun className="h-4 w-4 dark:hidden" />
      <Moon className="h-4 w-4 hidden dark:block" />
    </button>
  );
}
