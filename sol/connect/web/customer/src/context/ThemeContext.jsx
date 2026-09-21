import { createContext, useContext, useEffect, useState, useCallback } from "react";

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem("connect-theme") || "system";
  });

  const applyTheme = useCallback((t) => {
    const isDark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme:dark)").matches);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem("connect-theme", theme);
  }, [theme, applyTheme]);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const isDark = prev === "dark" || (prev === "system" && window.matchMedia("(prefers-color-scheme:dark)").matches);
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
