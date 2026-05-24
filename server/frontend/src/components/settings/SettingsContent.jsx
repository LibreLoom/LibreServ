import GeneralCategory from "./categories/GeneralCategory.jsx";
import AppearanceCategory from "./categories/AppearanceCategory.jsx";
import SecurityCategory from "./categories/SecurityCategory.jsx";
import AboutCategory from "./categories/AboutCategory.jsx";
import BackupsCategory from "./categories/BackupsCategory.jsx";
import NetworkCategory from "./categories/NetworkCategory.jsx";
import NotificationsCategory from "./categories/NotificationsCategory.jsx";
import AISupportCategory from "./categories/AISupportCategory.jsx";
import SaveStatusIndicator from "../common/SaveStatusIndicator.jsx";

const CATEGORY_TITLES = {
	general: "General Settings",
	appearance: "Appearance",
	backups: "Backups",
	ai_support: "AI Support",
	security: "Security",
	network: "Network",
	notifications: "Notifications",
	about: "About",
};

const CATEGORY_COMPONENTS = {
	general: GeneralCategory,
	appearance: AppearanceCategory,
	backups: BackupsCategory,
	ai_support: AISupportCategory,
	security: SecurityCategory,
	network: NetworkCategory,
	notifications: NotificationsCategory,
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
  notificationsSettings,
  onNotificationsSettingsChange,
  onTestNotification,
  onLoggingChange,
  updateSettings,
  onUpdateSettingsChange,
  aiSettings,
  onAISettingsChange,
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
          updateSettings,
          onUpdateSettingsChange,
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
      case "ai_support":
        return {
          settings: { ai_support: aiSettings },
          onSettingsChange: onAISettingsChange,
        };
      case "security":
        return {
          settings: securitySettings,
          onSettingsChange: onSecuritySettingsChange,
          onTestNotification,
        };
      case "network":
        return { settings };
      case "notifications":
        return {
          settings: notificationsSettings,
          onSettingsChange: onNotificationsSettingsChange,
        };
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
