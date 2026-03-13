import { useState } from "react";
import { Palette, Moon, Sun, RotateCcw, Check } from "lucide-react";
import SettingsRow from "../SettingsRow";

function ColorInput({ label, value, onChange, description }) {
  const [inputValue, setInputValue] = useState(value || "#000000");
  const [isValid, setIsValid] = useState(true);

  const validateHex = (hex) => /^#[0-9A-Fa-f]{6}$/.test(hex);

  const handleChange = (e) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    if (validateHex(newValue)) {
      setIsValid(true);
      onChange(newValue);
    } else {
      setIsValid(false);
    }
  };

  const handleColorPickerChange = (e) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    setIsValid(true);
    onChange(newValue);
  };

  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex-1 min-w-0 pr-4">
        <div className="font-medium text-primary text-sm">{label}</div>
        {description && (
          <div className="text-xs text-accent mt-0.5">{description}</div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value || "#000000"}
          onChange={handleColorPickerChange}
          className="w-8 h-8 rounded-lg cursor-pointer border border-primary/20 bg-transparent"
          aria-label={`Choose ${label} color`}
        />
        <input
          type="text"
          value={inputValue}
          onChange={handleChange}
          placeholder="#000000"
className={`w-24 px-2 py-1 text-sm font-mono rounded-lg bg-primary/10 border ${
             isValid ? "border-primary/20" : "border-error"
           } text-primary focus-visible:ring-2 focus:ring-accent`}
          aria-label={`${label} hex value`}
        />
      </div>
    </div>
  );
}

function ColorPreset({ colors, label, currentColors, onSelect }) {
  const isMatch =
    currentColors?.primary === colors.primary &&
    currentColors?.secondary === colors.secondary &&
    currentColors?.accent === colors.accent;

  return (
    <button
      onClick={() => onSelect(colors)}
      className={`flex flex-col items-center gap-1 p-2 rounded-large-element border transition-all duration-200 ${
        isMatch
          ? "border-accent bg-accent/10"
          : "border-primary/10 hover:border-primary/30 hover:bg-primary/5"
      }`}
      aria-label={`Apply ${label} preset`}
      aria-pressed={isMatch}
    >
      <div className="flex gap-1">
        <div className="w-4 h-4 rounded-full border border-primary" style={{ backgroundColor: colors.primary }} aria-hidden="true" />
        <div className="w-4 h-4 rounded-full border border-primary" style={{ backgroundColor: colors.secondary }} aria-hidden="true" />
        <div className="w-4 h-4 rounded-full border border-primary" style={{ backgroundColor: colors.accent }} aria-hidden="true" />
      </div>
      <span className="text-xs text-accent">{label}</span>
    </button>
  );
}

function getLuminance(hex) {
  const rgb = parseInt(hex.slice(1), 16);
  const r = ((rgb >> 16) & 0xff) / 255;
  const g = ((rgb >> 8) & 0xff) / 255;
  const b = (rgb & 0xff) / 255;
  const toLinear = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function getContrastRatio(hex1, hex2) {
  const l1 = getLuminance(hex1);
  const l2 = getLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function createValidatedPresets() {
  const presets = [
    { label: "Classic", colors: { primary: "#ffffff", secondary: "#000000", accent: "#767676" } },
    { label: "Ocean", colors: { primary: "#cce7f5", secondary: "#0c4a6e", accent: "#1888b8" } },
    { label: "Forest", colors: { primary: "#dcfce7", secondary: "#14532d", accent: "#15803d" } },
    { label: "Sunset", colors: { primary: "#ffedd5", secondary: "#5c1d0a", accent: "#c45635" } },
    { label: "Lavender", colors: { primary: "#e9d5fa", secondary: "#4a148c", accent: "#9b4dca" } },
    { label: "Midnight", colors: { primary: "#e2e8f0", secondary: "#0f172a", accent: "#0ea5e9" } },
  ];

  const MIN_CONTRAST = 12;

  return presets.map((preset) => {
    const contrastPrimary = getContrastRatio(preset.colors.primary, preset.colors.accent);
    const contrastSecondary = getContrastRatio(preset.colors.secondary, preset.colors.accent);
    const isCompliant = contrastPrimary >= MIN_CONTRAST && contrastSecondary >= MIN_CONTRAST;
    return { 
      ...preset, 
      contrastPrimary: contrastPrimary.toFixed(2), 
      contrastSecondary: contrastSecondary.toFixed(2),
      isCompliant 
    };
  });
}

const COLOR_PRESETS = createValidatedPresets();

export default function AppearanceCategory({
  darkMode,
  onDarkModeChange,
  colors,
  setColors,
  darkColors,
  setDarkColors,
  useSeparateDarkColors,
  setUseSeparateDarkColors,
  resetColors,
  isCustomTheme,
}) {
  const [showCustomColors, setShowCustomColors] = useState(isCustomTheme);

  const handleColorChange = (key, value) => {
    setColors({ ...colors, [key]: value });
  };

  const handleDarkColorChange = (key, value) => {
    setDarkColors({ ...darkColors, [key]: value });
  };

  const handlePresetSelect = (presetColors) => {
    setColors(presetColors);
    setShowCustomColors(true);
  };

  const handleReset = () => {
    resetColors();
    setShowCustomColors(false);
  };

  const handleToggleCustomColors = () => {
    if (showCustomColors && isCustomTheme) {
      handleReset();
    } else {
      setShowCustomColors(!showCustomColors);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-secondary rounded-large-element overflow-hidden transition-all duration-300 ease-in-out animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/10">
          <Palette size={18} className="text-accent" />
          <h2 className="font-mono font-normal text-primary">Theme</h2>
        </div>
        <SettingsRow label="Dark Mode" description="Use dark theme for the interface">
          <button
onClick={onDarkModeChange}
             className={`relative inline-flex h-7 w-12 items-center rounded-pill transition-all duration-300 ease-out focus-visible:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-secondary ${
               darkMode ? "bg-accent" : "bg-primary/20"
             }`}
            role="switch"
            aria-checked={darkMode}
            aria-label="Toggle dark mode"
          >
            <span
              className={`inline-flex items-center justify-center h-5 w-5 rounded-full bg-primary transition-all duration-300 ease-out ${
                darkMode ? "translate-x-6" : "translate-x-1"
              }`}
            >
              {darkMode ? <Moon size={12} className="text-accent" /> : <Sun size={12} className="text-accent" />}
            </span>
          </button>
        </SettingsRow>
      </div>

      <div className="bg-secondary rounded-large-element overflow-hidden transition-all duration-300 ease-in-out animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/10">
          <div className="flex items-center gap-2">
            <Palette size={18} className="text-accent" />
            <h2 className="font-mono font-normal text-primary">Custom Colors</h2>
          </div>
        </div>
        <div className="px-4 pt-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-primary">Enable Custom Colors</div>
              <div className="text-sm text-accent mt-0.5 mb-3">Customize the primary, secondary, and accent colors</div>
            </div>
            <button
onClick={handleToggleCustomColors}
               className={`relative inline-flex h-7 w-12 items-center rounded-pill transition-all duration-300 ease-out focus-visible:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-secondary ${
                 showCustomColors ? "bg-accent" : "bg-primary/20"
               }`}
              role="switch"
              aria-checked={showCustomColors}
              aria-label="Enable custom colors"
            >
              <span
                className={`inline-flex items-center justify-center h-5 w-5 transform rounded-full bg-primary transition-all duration-300 ease-out ${
                  showCustomColors ? "translate-x-6" : "translate-x-1"
                }`}
              >
                {showCustomColors ? <Check size={12} className="text-accent" /> : <Palette size={12} className="text-accent" />}
              </span>
            </button>
          </div>

            <div
              className={`overflow-hidden transition-all duration-300 ease-in-out ${
                showCustomColors ? "max-h-[2000px] opacity-100 mt-4 pb-4" : "max-h-0 opacity-0"
              }`}
            >
              <div className="pt-4 border-t border-primary/10 pb-4">
                <div className="text-xs font-medium text-accent uppercase tracking-wider mb-2">Color Presets</div>
                <div className="grid grid-cols-3 gap-2">
                  {COLOR_PRESETS.map((preset) => (
                    <ColorPreset
                      key={preset.label}
                      label={preset.label}
                      colors={preset.colors}
                      currentColors={colors}
                      onSelect={handlePresetSelect}
                    />
                  ))}
                </div>
              </div>

              <div className="space-y-2 pt-4 border-t border-primary/10 pb-4">
              <div className="text-xs font-medium text-accent uppercase tracking-wider mb-3">
                {darkMode ? "Dark Mode Colors" : "Light Mode Colors"}
              </div>
              <ColorInput
                label="Primary"
                description="Main background color"
                value={colors?.primary || "#ffffff"}
                onChange={(v) => handleColorChange("primary", v)}
              />
              <ColorInput
                label="Secondary"
                description="Main text and elements"
                value={colors?.secondary || "#000000"}
                onChange={(v) => handleColorChange("secondary", v)}
              />
              <ColorInput
                label="Accent"
                description="Highlights and emphasis"
                value={colors?.accent || "#767676"}
                onChange={(v) => handleColorChange("accent", v)}
              />
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between mb-3 pr-1">
                <div>
                  <div className="font-medium text-primary text-sm">Separate Dark Mode Colors</div>
                  <div className="text-xs text-accent mt-0.5">Use different colors when dark mode is active</div>
                </div>
                <button
                  onClick={() => setUseSeparateDarkColors(!useSeparateDarkColors)}
className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-pill transition-all duration-300 ease-out focus-visible:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-secondary ${
                     useSeparateDarkColors ? "bg-accent" : "bg-primary/20"
                   }`}
                  role="switch"
                  aria-checked={useSeparateDarkColors}
                  aria-label="Use separate dark mode colors"
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-primary transition-all duration-300 ease-out ${
                      useSeparateDarkColors ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>

              <div
                className={`overflow-hidden transition-all duration-300 ease-in-out ${
                  useSeparateDarkColors ? "max-h-[500px] opacity-100 pb-4" : "max-h-0 opacity-0"
                }`}
              >
                <div className="pt-4 border-t border-primary/10">
                  <div className="text-xs font-medium text-accent uppercase tracking-wider mb-3">
                    {darkMode ? "Dark Mode Colors (Active)" : "Dark Mode Colors"}
                  </div>
                  <ColorInput
                    label="Primary (Dark)"
                    description="Background in dark mode"
                    value={darkColors?.primary || "#000000"}
                    onChange={(v) => handleDarkColorChange("primary", v)}
                  />
                  <ColorInput
                    label="Secondary (Dark)"
                    description="Text in dark mode"
                    value={darkColors?.secondary || "#ffffff"}
                    onChange={(v) => handleDarkColorChange("secondary", v)}
                  />
                  <ColorInput
                    label="Accent (Dark)"
                    description="Highlights in dark mode"
                    value={darkColors?.accent || "#767676"}
                    onChange={(v) => handleDarkColorChange("accent", v)}
                  />
                </div>
              </div>
            </div>

            <div className="mt-4 pt-4 border-t border-primary/10">
              <button
                onClick={handleReset}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-pill bg-primary/10 text-primary hover:bg-primary/20 transition-all text-sm"
                aria-label="Reset colors to default"
              >
                <RotateCcw size={14} />
                <span>Reset to Default</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
