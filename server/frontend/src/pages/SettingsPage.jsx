import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "../hooks/useAuth";
import { useTheme } from "../hooks/useTheme";
import ErrorDisplay from "../components/common/ErrorDisplay";
import Page from "../components/ui/Page";
import Button from "../components/ui/Button";
import SettingsSidebar from "../components/settings/SettingsSidebar";
import SettingsContent from "../components/settings/SettingsContent";
import { visibleCategories } from "../components/settings/settingsCategories";
import { getSettings, updateSettings } from "../lib/settings-api.js";
import {
  getSecuritySettings,
  updateSecuritySettings,
  sendTestNotification,
} from "../lib/security-api.js";
import {
  getNotifications,
  updateNotifications,
} from "../lib/notifications-api.js";
import {
  getConnectStatus,
  activateConnect,
  deactivateConnect,
} from "../lib/connect-api.js";
import { ArrowLeft } from "lucide-react";
import NotificationsCategory from "../components/settings/categories/NotificationsCategory";

const DEBOUNCE_MS = 500;

export default function SettingsPage() {
  const { me: user, csrfToken } = useAuth();
  const isAdmin = user?.role === "admin";
  const allowedCategoryIds = visibleCategories(isAdmin).map((c) => c.id);
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
  const [notificationsSettings, setNotificationsSettings] = useState(null);
  const [connectStatus, setConnectStatus] = useState(null);
  const [connectLoading, setConnectLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeCategory, setActiveCategory] = useState(() => {
    const hash = window.location.hash.slice(1);
    if (allowedCategoryIds.includes(hash)) return hash;
    // Admins default to General; users (who can't see it) default to Appearance.
    return isAdmin ? "general" : "appearance";
  });
  const [showMobileContent, setShowMobileContent] = useState(false);
  const [saveStatus, setSaveStatus] = useState("idle");

  const saveTimeoutRef = useRef(null);
  const pendingSettingsRef = useRef(null);
  const pendingSecurityRef = useRef(null);


  const loadData = useCallback(async () => {
    // The settings/security/notifications endpoints are admin-only; a regular
    // user only uses the client-side Appearance and read-only About sections,
    // so skip these calls instead of triggering permission errors.
    if (!isAdmin) return;
    try {
      setError(null);
      const [settingsData, securityData, notificationsData, connectData] = await Promise.all([
        getSettings(),
        getSecuritySettings(),
        getNotifications(),
        getConnectStatus().catch(() => null),
      ]);
      setSettings(settingsData);
      setSecuritySettings(securityData);
      setNotificationsSettings(notificationsData);
      setConnectStatus(connectData);
      if (securityData && typeof securityData.use_12_hour_time === "boolean") {
        setUse12HourTime(securityData.use_12_hour_time);
      }
    } catch (err) {
      const errorMessage =
        err?.message || err?.response?.data?.message || "Failed to load settings.";
      setError(errorMessage);
      console.error("Error loading settings:", err);
    }
  }, [setUse12HourTime, isAdmin]);

  useEffect(() => {
    loadData();
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [loadData]);

  useEffect(() => {
    window.history.replaceState(null, "", `#${activeCategory}`);
  }, [activeCategory]);

  const handleTestNotification = async () => {
    return sendTestNotification(csrfToken);
  };

  const performSave = useCallback(async () => {
    const pendingSettings = pendingSettingsRef.current;
    const pendingSecurity = pendingSecurityRef.current;
    const promises = [];
    
    if (pendingSettings) {
      if (pendingSettings.smtp || pendingSettings.notify) {
        promises.push(updateNotifications(pendingSettings, csrfToken));
      } else {
        promises.push(updateSettings(pendingSettings, csrfToken));
      }
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

        if (pendingSettings && (pendingSettings.smtp || pendingSettings.notify)) {
          const notificationsData = await getNotifications();
          setNotificationsSettings(notificationsData);
        }

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

  const handleNotificationsSettingsChange = (newSettings) => {
    setNotificationsSettings(newSettings);
    pendingSettingsRef.current = newSettings;
    setSaveStatus("unsaved");
    scheduleSave();
  };

  const handleUpdateSettingsChange = (partial) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const newUpdates = { ...prev?.updates, ...partial };
      pendingSettingsRef.current = { updates: newUpdates };
      return { ...prev, updates: newUpdates };
    });
    setSaveStatus("unsaved");
    scheduleSave();
  };

  const handleActivateConnect = async (token) => {
    setConnectLoading(true);
    try {
      const result = await activateConnect(token, csrfToken);
      setConnectStatus(result);
      return result;
    } catch (err) {
      console.error("Failed to activate Connect:", err);
      throw err;
    } finally {
      setConnectLoading(false);
    }
  };

  const handleDeactivateConnect = async () => {
    setConnectLoading(true);
    try {
      await deactivateConnect(csrfToken);
      setConnectStatus({ connected: false, services: {} });
    } catch (err) {
      console.error("Failed to deactivate Connect:", err);
    } finally {
      setConnectLoading(false);
    }
  };

  const handleOpenPlanPage = () => {
    window.open("https://connect.serv.libreloom.org", "_blank");
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
    <Page
      padded={false}
      className="h-[100dvh] flex flex-col overflow-hidden pt-0 pb-0"
      data-slot="settings"
    >
      {error && (
        <div className="px-8 pt-5">
          <ErrorDisplay message={error} onDismiss={() => setError(null)} />
          <Button
            variant="outline"
            surface="primary"
            size="sm"
            onClick={loadData}
            className="mt-2 font-mono"
          >
            Retry
          </Button>
        </div>
      )}

      {/* Desktop: two-column fixed frame.
          The page never scrolls — only the content panel does.
          min-h-0 is the flexbox incantation that lets overflow-y-auto work
          inside a flex child (without it the child won't shrink below its
          content size and overflow is ignored). */}
      <div className="hidden md:flex flex-1 gap-6 px-8 pt-5 overflow-hidden min-h-0">
        {/* Sidebar — fixed frame, scrolls only if categories overflow */}
        <div className="w-[28%] min-w-[260px] max-w-[360px] flex-shrink-0 overflow-y-auto pb-24">
          <SettingsSidebar
            user={user}
            activeCategory={activeCategory}
            onCategoryChange={setActiveCategory}
          />
        </div>
        {/* Content — the only thing that scrolls */}
        <div className="flex-1 overflow-y-auto min-h-0 pl-10 pr-4 pb-24 animate-in fade-in slide-in-from-right-2 duration-300">
          <SettingsContent
            category={activeCategory}
            settings={settings}
            theme={theme}
            onThemeChange={handleThemeChange}
            resolvedTheme={resolvedTheme}
            securitySettings={securitySettings}
            onSecuritySettingsChange={handleSecuritySettingsChange}
            notificationsSettings={notificationsSettings}
            onNotificationsSettingsChange={handleNotificationsSettingsChange}
            onTestNotification={handleTestNotification}
            updateSettings={settings?.updates}
            onUpdateSettingsChange={handleUpdateSettingsChange}
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
            connectStatus={connectStatus}
            onActivateConnect={handleActivateConnect}
            onDeactivateConnect={handleDeactivateConnect}
            onOpenPlanPage={handleOpenPlanPage}
            connectLoading={connectLoading}
            csrfToken={csrfToken}
          />
        </div>
      </div>

      {/* Mobile: single scroll container, page never scrolls */}
      <div className="md:hidden flex-1 overflow-y-auto min-h-0">
        {!showMobileContent ? (
          <div className="p-4 pt-6 pb-24">
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
          <div className="p-4 pt-6 pb-24 animate-in fade-in slide-in-from-right-4 duration-300">
            <Button
              variant="ghost"
              surface="primary"
              size="sm"
              onClick={handleBackToSidebar}
              className="mb-4 -ml-3"
            >
              <ArrowLeft size={18} />
              <span>Back</span>
            </Button>
            <SettingsContent
              category={activeCategory}
              settings={settings}
              theme={theme}
              onThemeChange={handleThemeChange}
              resolvedTheme={resolvedTheme}
              securitySettings={securitySettings}
              onSecuritySettingsChange={handleSecuritySettingsChange}
              notificationsSettings={notificationsSettings}
              onNotificationsSettingsChange={handleNotificationsSettingsChange}
              onTestNotification={handleTestNotification}
              updateSettings={settings?.updates}
              onUpdateSettingsChange={handleUpdateSettingsChange}
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
              connectStatus={connectStatus}
              onActivateConnect={handleActivateConnect}
              onDeactivateConnect={handleDeactivateConnect}
              onOpenPlanPage={handleOpenPlanPage}
              connectLoading={connectLoading}
              csrfToken={csrfToken}
            />
          </div>
        )}
      </div>
    </Page>
  );
}
