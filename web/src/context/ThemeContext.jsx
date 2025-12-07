import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const ThemeContext = createContext(null);

const defaultCustomColors = {
  light: {
    primary: '#FFFFFF',
    secondary: '#000000',
    accent: '#767676',
  },
  dark: {
    primary: '#000000',
    secondary: '#FFFFFF',
    accent: '#767676',
  },
};

const defaultSettings = {
  mode: 'light', // 'light', 'dark', 'custom'
  customColors: defaultCustomColors,
  hapticEnabled: true,
};

export function ThemeProvider({ children }) {
  const [settings, setSettings] = useState(() => {
    try {
      const saved = localStorage.getItem('libreserv-theme-v4');
      return saved ? { ...defaultSettings, ...JSON.parse(saved) } : defaultSettings;
    } catch {
      return defaultSettings;
    }
  });

  // Apply theme to DOM
  useEffect(() => {
    localStorage.setItem('libreserv-theme-v4', JSON.stringify(settings));
    
    const root = document.documentElement;
    root.setAttribute('data-theme', settings.mode);
    
    // Apply custom colors when in custom mode
    if (settings.mode === 'custom') {
      // Determine if we're in system dark mode for custom theme
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const colors = prefersDark ? settings.customColors.dark : settings.customColors.light;
      
      root.style.setProperty('--custom-primary', colors.primary);
      root.style.setProperty('--custom-secondary', colors.secondary);
      root.style.setProperty('--custom-accent', colors.accent);
    }
  }, [settings]);

  // Theme mode setters
  const setTheme = useCallback((mode) => {
    setSettings(prev => ({ ...prev, mode }));
  }, []);

  const toggleTheme = useCallback(() => {
    setSettings(prev => ({
      ...prev,
      mode: prev.mode === 'dark' ? 'light' : 'dark',
    }));
  }, []);

  // Custom colors setter
  const setCustomColors = useCallback((colors) => {
    setSettings(prev => ({
      ...prev,
      customColors: {
        light: colors.light || prev.customColors.light,
        dark: colors.dark || prev.customColors.dark,
      },
    }));
  }, []);

  // Haptic setters
  const setHapticEnabled = useCallback((enabled) => {
    setSettings(prev => ({ ...prev, hapticEnabled: enabled }));
  }, []);

  // Trigger haptic feedback
  const haptic = useCallback((type = 'light') => {
    if (!settings.hapticEnabled) return;
    
    // Web Vibration API
    if ('vibrate' in navigator) {
      const patterns = {
        light: [10],
        medium: [25],
        heavy: [50],
        success: [15, 50, 15],
        error: [60, 30, 60],
      };
      navigator.vibrate(patterns[type] || patterns.light);
    }
  }, [settings.hapticEnabled]);

  const value = {
    // Current theme mode
    theme: settings.mode,
    setTheme,
    toggleTheme,
    
    // Custom colors
    customColors: settings.customColors,
    setCustomColors,
    
    // Haptics
    hapticEnabled: settings.hapticEnabled,
    setHapticEnabled,
    haptic,
    
    // Convenience flags
    isDark: settings.mode === 'dark',
    isCustom: settings.mode === 'custom',
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
