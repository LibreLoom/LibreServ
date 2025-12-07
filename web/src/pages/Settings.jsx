import { useState } from 'react';
import { 
  Sun, 
  Moon, 
  Palette, 
  Vibrate,
  Monitor,
  RefreshCw,
  Save,
  RotateCcw
} from 'lucide-react';
import { Card, Button, Input } from '../components/ui';
import { useTheme } from '../context/ThemeContext';

// Preset themes
const PRESET_THEMES = [
  {
    id: 'default',
    name: 'Classic',
    description: 'Black and white simplicity',
    light: { primary: '#FFFFFF', secondary: '#000000', accent: '#767676' },
    dark: { primary: '#000000', secondary: '#FFFFFF', accent: '#767676' },
  },
  {
    id: 'warm',
    name: 'Warm Paper',
    description: 'Easy on the eyes',
    light: { primary: '#FDF6E3', secondary: '#073642', accent: '#93A1A1' },
    dark: { primary: '#002B36', secondary: '#FDF6E3', accent: '#586E75' },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    description: 'Cool blue tones',
    light: { primary: '#F0F4F8', secondary: '#1A365D', accent: '#718096' },
    dark: { primary: '#1A202C', secondary: '#E2E8F0', accent: '#4A5568' },
  },
  {
    id: 'forest',
    name: 'Forest',
    description: 'Natural greens',
    light: { primary: '#F0FFF4', secondary: '#22543D', accent: '#68D391' },
    dark: { primary: '#1A202C', secondary: '#9AE6B4', accent: '#48BB78' },
  },
];

export default function Settings() {
  const { 
    theme, 
    setTheme, 
    hapticEnabled, 
    setHapticEnabled, 
    haptic,
    customColors,
    setCustomColors,
  } = useTheme();

  const [localColors, setLocalColors] = useState(customColors);
  const [useDifferentDarkColors, setUseDifferentDarkColors] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState('default');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const handleThemeChange = (newTheme) => {
    haptic('light');
    setTheme(newTheme);
  };

  const handleHapticToggle = () => {
    // Trigger haptic before changing the setting so user feels it
    if (!hapticEnabled) {
      haptic('medium');
    }
    setHapticEnabled(!hapticEnabled);
  };

  const handleColorChange = (mode, colorType, value) => {
    setLocalColors(prev => ({
      ...prev,
      [mode]: {
        ...prev[mode],
        [colorType]: value,
      }
    }));
    setHasUnsavedChanges(true);
  };

  const handlePresetSelect = (preset) => {
    haptic('light');
    setSelectedPreset(preset.id);
    setLocalColors({
      light: preset.light,
      dark: preset.dark,
    });
    setHasUnsavedChanges(true);
  };

  const handleSaveColors = () => {
    haptic('medium');
    setCustomColors(localColors);
    setHasUnsavedChanges(false);
    // Switch to custom theme to apply
    if (theme !== 'custom') {
      setTheme('custom');
    }
  };

  const handleResetColors = () => {
    haptic('light');
    const defaultPreset = PRESET_THEMES[0];
    setLocalColors({
      light: defaultPreset.light,
      dark: defaultPreset.dark,
    });
    setSelectedPreset('default');
    setHasUnsavedChanges(true);
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="font-mono text-2xl">Settings</h1>
        <p className="text-[var(--color-accent)] mt-1">
          Customize your LibreServ experience
        </p>
      </div>

      {/* Theme Mode */}
      <Card>
        <h2 className="font-mono text-lg mb-4 flex items-center gap-2">
          <Monitor size={20} />
          Theme Mode
        </h2>
        
        <div className="grid grid-cols-3 gap-3">
          <button
            onClick={() => handleThemeChange('light')}
            className={`
              p-4 rounded-2xl border-2 border-[var(--color-secondary)]
              transition-all duration-200
              flex flex-col items-center gap-2
              ${theme === 'light' 
                ? 'bg-[var(--color-secondary)] text-[var(--color-primary)]' 
                : 'hover:bg-[var(--color-secondary)]/10'
              }
            `}
          >
            <Sun size={24} />
            <span className="font-mono text-sm">Light</span>
          </button>

          <button
            onClick={() => handleThemeChange('dark')}
            className={`
              p-4 rounded-2xl border-2 border-[var(--color-secondary)]
              transition-all duration-200
              flex flex-col items-center gap-2
              ${theme === 'dark' 
                ? 'bg-[var(--color-secondary)] text-[var(--color-primary)]' 
                : 'hover:bg-[var(--color-secondary)]/10'
              }
            `}
          >
            <Moon size={24} />
            <span className="font-mono text-sm">Dark</span>
          </button>

          <button
            onClick={() => handleThemeChange('custom')}
            className={`
              p-4 rounded-2xl border-2 border-[var(--color-secondary)]
              transition-all duration-200
              flex flex-col items-center gap-2
              ${theme === 'custom' 
                ? 'bg-[var(--color-secondary)] text-[var(--color-primary)]' 
                : 'hover:bg-[var(--color-secondary)]/10'
              }
            `}
          >
            <Palette size={24} />
            <span className="font-mono text-sm">Custom</span>
          </button>
        </div>
      </Card>

      {/* Preset Themes */}
      <Card>
        <h2 className="font-mono text-lg mb-4 flex items-center gap-2">
          <Palette size={20} />
          Preset Themes
        </h2>
        
        <div className="grid grid-cols-2 gap-3">
          {PRESET_THEMES.map(preset => (
            <button
              key={preset.id}
              onClick={() => handlePresetSelect(preset)}
              className={`
                p-4 rounded-2xl border-2 border-[var(--color-secondary)]
                transition-all duration-200 text-left
                ${selectedPreset === preset.id 
                  ? 'bg-[var(--color-secondary)]/10' 
                  : 'hover:bg-[var(--color-secondary)]/5'
                }
              `}
            >
              <div className="flex items-center gap-3 mb-2">
                {/* Color preview */}
                <div className="flex gap-1">
                  <div 
                    className="w-4 h-4 rounded-full border border-[var(--color-secondary)]/30"
                    style={{ backgroundColor: preset.light.primary }}
                  />
                  <div 
                    className="w-4 h-4 rounded-full border border-[var(--color-secondary)]/30"
                    style={{ backgroundColor: preset.light.secondary }}
                  />
                  <div 
                    className="w-4 h-4 rounded-full border border-[var(--color-secondary)]/30"
                    style={{ backgroundColor: preset.light.accent }}
                  />
                </div>
                {selectedPreset === preset.id && (
                  <span className="text-xs font-mono">Selected</span>
                )}
              </div>
              <h3 className="font-mono">{preset.name}</h3>
              <p className="text-[var(--color-accent)] text-sm">{preset.description}</p>
            </button>
          ))}
        </div>
      </Card>

      {/* Custom Colors */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-mono text-lg flex items-center gap-2">
            <Palette size={20} />
            Custom Colors
          </h2>
          {hasUnsavedChanges && (
            <span className="text-[var(--color-accent)] text-sm animate-pulse">
              Unsaved changes
            </span>
          )}
        </div>

        {/* Light Mode Colors */}
        <div className="mb-6">
          <h3 className="font-mono text-sm mb-3 text-[var(--color-accent)]">
            Light Mode
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm mb-2">Primary</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={localColors.light?.primary || '#FFFFFF'}
                  onChange={(e) => handleColorChange('light', 'primary', e.target.value)}
                  className="w-10 h-10 rounded-full border-2 border-[var(--color-secondary)] cursor-pointer flex-shrink-0"
                />
                <Input
                  value={localColors.light?.primary || '#FFFFFF'}
                  onChange={(e) => handleColorChange('light', 'primary', e.target.value)}
                  className="flex-1 font-mono text-sm min-w-0"
                  maxLength={7}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm mb-2">Secondary</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={localColors.light?.secondary || '#000000'}
                  onChange={(e) => handleColorChange('light', 'secondary', e.target.value)}
                  className="w-10 h-10 rounded-full border-2 border-[var(--color-secondary)] cursor-pointer flex-shrink-0"
                />
                <Input
                  value={localColors.light?.secondary || '#000000'}
                  onChange={(e) => handleColorChange('light', 'secondary', e.target.value)}
                  className="flex-1 font-mono text-sm min-w-0"
                  maxLength={7}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm mb-2">Accent</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={localColors.light?.accent || '#767676'}
                  onChange={(e) => handleColorChange('light', 'accent', e.target.value)}
                  className="w-10 h-10 rounded-full border-2 border-[var(--color-secondary)] cursor-pointer flex-shrink-0"
                />
                <Input
                  value={localColors.light?.accent || '#767676'}
                  onChange={(e) => handleColorChange('light', 'accent', e.target.value)}
                  className="flex-1 font-mono text-sm min-w-0"
                  maxLength={7}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Different dark mode colors toggle */}
        <div className="mb-6">
          <button
            onClick={() => {
              haptic('light');
              setUseDifferentDarkColors(!useDifferentDarkColors);
            }}
            className="flex items-center gap-3"
          >
            <div className={`
              w-12 h-7 rounded-full border-2 border-[var(--color-secondary)]
              relative transition-all duration-200
              ${useDifferentDarkColors ? 'bg-[var(--color-secondary)]' : ''}
            `}>
              <div className={`
                absolute top-0.5 w-5 h-5 rounded-full 
                transition-all duration-200
                ${useDifferentDarkColors 
                  ? 'right-0.5 bg-[var(--color-primary)]' 
                  : 'left-0.5 bg-[var(--color-secondary)]'
                }
              `} />
            </div>
            <span className="font-mono text-sm">
              Use different colors for dark mode
            </span>
          </button>
        </div>

        {/* Dark Mode Colors (if enabled) */}
        {useDifferentDarkColors && (
          <div className="mb-6 animate-slide-down">
            <h3 className="font-mono text-sm mb-3 text-[var(--color-accent)]">
              Dark Mode
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm mb-2">Primary</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={localColors.dark?.primary || '#000000'}
                    onChange={(e) => handleColorChange('dark', 'primary', e.target.value)}
                    className="w-10 h-10 rounded-full border-2 border-[var(--color-secondary)] cursor-pointer flex-shrink-0"
                  />
                  <Input
                    value={localColors.dark?.primary || '#000000'}
                    onChange={(e) => handleColorChange('dark', 'primary', e.target.value)}
                    className="flex-1 font-mono text-sm min-w-0"
                    maxLength={7}
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm mb-2">Secondary</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={localColors.dark?.secondary || '#FFFFFF'}
                    onChange={(e) => handleColorChange('dark', 'secondary', e.target.value)}
                    className="w-10 h-10 rounded-full border-2 border-[var(--color-secondary)] cursor-pointer flex-shrink-0"
                  />
                  <Input
                    value={localColors.dark?.secondary || '#FFFFFF'}
                    onChange={(e) => handleColorChange('dark', 'secondary', e.target.value)}
                    className="flex-1 font-mono text-sm min-w-0"
                    maxLength={7}
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm mb-2">Accent</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={localColors.dark?.accent || '#767676'}
                    onChange={(e) => handleColorChange('dark', 'accent', e.target.value)}
                    className="w-10 h-10 rounded-full border-2 border-[var(--color-secondary)] cursor-pointer flex-shrink-0"
                  />
                  <Input
                    value={localColors.dark?.accent || '#767676'}
                    onChange={(e) => handleColorChange('dark', 'accent', e.target.value)}
                    className="flex-1 font-mono text-sm min-w-0"
                    maxLength={7}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-3">
          <Button onClick={handleSaveColors} disabled={!hasUnsavedChanges}>
            <Save size={16} />
            Save & Apply
          </Button>
          <Button variant="outline" onClick={handleResetColors}>
            <RotateCcw size={16} />
            Reset to Default
          </Button>
        </div>
      </Card>

      {/* Haptic Feedback */}
      <Card>
        <h2 className="font-mono text-lg mb-4 flex items-center gap-2">
          <Vibrate size={20} />
          Haptic Feedback
        </h2>
        
        <div className="flex items-center justify-between">
          <div>
            <p className="font-mono">Enable Haptics</p>
            <p className="text-[var(--color-accent)] text-sm">
              Feel subtle vibrations on supported devices
            </p>
          </div>
          
          <button
            onClick={handleHapticToggle}
            className={`
              w-14 h-8 rounded-full border-2 border-[var(--color-secondary)]
              relative transition-all duration-200
              ${hapticEnabled ? 'bg-[var(--color-secondary)]' : ''}
            `}
          >
            <div className={`
              absolute top-0.5 w-6 h-6 rounded-full 
              transition-all duration-200
              ${hapticEnabled 
                ? 'right-0.5 bg-[var(--color-primary)]' 
                : 'left-0.5 bg-[var(--color-secondary)]'
              }
            `} />
          </button>
        </div>

        {hapticEnabled && (
          <div className="mt-4 pt-4 border-t-2 border-[var(--color-secondary)]/10 animate-slide-down">
            <p className="text-sm text-[var(--color-accent)] mb-3">Test haptic feedback:</p>
            <div className="flex gap-2">
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => haptic('light')}
              >
                Light
              </Button>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => haptic('medium')}
              >
                Medium
              </Button>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => haptic('heavy')}
              >
                Heavy
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Live Preview */}
      <Card>
        <h2 className="font-mono text-lg mb-4">Live Preview</h2>
        
        <div 
          className="p-6 rounded-2xl border-2"
          style={{
            backgroundColor: localColors.light?.primary || '#FFFFFF',
            borderColor: localColors.light?.secondary || '#000000',
            color: localColors.light?.secondary || '#000000',
          }}
        >
          <p className="font-mono mb-2">Light Mode Preview</p>
          <p style={{ color: localColors.light?.accent || '#767676' }} className="text-sm">
            This is how your accent text will look
          </p>
          <button
            className="mt-3 px-4 py-2 rounded-full font-mono text-sm"
            style={{
              backgroundColor: localColors.light?.secondary || '#000000',
              color: localColors.light?.primary || '#FFFFFF',
            }}
          >
            Sample Button
          </button>
        </div>

        <div 
          className="p-6 rounded-2xl border-2 mt-4"
          style={{
            backgroundColor: localColors.dark?.primary || '#000000',
            borderColor: localColors.dark?.secondary || '#FFFFFF',
            color: localColors.dark?.secondary || '#FFFFFF',
          }}
        >
          <p className="font-mono mb-2">Dark Mode Preview</p>
          <p style={{ color: localColors.dark?.accent || '#767676' }} className="text-sm">
            This is how your accent text will look
          </p>
          <button
            className="mt-3 px-4 py-2 rounded-full font-mono text-sm"
            style={{
              backgroundColor: localColors.dark?.secondary || '#FFFFFF',
              color: localColors.dark?.primary || '#000000',
            }}
          >
            Sample Button
          </button>
        </div>
      </Card>
    </div>
  );
}
