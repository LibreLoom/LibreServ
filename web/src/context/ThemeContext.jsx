import { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext(null);

const defaultTheme = {
  mode: 'light', // Default to light mode to match whiteboard vibe
  customColors: {
    primary: '#FFFFFF',
    secondary: '#000000',
    accent: '#767676',
  },
  useDifferentDarkPalette: false,
};

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('libreserv-theme-v2');
    return saved ? JSON.parse(saved) : defaultTheme;
  });

  useEffect(() => {
    localStorage.setItem('libreserv-theme-v2', JSON.stringify(theme));
    
    // Apply theme to document
    document.documentElement.setAttribute('data-theme', theme.mode);
    
    // Apply custom colors if in custom mode
    if (theme.mode === 'custom') {
      document.documentElement.style.setProperty('--custom-primary', theme.customColors.primary);
      document.documentElement.style.setProperty('--custom-secondary', theme.customColors.secondary);
      document.documentElement.style.setProperty('--custom-accent', theme.customColors.accent);
    }
  }, [theme]);

  const setMode = (mode) => {
    setTheme(prev => ({ ...prev, mode }));
  };

  const setCustomColors = (colors) => {
    setTheme(prev => ({
      ...prev,
      customColors: { ...prev.customColors, ...colors },
    }));
  };

  const toggleDarkMode = () => {
    setTheme(prev => ({
      ...prev,
      mode: prev.mode === 'dark' ? 'light' : 'dark',
    }));
  };

  const value = {
    theme,
    setTheme,
    setMode,
    setCustomColors,
    toggleDarkMode,
    isDark: theme.mode === 'dark' || (theme.mode === 'custom' && theme.useDifferentDarkPalette),
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
