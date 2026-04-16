/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
} from "react";

export const ThemeContext = createContext(undefined);

function getSystemTheme() {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
}

const DEFAULT_LIGHT_COLORS = {
  primary: "#ffffff",
  secondary: "#000000",
  accent: "#767676",
};

const DEFAULT_DARK_COLORS = {
  primary: "#000000",
  secondary: "#dddddd",
  accent: "#686868",
};

function isValidHexColor(color) {
  if (!color || typeof color !== "string") return false;
  return /^#[0-9A-Fa-f]{6}$/.test(color);
}

function sanitizeColors(colors, defaults) {
  return {
    primary: isValidHexColor(colors?.primary)
      ? colors.primary
      : defaults.primary,
    secondary: isValidHexColor(colors?.secondary)
      ? colors.secondary
      : defaults.secondary,
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

function resolveColors(
  isDark,
  customColors,
  darkColors,
  useSeparateDarkColors,
) {
  if (customColors) {
    if (isDark && useSeparateDarkColors && darkColors) {
      return sanitizeColors(darkColors, DEFAULT_DARK_COLORS);
    }
    if (isDark) {
      return {
        primary: isValidHexColor(customColors.secondary)
          ? customColors.secondary
          : DEFAULT_DARK_COLORS.primary,
        secondary: isValidHexColor(customColors.primary)
          ? customColors.primary
          : DEFAULT_DARK_COLORS.secondary,
        accent: isValidHexColor(customColors.accent)
          ? customColors.accent
          : DEFAULT_DARK_COLORS.accent,
      };
    }
    return sanitizeColors(customColors, DEFAULT_LIGHT_COLORS);
  }
  return isDark ? DEFAULT_DARK_COLORS : DEFAULT_LIGHT_COLORS;
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("theme");
      if (stored === "system" || stored === "dark" || stored === "light")
        return stored;
    }
    return "system";
  });

  const [use12HourTime, setUse12HourTime] = useState(() =>
    getStoredValue("use12HourTime", false),
  );

  const [systemTheme, setSystemTheme] = useState(() => getSystemTheme());

  const resolvedTheme = theme === "system" ? systemTheme : theme;

  const [customColors, setCustomColors] = useState(() =>
    getStoredValue("theme-colors", null),
  );

  const [darkColors, setDarkColors] = useState(() =>
    getStoredValue("theme-dark-colors", null),
  );

  const [useSeparateDarkColors, setUseSeparateDarkColors] = useState(() =>
    getStoredValue("theme-separate-dark", false),
  );

  const initializedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e) => setSystemTheme(e.matches ? "dark" : "light");
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const isDark = resolvedTheme === "dark";
    const target = resolveColors(
      isDark,
      customColors,
      darkColors,
      useSeparateDarkColors,
    );

    if (!initializedRef.current) {
      initializedRef.current = true;
      root.dataset.noThemeTransition = "";
      root.classList.toggle("dark", isDark);
    }

    root.dataset.themeTransitioning = "";
    root.style.colorScheme = isDark ? "dark" : "light";
    root.style.setProperty("--primary", target.primary);
    root.style.setProperty("--secondary", target.secondary);
    root.style.setProperty("--accent", target.accent);

    let rafId;
    if ("noThemeTransition" in root.dataset) {
      rafId = requestAnimationFrame(() => {
        delete root.dataset.noThemeTransition;
      });
    }

    const timerId = setTimeout(() => {
      delete root.dataset.themeTransitioning;
    }, 1500);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      clearTimeout(timerId);
      delete root.dataset.themeTransitioning;
    };
  }, [resolvedTheme, customColors, darkColors, useSeparateDarkColors]);

  useEffect(() => {
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

    localStorage.setItem(
      "theme-separate-dark",
      JSON.stringify(useSeparateDarkColors),
    );
    localStorage.setItem("use12HourTime", JSON.stringify(use12HourTime));
  }, [
    theme,
    resolvedTheme,
    customColors,
    darkColors,
    useSeparateDarkColors,
    use12HourTime,
  ]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      if (prev === "system") return "light";
      if (prev === "light") return "dark";
      return "system";
    });
  }, []);

  const setColors = (colors) => {
    if (!colors) {
      setCustomColors(null);
      setDarkColors(null);
      return;
    }
    const sanitized = sanitizeColors(
      colors,
      resolvedTheme === "dark" ? DEFAULT_DARK_COLORS : DEFAULT_LIGHT_COLORS,
    );
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

  const setUse12Hour = useCallback((value) => {
    setUse12HourTime(Boolean(value));
  }, []);

  const currentColors =
    customColors ||
    (resolvedTheme === "dark" ? DEFAULT_DARK_COLORS : DEFAULT_LIGHT_COLORS);
  const currentDarkColors =
    useSeparateDarkColors && darkColors
      ? darkColors
      : useSeparateDarkColors
        ? DEFAULT_DARK_COLORS
        : null;

  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme,
        toggleTheme,
        resolvedTheme,
        colors: currentColors,
        setColors,
        darkColors: currentDarkColors,
        setDarkColors: setDarkModeColors,
        useSeparateDarkColors,
        setUseSeparateDarkColors: setUseSeparateDarkModeColors,
        resetColors,
        isCustomTheme: !!customColors,
        use12HourTime,
        setUse12HourTime: setUse12Hour,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
