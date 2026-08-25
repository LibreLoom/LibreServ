import { Palette } from "lucide-react";
import Button from "../../ui/Button";
import SettingsCard from "../SettingsCard";
import SettingsRow from "../SettingsRow";
import { useTheme } from "../../../context/ThemeContext";
import { useHapticsEnabled, setHapticsEnabled } from "../../../utils/haptics";

const THEME_OPTIONS = [
  { value: "system", label: "Match device" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export default function AppearanceCategory() {
  const { theme, setTheme } = useTheme();
  const hapticsOn = useHapticsEnabled();

  return (
    <SettingsCard icon={Palette} title="Look and feel" padding={false}>
      <SettingsRow
        label="Screen"
        description="Light, dark, or match this device."
        stack
      >
        <div className="flex flex-wrap gap-2">
          {THEME_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              size="sm"
              variant={theme === opt.value ? "primary" : "outline"}
              onClick={() => setTheme(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </SettingsRow>
      <SettingsRow
        label="Vibration"
        description="A short buzz when you tap buttons. Optional."
        hideDivider
      >
        <Button
          size="sm"
          variant={hapticsOn ? "primary" : "outline"}
          className={hapticsOn ? "border-2 border-transparent" : "border-2"}
          onClick={() => setHapticsEnabled(!hapticsOn)}
        >
          {hapticsOn ? "Vibration on" : "Vibration off"}
        </Button>
      </SettingsRow>
    </SettingsCard>
  );
}
