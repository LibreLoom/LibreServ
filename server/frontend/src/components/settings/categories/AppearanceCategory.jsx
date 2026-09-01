import { cn } from "@/lib/utils";
import { useState, useRef } from "react";
import { Palette, Moon, Sun, Monitor, RotateCcw, Check, Vibrate } from "lucide-react";
import Toggle from "../../common/Toggle";
import SegmentedControl from "../../common/SegmentedControl";
import SettingsRow from "../SettingsRow";
import SettingsCard from "../SettingsCard";
import Button from "../../ui/Button";
import { useHapticsEnabled, setHapticsEnabled, haptic } from "../../../utils/haptics";

const THEME_OPTIONS = [
  { value: "system", icon: Monitor, label: "System" },
  { value: "light", icon: Sun, label: "Light" },
  { value: "dark", icon: Moon, label: "Dark" },
];

/* color-scan: ignore-file custom theme color picker UI — hex values are the data */
function ColorInput({ label, value, onChange, description }) {
  const [inputValue, setInputValue] = useState(value || "#000000");
  const [isValid, setIsValid] = useState(true);
  const lastExternalValue = useRef(value);

  if (value !== lastExternalValue.current) {
    lastExternalValue.current = value;
    setInputValue(value || "#000000");
    setIsValid(true);
  }

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
          // The browser paints the swatch as a square inside the input, so a
          // rounded input alone leaves the corners poking out. Round the swatch
          // itself (and drop its default padding/border) to match.
          className={cn(
            "w-8 h-8 p-0 rounded-full cursor-pointer border border-primary/20 bg-transparent appearance-none overflow-hidden",
            "[&::-webkit-color-swatch-wrapper]:p-0",
            "[&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-full",
            "[&::-moz-color-swatch]:border-0 [&::-moz-color-swatch]:rounded-full",
          )}
          aria-label={`Choose ${label} color`}
        />
        <input
          type="text"
          value={inputValue}
          onChange={handleChange}
          placeholder="#000000"
          className={cn("w-24 px-2 py-1 text-sm font-mono rounded-pill bg-primary/10 border-2 text-primary outline-none focus:border-accent", isValid && "border-primary/20", !isValid && "border-error")}
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
      type="button"
      onClick={() => {
        haptic("selection");
        onSelect(colors);
      }}
      aria-label={`Apply ${label} preset`}
      aria-pressed={isMatch}
      className={cn(
        "group relative flex flex-col items-center gap-2 p-2 pt-3 rounded-large-element border-2 text-center",
        "motion-safe:transition-all motion-safe:duration-200 motion-safe:ease-out",
        "no-focus-outline focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
        "hover:-translate-y-0.5 active:motion-safe:scale-95",
        isMatch
          ? "border-accent bg-accent/10"
          : "border-primary/10 hover:border-primary/30 hover:bg-primary/5"
      )}
      style={{ transitionDuration: "var(--motion-duration-short2)" }}
    >
      {/* Mini theme preview — layered: preset.primary surface, preset.secondary
          text bars, preset.accent pill, so the theme reads at a glance. */}
      <div
        className="w-full rounded-large-element px-2.5 py-2 border motion-safe:transition-transform motion-safe:duration-200 group-hover:scale-[1.02]"
        style={{
          backgroundColor: colors.primary,
          borderColor: `${colors.secondary}33`,
        }}
        aria-hidden="true"
      >
        <div className="flex items-center gap-1.5 mb-1.5">
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: colors.secondary }}
          />
          <div
            className="h-1.5 rounded-full flex-1 opacity-40"
            style={{ backgroundColor: colors.secondary }}
          />
        </div>
        <div
          className="h-1 rounded-full mb-1 opacity-30"
          style={{ backgroundColor: colors.secondary }}
        />
        <div
          className="h-1 rounded-full mb-1.5 w-3/4 opacity-30"
          style={{ backgroundColor: colors.secondary }}
        />
        <div
          className="w-8 h-3 rounded-pill"
          style={{ backgroundColor: colors.accent }}
        />
      </div>

      <span
        className={cn(
          "text-xs font-mono",
          isMatch ? "text-primary" : "text-accent"
        )}
      >
        {label}
      </span>

      {isMatch && (
        <span
          className="absolute -top-1.5 right-1.5 z-10 w-5 h-5 rounded-full bg-accent flex items-center justify-center animate-in fade-in zoom-in-75 duration-150"
          aria-hidden="true"
        >
          <Check size={12} className="text-primary" strokeWidth={3} />
        </span>
      )}
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
    { label: "Lavender", colors: { primary: "#e9d5fa", secondary: "#4a148c", accent: "#c061cb" } },
    { label: "Midnight", colors: { primary: "#e2e8f0", secondary: "#0f172a", accent: "#0ea5e9" } },
    { label: "Muted", colors: { primary: "#f5f5f5", secondary: "#1a1a1a", accent: "#686868" } },
    { label: "Soft Dark", colors: { primary: "#dddddd", secondary: "#000000", accent: "#686868" } },
    { label: "Soft Light", colors: { primary: "#f5f5f5", secondary: "#1a1a1a", accent: "#808080" } },
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
  theme,
  onThemeChange,
  resolvedTheme,
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
  const hapticsEnabled = useHapticsEnabled();

  const darkMode = resolvedTheme === "dark";

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
    <div className="space-y-4" data-slot="appearance-category">
      <SettingsCard icon={Palette} title="Theme" padding={false} index={0}>
        <SettingsRow label="Color Scheme" description="Choose light, dark, or follow system preference" stack>
          <SegmentedControl
            options={THEME_OPTIONS}
            value={theme}
            onChange={onThemeChange}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard icon={Palette} title="Custom Colors" padding={false} index={1}>
        <div className={cn("px-4 pt-4", showCustomColors ? "" : "pb-4")}>
          <Toggle
            checked={showCustomColors}
            onChange={handleToggleCustomColors}
            label="Enable Custom Colors"
            description="Customize the primary, secondary, and accent colors"
            iconOn={Check}
            iconOff={Palette}
          />

          <div
            className={cn("overflow-hidden transition-all ease-[var(--motion-easing-emphasized)]", showCustomColors ? "max-h-[100dvh] opacity-100 mt-4 pb-4" : "max-h-0 opacity-0")}
            style={{ transitionDuration: "var(--motion-duration-medium2)" }}
          >
            <div className="pt-4 border-t border-primary/10 pb-4">
              <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent mb-3">Color Presets</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
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
              <Toggle
                checked={useSeparateDarkColors}
                onChange={() => setUseSeparateDarkColors(!useSeparateDarkColors)}
                label="Separate Dark Mode Colors"
                description="Use different colors when dark mode is active"
              />

              <div
                className={cn("overflow-hidden transition-all ease-[var(--motion-easing-emphasized)]", useSeparateDarkColors ? "max-h-96 opacity-100 pb-4 mt-4" : "max-h-0 opacity-0")}
                style={{ transitionDuration: "var(--motion-duration-medium2)" }}
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
              <Button
                variant="ghost"
                surface="secondary"
                size="sm"
                onClick={handleReset}
                aria-label="Reset colors to default"
              >
                <RotateCcw size={14} />
                <span>Reset to Default</span>
              </Button>
            </div>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard icon={Vibrate} title="Haptics" padding={false} index={2}>
        <div className="px-4 py-4">
          <Toggle
            checked={hapticsEnabled}
            onChange={setHapticsEnabled}
            label="Vibration Feedback"
            description="Feel a short buzz when you press buttons and flip switches. Only works on phones and other devices that can vibrate."
            iconOn={Check}
            iconOff={Vibrate}
          />
        </div>
      </SettingsCard>
    </div>
  );
}
