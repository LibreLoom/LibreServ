/* eslint-disable react-refresh/only-export-components */
import { createContext, useState, useEffect, useCallback, useRef } from "react";

export const ThemeContext = createContext(undefined);

function getSystemTheme() {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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

function resolveColors(isDark, customColors, darkColors, useSeparateDarkColors) {
  if (customColors) {
    if (isDark && useSeparateDarkColors && darkColors) {
      return sanitizeColors(darkColors, DEFAULT_DARK_COLORS);
    }
    if (isDark) {
      return {
        primary: isValidHexColor(customColors.secondary) ? customColors.secondary : DEFAULT_DARK_COLORS.primary,
        secondary: isValidHexColor(customColors.primary) ? customColors.primary : DEFAULT_DARK_COLORS.secondary,
        accent: isValidHexColor(customColors.accent) ? customColors.accent : DEFAULT_DARK_COLORS.accent,
      };
    }
    return sanitizeColors(customColors, DEFAULT_LIGHT_COLORS);
  }
  return isDark ? DEFAULT_DARK_COLORS : DEFAULT_LIGHT_COLORS;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

const THEME_TRANSITION_MS = 1500;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("theme");
      if (stored === "system" || stored === "dark" || stored === "light") return stored;
    }
    return "system";
  });

  const [use12HourTime, setUse12HourTime] = useState(() => getStoredValue("use12HourTime", false));

  const [systemTheme, setSystemTheme] = useState(() => getSystemTheme());

  const resolvedTheme = theme === "system" ? systemTheme : theme;

  const [customColors, setCustomColors] = useState(() =>
    getStoredValue("theme-colors", null)
  );

  const [darkColors, setDarkColors] = useState(() =>
    getStoredValue("theme-dark-colors", null)
  );

  const [useSeparateDarkColors, setUseSeparateDarkColors] = useState(() =>
    getStoredValue("theme-separate-dark", false)
  );

  const initializedRef = useRef(false);
  const animFrameRef = useRef(null);
  const renderedColorsRef = useRef(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e) => setSystemTheme(e.matches ? "dark" : "light");
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  function animateColors(root, target) {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    const from = renderedColorsRef.current || target;
    const prefersReduced = window.matchMedia(REDUCED_MOTION_QUERY).matches;
    const duration = prefersReduced ? 0 : THEME_TRANSITION_MS;

    if (duration === 0) {
      root.style.setProperty("--primary", target.primary);
      root.style.setProperty("--secondary", target.secondary);
      root.style.setProperty("--accent", target.accent);
      renderedColorsRef.current = { ...target };
      return;
    }

    const fromRgb = {
      primary: hexToRgb(from.primary),
      secondary: hexToRgb(from.secondary),
      accent: hexToRgb(from.accent),
    };
    const toRgb = {
      primary: hexToRgb(target.primary),
      secondary: hexToRgb(target.secondary),
      accent: hexToRgb(target.accent),
    };

    const startTime = performance.now();

    function step(now) {
      const t = Math.min((now - startTime) / duration, 1);
      const e = easeOutCubic(t);

      const primary = rgbToHex(
        Math.round(fromRgb.primary[0] + (toRgb.primary[0] - fromRgb.primary[0]) * e),
        Math.round(fromRgb.primary[1] + (toRgb.primary[1] - fromRgb.primary[1]) * e),
        Math.round(fromRgb.primary[2] + (toRgb.primary[2] - fromRgb.primary[2]) * e),
      );
      const secondary = rgbToHex(
        Math.round(fromRgb.secondary[0] + (toRgb.secondary[0] - fromRgb.secondary[0]) * e),
        Math.round(fromRgb.secondary[1] + (toRgb.secondary[1] - fromRgb.secondary[1]) * e),
        Math.round(fromRgb.secondary[2] + (toRgb.secondary[2] - fromRgb.secondary[2]) * e),
      );
      const accent = rgbToHex(
        Math.round(fromRgb.accent[0] + (toRgb.accent[0] - fromRgb.accent[0]) * e),
        Math.round(fromRgb.accent[1] + (toRgb.accent[1] - fromRgb.accent[1]) * e),
        Math.round(fromRgb.accent[2] + (toRgb.accent[2] - fromRgb.accent[2]) * e),
      );

      root.style.setProperty("--primary", primary);
      root.style.setProperty("--secondary", secondary);
      root.style.setProperty("--accent", accent);

      if (t < 1) {
        animFrameRef.current = requestAnimationFrame(step);
      } else {
        renderedColorsRef.current = { ...target };
        animFrameRef.current = null;
      }
    }

    animFrameRef.current = requestAnimationFrame(step);
  }

  useEffect(() => {
    const root = document.documentElement;
    const isDark = resolvedTheme === "dark";
    const target = resolveColors(isDark, customColors, darkColors, useSeparateDarkColors);

    if (isDark) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }

    if (!initializedRef.current) {
      initializedRef.current = true;
      root.style.setProperty("--primary", target.primary);
      root.style.setProperty("--secondary", target.secondary);
      root.style.setProperty("--accent", target.accent);
      renderedColorsRef.current = { ...target };
    } else {
      animateColors(root, target);
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
    localStorage.setItem("use12HourTime", JSON.stringify(use12HourTime));
  }, [theme, resolvedTheme, customColors, darkColors, useSeparateDarkColors, use12HourTime]);

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
    const sanitized = sanitizeColors(colors, resolvedTheme === "dark" ? DEFAULT_DARK_COLORS : DEFAULT_LIGHT_COLORS);
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

  const setUse12Hour = (value) => {
    setUse12HourTime(Boolean(value));
  };

  const currentColors = customColors || (resolvedTheme === "dark" ? DEFAULT_DARK_COLORS : DEFAULT_LIGHT_COLORS);
  const currentDarkColors = (useSeparateDarkColors && darkColors) ? darkColors : (useSeparateDarkColors ? DEFAULT_DARK_COLORS : null);

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
