import { useState } from 'react';
import { Sun, Moon, Palette, Circle, RotateCcw, Save } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { Card, Button, Input } from '../components/ui';

const Settings = () => {
  const { theme, setMode, setCustomColors, setTheme } = useTheme();
  const [localColors, setLocalColors] = useState(theme.customColors);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const presetThemes = [
    {
      name: 'Default',
      colors: { primary: '#000000', secondary: '#FFFFFF', accent: '#767676' },
    },
    {
      name: 'Ocean',
      colors: { primary: '#0A192F', secondary: '#64FFDA', accent: '#8892B0' },
    },
    {
      name: 'Sunset',
      colors: { primary: '#1A1A2E', secondary: '#FF6B6B', accent: '#4ECDC4' },
    },
    {
      name: 'Forest',
      colors: { primary: '#1B2D1B', secondary: '#90EE90', accent: '#6B8E6B' },
    },
    {
      name: 'Lavender',
      colors: { primary: '#2D2040', secondary: '#E6E6FA', accent: '#9370DB' },
    },
    {
      name: 'Coffee',
      colors: { primary: '#2C1810', secondary: '#D4A574', accent: '#8B6914' },
    },
  ];

  const handleModeChange = (mode) => {
    setMode(mode);
  };

  const handleColorChange = (colorKey, value) => {
    setLocalColors(prev => ({ ...prev, [colorKey]: value }));
    setHasUnsavedChanges(true);
  };

  const handleApplyColors = () => {
    setCustomColors(localColors);
    setMode('custom');
    setHasUnsavedChanges(false);
  };

  const handleApplyPreset = (preset) => {
    setLocalColors(preset.colors);
    setCustomColors(preset.colors);
    setMode('custom');
    setHasUnsavedChanges(false);
  };

  const handleReset = () => {
    const defaultColors = { primary: '#000000', secondary: '#FFFFFF', accent: '#767676' };
    setLocalColors(defaultColors);
    setCustomColors(defaultColors);
    setMode('dark');
    setHasUnsavedChanges(false);
  };

  const handleToggleDifferentDarkPalette = () => {
    setTheme(prev => ({
      ...prev,
      useDifferentDarkPalette: !prev.useDifferentDarkPalette,
    }));
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6 animate-fade-in">
      <div>
        <h1 className="font-mono text-2xl mb-2">Settings</h1>
        <p className="text-[var(--color-accent)]">Customize your LibreServ experience</p>
      </div>

      {/* Theme Mode Selection */}
      <Card>
        <h2 className="font-mono text-lg mb-4">Theme Mode</h2>
        <div className="grid grid-cols-3 gap-3">
          <button
            onClick={() => handleModeChange('light')}
            className={`
              flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all
              ${theme.mode === 'light'
                ? 'border-[var(--color-secondary)] bg-[var(--color-secondary)]/10'
                : 'border-[var(--color-accent)]/30 hover:border-[var(--color-accent)]'
              }
            `}
          >
            <Sun size={24} />
            <span className="font-mono text-sm">Light</span>
            {theme.mode === 'light' && <Circle size={12} fill="currentColor" />}
          </button>

          <button
            onClick={() => handleModeChange('dark')}
            className={`
              flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all
              ${theme.mode === 'dark'
                ? 'border-[var(--color-secondary)] bg-[var(--color-secondary)]/10'
                : 'border-[var(--color-accent)]/30 hover:border-[var(--color-accent)]'
              }
            `}
          >
            <Moon size={24} />
            <span className="font-mono text-sm">Dark</span>
            {theme.mode === 'dark' && <Circle size={12} fill="currentColor" />}
          </button>

          <button
            onClick={() => handleModeChange('custom')}
            className={`
              flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all
              ${theme.mode === 'custom'
                ? 'border-[var(--color-secondary)] bg-[var(--color-secondary)]/10'
                : 'border-[var(--color-accent)]/30 hover:border-[var(--color-accent)]'
              }
            `}
          >
            <Palette size={24} />
            <span className="font-mono text-sm">Custom</span>
            {theme.mode === 'custom' && <Circle size={12} fill="currentColor" />}
          </button>
        </div>
      </Card>

      {/* Preset Themes */}
      <Card>
        <h2 className="font-mono text-lg mb-4">Preset Themes</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {presetThemes.map((preset) => (
            <button
              key={preset.name}
              onClick={() => handleApplyPreset(preset)}
              className="group relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-[var(--color-accent)]/30 hover:border-[var(--color-secondary)] transition-all"
            >
              {/* Color Preview */}
              <div className="flex gap-1">
                <div
                  className="w-6 h-6 rounded-full border border-[var(--color-accent)]"
                  style={{ backgroundColor: preset.colors.primary }}
                />
                <div
                  className="w-6 h-6 rounded-full border border-[var(--color-accent)]"
                  style={{ backgroundColor: preset.colors.secondary }}
                />
                <div
                  className="w-6 h-6 rounded-full border border-[var(--color-accent)]"
                  style={{ backgroundColor: preset.colors.accent }}
                />
              </div>
              <span className="font-mono text-sm">{preset.name}</span>
            </button>
          ))}
        </div>
      </Card>

      {/* Custom Color Pickers */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-mono text-lg">Custom Colors</h2>
          {hasUnsavedChanges && (
            <span className="text-xs text-[var(--color-accent)] font-mono animate-pulse">● Unsaved changes</span>
          )}
        </div>

        <div className="space-y-4">
          {/* Primary Color */}
          <div className="flex items-center gap-4">
            <label className="font-mono text-sm w-24">Primary</label>
            <div className="flex-1 flex items-center gap-3">
              <input
                type="color"
                value={localColors.primary}
                onChange={(e) => handleColorChange('primary', e.target.value)}
                className="w-10 h-10 rounded-lg cursor-pointer border-2 border-[var(--color-secondary)]"
              />
              <Input
                type="text"
                value={localColors.primary}
                onChange={(e) => handleColorChange('primary', e.target.value)}
                className="flex-1 font-mono text-sm"
                placeholder="#000000"
              />
            </div>
          </div>

          {/* Secondary Color */}
          <div className="flex items-center gap-4">
            <label className="font-mono text-sm w-24">Secondary</label>
            <div className="flex-1 flex items-center gap-3">
              <input
                type="color"
                value={localColors.secondary}
                onChange={(e) => handleColorChange('secondary', e.target.value)}
                className="w-10 h-10 rounded-lg cursor-pointer border-2 border-[var(--color-secondary)]"
              />
              <Input
                type="text"
                value={localColors.secondary}
                onChange={(e) => handleColorChange('secondary', e.target.value)}
                className="flex-1 font-mono text-sm"
                placeholder="#FFFFFF"
              />
            </div>
          </div>

          {/* Accent Color */}
          <div className="flex items-center gap-4">
            <label className="font-mono text-sm w-24">Accent</label>
            <div className="flex-1 flex items-center gap-3">
              <input
                type="color"
                value={localColors.accent}
                onChange={(e) => handleColorChange('accent', e.target.value)}
                className="w-10 h-10 rounded-lg cursor-pointer border-2 border-[var(--color-secondary)]"
              />
              <Input
                type="text"
                value={localColors.accent}
                onChange={(e) => handleColorChange('accent', e.target.value)}
                className="flex-1 font-mono text-sm"
                placeholder="#767676"
              />
            </div>
          </div>
        </div>

        {/* Color Preview */}
        <div className="mt-6 p-4 rounded-xl border-2 border-[var(--color-accent)]/30">
          <p className="font-mono text-sm mb-3 text-[var(--color-accent)]">Preview</p>
          <div 
            className="p-4 rounded-xl"
            style={{ 
              backgroundColor: localColors.primary,
              border: `2px solid ${localColors.secondary}`,
            }}
          >
            <p 
              className="font-mono text-lg mb-2"
              style={{ color: localColors.secondary }}
            >
              Sample Heading
            </p>
            <p 
              className="text-sm"
              style={{ color: localColors.accent }}
            >
              This is how your theme will look with these colors.
            </p>
            <button
              className="mt-3 px-4 py-2 rounded-full font-mono text-sm"
              style={{ 
                backgroundColor: localColors.secondary,
                color: localColors.primary,
              }}
            >
              Sample Button
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 mt-6">
          <Button onClick={handleApplyColors} className="flex-1">
            <Save size={16} />
            Apply Colors
          </Button>
          <Button variant="outline" onClick={handleReset}>
            <RotateCcw size={16} />
            Reset
          </Button>
        </div>
      </Card>

      {/* Additional Options */}
      <Card>
        <h2 className="font-mono text-lg mb-4">Additional Options</h2>
        
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={theme.useDifferentDarkPalette}
            onChange={handleToggleDifferentDarkPalette}
            className="w-5 h-5 rounded border-2 border-[var(--color-secondary)] accent-[var(--color-secondary)]"
          />
          <div>
            <p className="font-mono text-sm">Use different palette for dark mode</p>
            <p className="text-xs text-[var(--color-accent)]">
              When enabled, you can set separate colors for light and dark modes
            </p>
          </div>
        </label>
      </Card>

      {/* About Section */}
      <Card>
        <h2 className="font-mono text-lg mb-4">About</h2>
        <div className="space-y-2 text-sm">
          <p><span className="text-[var(--color-accent)]">Version:</span> 0.1.0-alpha</p>
          <p><span className="text-[var(--color-accent)]">Design System:</span> Simplex Mono</p>
          <p><span className="text-[var(--color-accent)]">Made with:</span> React, Vite, Tailwind CSS</p>
        </div>
      </Card>
    </div>
  );
};

export default Settings;
