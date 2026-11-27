import { cn } from "@libreloom/ui/lib/utils.js";
import { useState } from "react";
import {
  Palette,
  Moon,
  Sun,
  Monitor,
  RotateCcw,
  Check,
  Lightbulb,
  Vibrate,
} from "lucide-react";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import SlideCollapse from "@libreloom/ui/components/common/SlideCollapse.jsx";
import Toggle from "@libreloom/ui/components/common/Toggle.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import SettingsRow from "@libreloom/ui/components/settings/SettingsRow.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { useTheme } from "@libreloom/ui/hooks/useTheme.jsx";
import {
  useHapticsEnabled,
  setHapticsEnabled,
  haptic,
} from "@libreloom/ui/utils/haptics.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import {
  restoreDismissedTips,
  setTipsEnabled,
  useTipState,
} from "../../../lib/tips.js";

const THEME_OPTIONS = [
  { value: "system", icon: Monitor, label: "System" },
  { value: "light", icon: Sun, label: "Light" },
  { value: "dark", icon: Moon, label: "Dark" },
];

/* color-scan: ignore-file custom theme color picker UI — hex values are the data */
const HEX = /^#[0-9A-Fa-f]{6}$/;

function getLuminance(hex) {
  const rgb = parseInt(hex.slice(1), 16);
  const toLinear = (c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const r = toLinear(((rgb >> 16) & 0xff) / 255);
  const g = toLinear(((rgb >> 8) & 0xff) / 255);
  const b = toLinear((rgb & 0xff) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function getContrastRatio(hex1, hex2) {
  const l1 = getLuminance(hex1);
  const l2 = getLuminance(hex2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const LIGHT_DEFAULTS = {
  primary: "#ffffff",
  secondary: "#000000",
  accent: "#767676",
};
const DARK_DEFAULTS = {
  primary: "#000000",
  secondary: "#ffffff",
  accent: "#767676",
};

const PRESETS = [
  {
    label: "Ocean",
    colors: { primary: "#cce7f5", secondary: "#0c4a6e", accent: "#1888b8" },
  },
  {
    label: "Forest",
    colors: { primary: "#dcfce7", secondary: "#14532d", accent: "#15803d" },
  },
  {
    label: "Sunset",
    colors: { primary: "#ffedd5", secondary: "#5c1d0a", accent: "#c45635" },
  },
  {
    label: "Lavender",
    colors: { primary: "#e9d5fa", secondary: "#4a148c", accent: "#c061cb" },
  },
  {
    label: "Midnight",
    colors: { primary: "#e2e8f0", secondary: "#0f172a", accent: "#0ea5e9" },
  },
  {
    label: "Muted",
    colors: { primary: "#f5f5f5", secondary: "#1a1a1a", accent: "#686868" },
  },
  {
    label: "Soft dark",
    colors: { primary: "#dddddd", secondary: "#000000", accent: "#686868" },
  },
];

const sameColors = (a, b) =>
  a?.primary === b.primary &&
  a?.secondary === b.secondary &&
  a?.accent === b.accent;

/** A selectable palette: three overlapping dots plus its name. */
function PaletteChip({ label, dots, selected, onSelect, ariaLabel }) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic("selection");
        onSelect();
      }}
      aria-label={ariaLabel}
      aria-pressed={selected}
      className={cn(
        "inline-flex items-center rounded-pill border-2 py-1.5 pl-2 pr-3 text-sm",
        "gap-2 motion-safe:transition-[color,border-color,scale] motion-safe:duration-200 active:motion-safe:scale-95",
        "no-focus-outline focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
        selected
          ? "border-accent"
          : "border-primary/10 hover:border-primary/30",
      )}
    >
      <span className="flex -space-x-2" aria-hidden="true">
        {dots.map((color, i) => (
          <span
            key={i}
            className="h-5 w-5 rounded-full border border-secondary/30"
            style={{ backgroundColor: color }}
          />
        ))}
      </span>
      <span>{label}</span>
      {/* The check grows the pill's width instead of popping in, so it fits
          snugly and the pills beside it glide aside. */}
      <SlideCollapse show={selected} gap="0.5rem">
        <Check size={ICON_SIZE.xs} aria-hidden="true" className="block" />
      </SlideCollapse>
    </button>
  );
}

/** One color: round swatch (opens the picker), its name, and a hex field. */
function ColorSwatch({ label, value, onChange }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  const valid = HEX.test(draft);

  return (
    <div className="flex min-w-0 flex-col items-center gap-2">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`Choose ${label} color`}
        // The browser paints a square swatch inside the input; round the swatch itself.
        className={cn(
          "h-14 w-14 shrink-0 cursor-pointer appearance-none overflow-hidden rounded-full border-2 border-secondary/20 bg-transparent p-0",
          "[&::-webkit-color-swatch-wrapper]:p-0",
          "[&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-0",
          "[&::-moz-color-swatch]:rounded-full [&::-moz-color-swatch]:border-0",
        )}
      />
      <span className="text-sm">{label}</span>
      <input
        type="text"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (HEX.test(e.target.value)) onChange(e.target.value);
        }}
        placeholder="#000000"
        aria-label={`${label} hex value`}
        className={cn(
          "w-full min-w-0 max-w-[7rem] rounded-pill border-2 surface-secondary px-3 py-1 text-center text-sm font-mono outline-none focus:border-accent",
          valid ? "border-secondary/20" : "border-error",
        )}
      />
    </div>
  );
}

export default function AppearanceCategory() {
  const {
    theme,
    setTheme,
    resolvedTheme,
    colors,
    setColors,
    darkColors,
    setDarkColors,
    useSeparateDarkColors,
    setUseSeparateDarkColors,
    resetColors,
    isCustomTheme,
  } = useTheme();
  const hapticsEnabled = useHapticsEnabled();
  const tips = useTipState();

  const darkMode = resolvedTheme === "dark";
  // You edit the palette of the mode you are looking at.
  const editingDark = darkMode && useSeparateDarkColors;
  const palette = editingDark
    ? darkColors || DARK_DEFAULTS
    : isCustomTheme
      ? colors
      : LIGHT_DEFAULTS;
  const save = editingDark ? setDarkColors : setColors;

  // Without separate dark colors, dark mode swaps background and text.
  const flip = darkMode && !useSeparateDarkColors;
  const dotsFor = (c) =>
    flip
      ? [c.secondary, c.primary, c.accent]
      : [c.primary, c.secondary, c.accent];

  const matchesPreset = PRESETS.some((p) => sameColors(palette, p.colors));
  const readable = getContrastRatio(palette.primary, palette.secondary) >= 4.5;

  return (
    <div className="space-y-4" data-slot="appearance-category">
      <SettingsCard icon={Palette} title="Theme" padding={false} index={0}>
        <SettingsRow
          label="Color scheme"
          description="Choose light, dark, or your device's setting."
          stack
        >
          <SegmentedControl
            options={THEME_OPTIONS}
            value={theme}
            onChange={setTheme}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard icon={Palette} title="Colors" padding={false} index={1}>
        <div className="flex flex-col gap-4 p-4">
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Color presets"
          >
            <PaletteChip
              label="Default"
              ariaLabel="Use the default colors"
              dots={dotsFor(darkMode && !flip ? DARK_DEFAULTS : LIGHT_DEFAULTS)}
              selected={!isCustomTheme}
              onSelect={resetColors}
            />
            {PRESETS.map((preset) => (
              <PaletteChip
                key={preset.label}
                label={preset.label}
                ariaLabel={`Apply ${preset.label} preset`}
                dots={dotsFor(preset.colors)}
                selected={isCustomTheme && sameColors(palette, preset.colors)}
                onSelect={() => save(preset.colors)}
              />
            ))}
            <PaletteChip
              label="Custom"
              ariaLabel="Make your own colors"
              dots={dotsFor(palette)}
              selected={isCustomTheme && !matchesPreset}
              onSelect={() => save(palette)}
            />
          </div>

          <SlideCollapse show={isCustomTheme} axis="y" gap="1rem">
            <div className="space-y-3 rounded-large-element surface-primary p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  {editingDark ? "Dark mode colors" : "Light mode colors"}
                </div>
                {!readable && (
                  <Pill variant="warning">
                    Text is hard to read on this background
                  </Pill>
                )}
              </div>
              <div className="grid grid-cols-3 gap-3">
                <ColorSwatch
                  label="Background"
                  value={palette.primary}
                  onChange={(v) => save({ ...palette, primary: v })}
                />
                <ColorSwatch
                  label="Text"
                  value={palette.secondary}
                  onChange={(v) => save({ ...palette, secondary: v })}
                />
                <ColorSwatch
                  label="Accent"
                  value={palette.accent}
                  onChange={(v) => save({ ...palette, accent: v })}
                />
              </div>
            </div>
          </SlideCollapse>
        </div>

        <SlideCollapse show={isCustomTheme} axis="y" gap="0rem">
          <SettingsRow
            label="Dark mode colors"
            description={
              useSeparateDarkColors
                ? "Switch to dark mode above to choose its colors."
                : "Flipped swaps background and text."
            }
            hideDivider
            stack
          >
            <SegmentedControl
              aria-label="Dark mode colors"
              options={[
                { value: "flipped", label: "Flipped" },
                { value: "separate", label: "Separate" },
              ]}
              value={useSeparateDarkColors ? "separate" : "flipped"}
              onChange={(v) => setUseSeparateDarkColors(v === "separate")}
            />
          </SettingsRow>
        </SlideCollapse>
      </SettingsCard>

      {/* Existing Luna vibration preference — Toggle matches shared primitives */}
      <SettingsCard icon={Vibrate} title="Haptics" padding={false} index={2}>
        <div className="px-4 py-4">
          <Toggle
            checked={hapticsEnabled}
            onChange={setHapticsEnabled}
            label="Vibration feedback"
            description="Feel a short buzz when you press buttons and flip switches. Only works on phones and other devices that can vibrate."
            iconOn={Check}
            iconOff={Vibrate}
          />
        </div>
      </SettingsCard>

      <SettingsCard icon={Lightbulb} title="Tips" padding={false} index={3}>
        <div className="px-4 py-4 space-y-4">
          <Toggle
            checked={tips.enabled}
            onChange={setTipsEnabled}
            label="Show tips on Home"
            description="Now and then, a short tip about using Luna appears at the top of Home."
            iconOn={Check}
            iconOff={Lightbulb}
          />
          {tips.dismissed.length > 0 ? (
            <Button
              variant="primary"
              surface="secondary"
              size="sm"
              onClick={restoreDismissedTips}
            >
              <RotateCcw size={ICON_SIZE.sm} />
              <span>Show hidden tips again</span>
            </Button>
          ) : null}
        </div>
      </SettingsCard>
    </div>
  );
}
