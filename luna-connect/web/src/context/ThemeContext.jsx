import { createContext, useContext, useEffect, useState, useCallback } from "react";

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem("luna-connect-theme") || "system";
  });

  const applyTheme = useCallback((t) => {
    const prefersDark = typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-color-scheme:dark)").matches;
    const isDark = t === "dark" || (t === "system" && prefersDark);
    document.documentElement.classList.toggle("dark", isDark);
    const favicon = document.getElementById("favicon");
    if (favicon) {
      favicon.href = isDark ? "/favicon-dark.svg?v=3" : "/favicon.svg?v=3";
    }
  }, []);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem("luna-connect-theme", theme);
  }, [theme, applyTheme]);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const prefersDark = typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-color-scheme:dark)").matches;
      const isDark = prev === "dark" || (prev === "system" && prefersDark);
      return isDark ? "light" : "dark";
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
