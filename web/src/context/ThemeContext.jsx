import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const ThemeContext = createContext(null);

const defaultTheme = {
  mode: 'light',
  customColors: {
    primary: '#FFFFFF',
    secondary: '#000000',
    accent: '#767676',
  },
  darkCustomColors: {
    primary: '#000000',
    secondary: '#FFFFFF',
    accent: '#767676',
  },
  useDifferentDarkPalette: false,
  hapticsEnabled: true,
  hapticsIntensity: 'medium', // 'light', 'medium', 'heavy'
};

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem('libreserv-theme-v3');
      return saved ? { ...defaultTheme, ...JSON.parse(saved) } : defaultTheme;
    } catch {
      return defaultTheme;
    }
  });

  // Apply theme to DOM
  useEffect(() => {
    localStorage.setItem('libreserv-theme-v3', JSON.stringify(theme));
    
    const root = document.documentElement;
    root.setAttribute('data-theme', theme.mode);
    
    if (theme.mode === 'custom') {
      root.style.setProperty('--custom-primary', theme.customColors.primary);
      root.style.setProperty('--custom-secondary', theme.customColors.secondary);
      root.style.setProperty('--custom-accent', theme.customColors.accent);
    }
  }, [theme]);

  const setMode = useCallback((mode) => {
    setTheme(prev => ({ ...prev, mode }));
  }, []);

  const toggleMode = useCallback(() => {
    setTheme(prev => ({
      ...prev,
      mode: prev.mode === 'dark' ? 'light' : 'dark',
    }));
  }, []);

  const setCustomColors = useCallback((colors) => {
    setTheme(prev => ({
      ...prev,
      customColors: { ...prev.customColors, ...colors },
    }));
  }, []);

  const setHaptics = useCallback((enabled, intensity) => {
    setTheme(prev => ({
      ...prev,
      hapticsEnabled: enabled ?? prev.hapticsEnabled,
      hapticsIntensity: intensity ?? prev.hapticsIntensity,
    }));
  }, []);

  // Trigger haptic feedback
  const haptic = useCallback((type = 'light') => {
    if (!theme.hapticsEnabled) return;
    
    // Web Vibration API
    if ('vibrate' in navigator) {
      const patterns = {
        light: [10],
        medium: [20],
        heavy: [30],
        success: [10, 50, 10],
        error: [50, 30, 50],
      };
      navigator.vibrate(patterns[type] || patterns.light);
    }
  }, [theme.hapticsEnabled]);

  const value = {
    theme,
    setTheme,
    setMode,
    toggleMode,
    setCustomColors,
    setHaptics,
    haptic,
    isDark: theme.mode === 'dark',
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

export default ThemeContext;
