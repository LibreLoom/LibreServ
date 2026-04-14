import GeneralCategory from "./categories/GeneralCategory";
import AppearanceCategory from "./categories/AppearanceCategory";
import SecurityCategory from "./categories/SecurityCategory";
import AboutCategory from "./categories/AboutCategory";
import BackupsCategory from "./categories/BackupsCategory";
import NetworkCategory from "./categories/NetworkCategory";
import SaveStatusIndicator from "../common/SaveStatusIndicator";

const CATEGORY_TITLES = {
	general: "General Settings",
	appearance: "Appearance",
	backups: "Backups",
	security: "Security",
	network: "Network",
	about: "About",
};

const CATEGORY_COMPONENTS = {
	general: GeneralCategory,
	appearance: AppearanceCategory,
	backups: BackupsCategory,
	security: SecurityCategory,
	network: NetworkCategory,
	about: AboutCategory,
};

export default function SettingsContent({
  category,
  settings,
  theme,
  onThemeChange,
  resolvedTheme,
  securitySettings,
  onSecuritySettingsChange,
  onTestNotification,
  onLoggingChange,
  colors,
  setColors,
  darkColors,
  setDarkColors,
  useSeparateDarkColors,
  setUseSeparateDarkColors,
  resetColors,
  isCustomTheme,
  use12HourTime,
  on12HourTimeChange,
  saveStatus = "idle",
  onRetrySave,
  onSavedComplete,
}) {
  const CategoryComponent = CATEGORY_COMPONENTS[category] || GeneralCategory;
  const title = CATEGORY_TITLES[category] || "Settings";

  const getSettingsProps = () => {
    switch (category) {
      case "general":
        return {
          settings: {
            ...settings,
            onLoggingChange,
          },
          use12HourTime,
          on12HourTimeChange,
        };
      case "appearance":
        return {
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
        };
      case "backups":
        return {};
      case "security":
        return {
          settings: securitySettings,
          onSettingsChange: onSecuritySettingsChange,
          onTestNotification,
        };
      case "network":
        return { settings };
      case "about":
        return { settings };
      default:
        return { settings };
    }
  };

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 bg-primary pt-1 flex items-center justify-between">
        <h1 className="text-2xl font-mono font-normal text-secondary animate-in fade-in slide-in-from-bottom-2 duration-300">
          {title}
        </h1>
        <SaveStatusIndicator
          status={saveStatus}
          onRetry={onRetrySave}
          onSavedComplete={onSavedComplete}
        />
      </div>
      <div key={category} className="animate-in fade-in duration-300 pb-16 md:pb-20">
        <CategoryComponent {...getSettingsProps()} />
      </div>
    </div>
  );
}
