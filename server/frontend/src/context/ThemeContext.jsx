/* eslint-disable react-refresh/only-export-components */
import { createContext, useState, useEffect } from "react";

export const ThemeContext = createContext(undefined);

const DEFAULT_COLORS = {
  primary: "#ffffff",
  secondary: "#000000",
  accent: "#767676",
};

const DEFAULT_DARK_COLORS = {
  primary: "#000000",
  secondary: "#ffffff",
  accent: "#767676",
};

function isValidHexColor(color) {
  if (!color || typeof color !== "string") return false;
  return /^#[0-9A-Fa-f]{6}$/.test(color);
}

function sanitizeColors(colors, defaults) {
  return {
    primary: isValidHexColor(colors?.primary) ? colors.primary : defaults.primary,
    secondary: isValidHexColor(colors?.secondary) ? colors.secondary : defaults.secondary,
    accent: isValidHexColor(colors?.accent) ? colors.accent : defaults.accent,
  };
}

function getStoredValue(key, defaultValue) {
  try {
    const stored = localStorage.getItem(key);
    if (stored) return JSON.parse(stored);
  } catch {
    localStorage.removeItem(key);
  }
  return defaultValue;
}

function applyThemeColors(colors, darkColors, isDark, useSeparateDarkColors) {
  const root = document.documentElement;
  
  root.style.setProperty("--custom-primary", colors.primary);
  root.style.setProperty("--custom-secondary", colors.secondary);
  root.style.setProperty("--custom-accent", colors.accent);
  
  if (useSeparateDarkColors && darkColors) {
    root.style.setProperty("--custom-primary-dark", darkColors.primary);
    root.style.setProperty("--custom-secondary-dark", darkColors.secondary);
    root.style.setProperty("--custom-accent-dark", darkColors.accent);
  } else {
    // Swap primary/secondary for dark mode when not using separate colors
    root.style.setProperty("--custom-primary-dark", colors.secondary);
    root.style.setProperty("--custom-secondary-dark", colors.primary);
    root.style.setProperty("--custom-accent-dark", colors.accent);
  }
  
  if (isDark) {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("theme");
      if (stored === "dark" || stored === "light") return stored;
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "light";
  });
  
  const [customColors, setCustomColors] = useState(() => 
    getStoredValue("theme-colors", null)
  );
  
  const [darkColors, setDarkColors] = useState(() =>
    getStoredValue("theme-dark-colors", null)
  );
  
  const [useSeparateDarkColors, setUseSeparateDarkColors] = useState(() =>
    getStoredValue("theme-separate-dark", false)
  );

  useEffect(() => {
    const root = document.documentElement;
    
    if (customColors) {
      root.classList.add("theme-custom");
      applyThemeColors(customColors, darkColors, theme === "dark", useSeparateDarkColors);
    } else {
      root.classList.remove("theme-custom");
      root.style.removeProperty("--custom-primary");
      root.style.removeProperty("--custom-secondary");
      root.style.removeProperty("--custom-accent");
      root.style.removeProperty("--custom-primary-dark");
      root.style.removeProperty("--custom-secondary-dark");
      root.style.removeProperty("--custom-accent-dark");
      
      if (theme === "dark") {
        root.classList.add("dark");
      } else {
        root.classList.remove("dark");
      }
    }
    
    localStorage.setItem("theme", theme);
    if (customColors) {
      localStorage.setItem("theme-colors", JSON.stringify(customColors));
    } else {
      localStorage.removeItem("theme-colors");
    }
    
    if (darkColors && useSeparateDarkColors) {
      localStorage.setItem("theme-dark-colors", JSON.stringify(darkColors));
    } else {
      localStorage.removeItem("theme-dark-colors");
    }
    
    localStorage.setItem("theme-separate-dark", JSON.stringify(useSeparateDarkColors));
  }, [theme, customColors, darkColors, useSeparateDarkColors]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  const setColors = (colors) => {
    if (!colors) {
      setCustomColors(null);
      setDarkColors(null);
      return;
    }
    const sanitized = sanitizeColors(colors, theme === "dark" ? DEFAULT_DARK_COLORS : DEFAULT_COLORS);
    setCustomColors(sanitized);
  };

  const setDarkModeColors = (colors) => {
    if (!colors) {
      setDarkColors(null);
      return;
    }
    const sanitized = sanitizeColors(colors, DEFAULT_DARK_COLORS);
    setDarkColors(sanitized);
  };

  const setUseSeparateDarkModeColors = (value) => {
    setUseSeparateDarkColors(Boolean(value));
  };

  const resetColors = () => {
    setCustomColors(null);
    setDarkColors(null);
    setUseSeparateDarkColors(false);
  };

  const currentColors = customColors || (theme === "dark" ? DEFAULT_DARK_COLORS : DEFAULT_COLORS);
  const currentDarkColors = (useSeparateDarkColors && darkColors) ? darkColors : (useSeparateDarkColors ? DEFAULT_DARK_COLORS : null);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme,
        toggleTheme,
        colors: currentColors,
        setColors,
        darkColors: currentDarkColors,
        setDarkColors: setDarkModeColors,
        useSeparateDarkColors,
        setUseSeparateDarkColors: setUseSeparateDarkModeColors,
        resetColors,
        isCustomTheme: !!customColors,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
