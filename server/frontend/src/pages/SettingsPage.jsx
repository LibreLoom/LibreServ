import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "../hooks/useAuth";
import { useTheme } from "../hooks/useTheme";
import LoadingSpinner from "../components/common/LoadingSpinner";
import ErrorDisplay from "../components/common/ErrorDisplay";
import SettingsSidebar from "../components/settings/SettingsSidebar";
import SettingsContent from "../components/settings/SettingsContent";
import { getSettings, updateSettings } from "../lib/settings-api.js";
import {
  getSecuritySettings,
  updateSecuritySettings,
  sendTestNotification,
} from "../lib/security-api.js";
import { goeyToast } from "goey-toast";
import { ArrowLeft } from "lucide-react";

const DEBOUNCE_MS = 500;

export default function SettingsPage() {
  const { me: user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const darkMode = theme === "dark";
  const [settings, setSettings] = useState(null);
  const [securitySettings, setSecuritySettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeCategory, setActiveCategory] = useState(() => {
    const hash = window.location.hash.slice(1);
    const validCategories = ["general", "appearance", "backups", "security", "about"];
    return validCategories.includes(hash) ? hash : "general";
  });
  const [showMobileContent, setShowMobileContent] = useState(false);

  const saveTimeoutRef = useRef(null);
  const pendingSettingsRef = useRef(null);
  const pendingSecurityRef = useRef(null);

  useEffect(() => {
    loadData();
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    window.history.replaceState(null, "", `#${activeCategory}`);
  }, [activeCategory]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [settingsData, securityData] = await Promise.all([
        getSettings(),
        getSecuritySettings(),
      ]);
      setSettings(settingsData);
      setSecuritySettings(securityData);
    } catch (err) {
      const errorMessage =
        err?.message || err?.response?.data?.message || "Failed to load settings.";
      setError(errorMessage);
      console.error("Error loading settings:", err);
    } finally {
      setLoading(false);
    }
  };

  const performSave = useCallback(async () => {
    const promises = [];
    
    if (pendingSettingsRef.current) {
      promises.push(updateSettings(pendingSettingsRef.current));
      pendingSettingsRef.current = null;
    }
    
    if (pendingSecurityRef.current) {
      promises.push(updateSecuritySettings(pendingSecurityRef.current));
      pendingSecurityRef.current = null;
    }

    if (promises.length > 0) {
      try {
        await Promise.all(promises);
        goeyToast.success("Settings saved", {
          description: "Your changes have been applied.",
          timing: { displayDuration: 2500 },
        });
      } catch (err) {
        console.error("Error saving settings:", err);
        const errorMsg = typeof err?.message === "string" 
          ? err.message.split("\n")[0]
          : "Please try again.";
        goeyToast.error("Failed to save", {
          description: errorMsg,
        });
      }
    }
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(performSave, DEBOUNCE_MS);
  }, [performSave]);

  const handleLoggingChange = (level) => {
    setSettings((prev) => ({
      ...prev,
      logging: { ...prev?.logging, level },
    }));
    pendingSettingsRef.current = { logging: { level } };
    scheduleSave();
  };

  const handleDarkModeChange = () => {
    toggleTheme();
  };

  const handleSecuritySettingsChange = (newSettings) => {
    setSecuritySettings(newSettings);
    pendingSecurityRef.current = newSettings;
    scheduleSave();
  };

  const handleTestNotification = async () => {
    return sendTestNotification();
  };

  const handleCategoryChange = (category) => {
    setActiveCategory(category);
    setShowMobileContent(true);
  };

  const handleBackToSidebar = () => {
    setShowMobileContent(false);
  };

  if (loading) {
    return (
      <main className="bg-primary text-secondary px-4 pt-5 pb-32 min-h-screen">
        <div className="flex justify-center items-center mt-12">
          <LoadingSpinner size="lg" />
        </div>
      </main>
    );
  }

  return (
    <main className="bg-primary text-secondary min-h-screen">
      {error && (
        <div className="px-4 pt-4">
          <ErrorDisplay error={error} />
        </div>
      )}

      <div className="hidden md:flex md:gap-6 md:p-6 md:pt-8 pb-32">
        <div className="w-[20%] min-w-[200px] max-w-[280px] flex-shrink-0">
          <SettingsSidebar
            user={user}
            activeCategory={activeCategory}
            onCategoryChange={setActiveCategory}
            className="sticky top-6"
          />
        </div>
        <div className="flex-1 max-w-3xl animate-in fade-in slide-in-from-right-2 duration-300">
          <SettingsContent
            category={activeCategory}
            settings={settings}
            darkMode={darkMode}
            onDarkModeChange={handleDarkModeChange}
            securitySettings={securitySettings}
            onSecuritySettingsChange={handleSecuritySettingsChange}
            onTestNotification={handleTestNotification}
            onLoggingChange={handleLoggingChange}
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
          <div className="p-4 pt-6 pb-32 animate-in fade-in slide-in-from-right-4 duration-300">
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
              darkMode={darkMode}
              onDarkModeChange={handleDarkModeChange}
              securitySettings={securitySettings}
              onSecuritySettingsChange={handleSecuritySettingsChange}
              onTestNotification={handleTestNotification}
              onLoggingChange={handleLoggingChange}
            />
          </div>
        )}
      </div>
    </main>
  );
}