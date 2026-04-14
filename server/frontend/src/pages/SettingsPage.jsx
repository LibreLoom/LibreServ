import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "../hooks/useAuth";
import { useTheme } from "../hooks/useTheme";
import ErrorDisplay from "../components/common/ErrorDisplay";
import SettingsSidebar from "../components/settings/SettingsSidebar";
import SettingsContent from "../components/settings/SettingsContent";
import { getSettings, updateSettings } from "../lib/settings-api.js";
import {
  getSecuritySettings,
  updateSecuritySettings,
  sendTestNotification,
} from "../lib/security-api.js";
import { ArrowLeft } from "lucide-react";

const DEBOUNCE_MS = 500;

export default function SettingsPage() {
  const { me: user, csrfToken } = useAuth();
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
    use12HourTime,
    setUse12HourTime,
  } = useTheme();
  const [settings, setSettings] = useState(null);
  const [securitySettings, setSecuritySettings] = useState(null);
  const [error, setError] = useState(null);
  const [activeCategory, setActiveCategory] = useState(() => {
    const hash = window.location.hash.slice(1);
    const validCategories = ["general", "appearance", "backups", "security", "network", "about"];
    return validCategories.includes(hash) ? hash : "general";
  });
  const [showMobileContent, setShowMobileContent] = useState(false);
  const [saveStatus, setSaveStatus] = useState("idle");

  const saveTimeoutRef = useRef(null);
  const pendingSettingsRef = useRef(null);
  const pendingSecurityRef = useRef(null);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [settingsData, securityData] = await Promise.all([
        getSettings(),
        getSecuritySettings(),
      ]);
      setSettings(settingsData);
      setSecuritySettings(securityData);
      if (securityData && typeof securityData.use_12_hour_time === "boolean") {
        setUse12HourTime(securityData.use_12_hour_time);
      }
    } catch (err) {
      const errorMessage =
        err?.message || err?.response?.data?.message || "Failed to load settings.";
      setError(errorMessage);
      console.error("Error loading settings:", err);
    }
  }, [setUse12HourTime]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData();
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [loadData]);

  useEffect(() => {
    window.history.replaceState(null, "", `#${activeCategory}`);
  }, [activeCategory]);

  const performSave = useCallback(async () => {
    const pendingSettings = pendingSettingsRef.current;
    const pendingSecurity = pendingSecurityRef.current;
    const promises = [];
    
    if (pendingSettings) {
      promises.push(updateSettings(pendingSettings, csrfToken));
    }
    
    if (pendingSecurity) {
      promises.push(updateSecuritySettings(pendingSecurity, csrfToken));
    }

    if (promises.length > 0) {
      setSaveStatus("saving");
      try {
        await Promise.all(promises);
        pendingSettingsRef.current = null;
        pendingSecurityRef.current = null;
        setSaveStatus("saved");
      } catch (err) {
        console.error("Error saving settings:", err);
        setSaveStatus("error");
      }
    }
  }, [csrfToken]);

  const scheduleSave = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(performSave, DEBOUNCE_MS);
  }, [performSave]);

  const handleLoggingChange = (level) => {
    setSettings((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        logging: { ...prev?.logging, level },
      };
    });
    pendingSettingsRef.current = { logging: { level } };
    setSaveStatus("unsaved");
    scheduleSave();
  };

  const handleThemeChange = (value) => {
    setTheme(value);
  };

  const handle12HourTimeChange = (value) => {
    setUse12HourTime(value);
    if (securitySettings) {
      const updated = { ...securitySettings, use_12_hour_time: value };
      handleSecuritySettingsChange(updated);
    }
  };

  const handleSecuritySettingsChange = (newSettings) => {
    setSecuritySettings(newSettings);
    pendingSecurityRef.current = newSettings;
    setSaveStatus("unsaved");
    scheduleSave();
  };

  const handleTestNotification = async () => {
    return sendTestNotification(csrfToken);
  };

  const handleRetrySave = () => {
    performSave();
  };

  const handleSavedComplete = () => {
    setSaveStatus("idle");
  };

  const handleCategoryChange = (category) => {
    setActiveCategory(category);
    setShowMobileContent(true);
  };

  const handleBackToSidebar = () => {
    setShowMobileContent(false);
  };

  return (
    <main className="bg-primary text-secondary min-h-screen">
      {error && (
        <div className="px-4 pt-4">
          <ErrorDisplay message={error} onDismiss={() => setError(null)} />
          <button
            onClick={loadData}
            className="mt-2 px-4 py-2 text-sm font-mono rounded-pill border-2 border-secondary text-secondary hover:bg-secondary hover:text-primary motion-safe:transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      <div className="hidden md:flex md:gap-6 md:p-6 md:pt-8 pb-20 h-[calc(100vh-4rem)] overflow-hidden">
        <div className="w-[28%] min-w-[260px] max-w-[360px] flex-shrink-0">
          <SettingsSidebar
            user={user}
            activeCategory={activeCategory}
            onCategoryChange={setActiveCategory}
          />
        </div>
        <div className="flex-1 overflow-y-auto pl-10 pr-12 animate-in fade-in slide-in-from-right-2 duration-300">
          <SettingsContent
            category={activeCategory}
            settings={settings}
            theme={theme}
            onThemeChange={handleThemeChange}
            resolvedTheme={resolvedTheme}
            securitySettings={securitySettings}
            onSecuritySettingsChange={handleSecuritySettingsChange}
            onTestNotification={handleTestNotification}
            onLoggingChange={handleLoggingChange}
            colors={colors}
            setColors={setColors}
            darkColors={darkColors}
            setDarkColors={setDarkColors}
            useSeparateDarkColors={useSeparateDarkColors}
            setUseSeparateDarkColors={setUseSeparateDarkColors}
            resetColors={resetColors}
            isCustomTheme={isCustomTheme}
            use12HourTime={use12HourTime}
            on12HourTimeChange={handle12HourTimeChange}
            saveStatus={saveStatus}
            onRetrySave={handleRetrySave}
            onSavedComplete={handleSavedComplete}
          />
        </div>
      </div>

      <div className="md:hidden">
        {!showMobileContent ? (
          <div className="p-4 pt-6">
            <h1 className="text-xl font-mono font-normal text-secondary mb-4 animate-in fade-in duration-200">
              Settings
            </h1>
            <SettingsSidebar
              user={user}
              activeCategory={activeCategory}
              onCategoryChange={handleCategoryChange}
            />
          </div>
        ) : (
          <div className="p-4 pt-6 pb-20 animate-in fade-in slide-in-from-right-4 duration-300">
            <button
              onClick={handleBackToSidebar}
              className="flex items-center gap-2 px-3 py-1.5 mb-4 -ml-3 text-accent hover:text-secondary transition-colors duration-200 rounded-pill"
            >
              <ArrowLeft size={18} />
              <span>Back</span>
            </button>
            <SettingsContent
              category={activeCategory}
              settings={settings}
              theme={theme}
              onThemeChange={handleThemeChange}
              resolvedTheme={resolvedTheme}
              securitySettings={securitySettings}
              onSecuritySettingsChange={handleSecuritySettingsChange}
              onTestNotification={handleTestNotification}
              onLoggingChange={handleLoggingChange}
              colors={colors}
              setColors={setColors}
              darkColors={darkColors}
              setDarkColors={setDarkColors}
              useSeparateDarkColors={useSeparateDarkColors}
              setUseSeparateDarkColors={setUseSeparateDarkColors}
              resetColors={resetColors}
              isCustomTheme={isCustomTheme}
              use12HourTime={use12HourTime}
              on12HourTimeChange={handle12HourTimeChange}
              saveStatus={saveStatus}
              onRetrySave={handleRetrySave}
              onSavedComplete={handleSavedComplete}
            />
          </div>
        )}
      </div>
    </main>
  );
}