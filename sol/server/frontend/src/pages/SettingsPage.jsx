import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useTheme } from "../hooks/useTheme";
import ErrorDisplay from "../components/common/ErrorDisplay";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Button from "../components/ui/Button";
import SettingsSidebar from "../components/settings/SettingsSidebar";
import SettingsContent from "../components/settings/SettingsContent";
import { visibleCategories } from "../components/settings/settingsCategories";
import { getSettings, updateSettings } from "../lib/settings-api.js";
import { useToast } from "../context/ToastContext";
import {
  getSecuritySettings,
  updateSecuritySettings,
  sendTestNotification,
} from "../lib/security-api.js";
import { ICON_SIZE } from "@/lib/ui-tokens";
import {
  getNotifications,
  updateNotifications,
} from "../lib/notifications-api.js";
import {
  getConnectStatus,
  activateConnect,
  deactivateConnect,
  getConnectInfo,
} from "../lib/connect-api.js";
import { ArrowLeft } from "lucide-react";
import NotificationsCategory from "../components/settings/categories/NotificationsCategory";

const DEBOUNCE_MS = 500;

/** Category id from `#security` or `#external_services-tunnel`. */
function categoryFromHash(hash, allowedCategoryIds) {
  const raw = String(hash || "").replace(/^#/, "");
  const [catId] = raw.split("-");
  return allowedCategoryIds.includes(catId) ? catId : null;
}

export default function SettingsPage() {
  const { me: user, csrfToken } = useAuth();
  const { addToast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";
  const allowedCategoryIds = useMemo(
    () => visibleCategories(isAdmin).map((c) => c.id),
    [isAdmin]
  );
  const defaultCategory = isAdmin ? "general" : "appearance";
  const hashCategory = categoryFromHash(location.hash, allowedCategoryIds);
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
  const [connectInfo, setConnectInfo] = useState(null);
  const [connectLoading, setConnectLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeCategory, setActiveCategory] = useState(
    () => categoryFromHash(location.hash, allowedCategoryIds) || defaultCategory,
  );
  const [showMobileContent, setShowMobileContent] = useState(() => Boolean(hashCategory));
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
      const [settingsData, securityData, notificationsData, connectData, connectInfoData] = await Promise.all([
        getSettings(),
        getSecuritySettings(),
        getNotifications(),
        getConnectStatus().catch(() => null),
        getConnectInfo().catch(() => null),
      ]);
      setSettings(settingsData);
      setSecuritySettings(securityData);
      setNotificationsSettings(notificationsData);
      setConnectStatus(connectData);
      setConnectInfo(connectInfoData);
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

  // React Router Link updates location.hash via pushState — no hashchange —
  // and Settings stays mounted on the same pathname. Follow the router hash.
  useEffect(() => {
    if (!hashCategory) return;
    setActiveCategory(hashCategory);
    setShowMobileContent(true);
  }, [hashCategory]);

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

  const handleUpdateSourceSave = useCallback(async (updates) => {
    await updateSettings({ updates }, csrfToken);
    setSettings((prev) =>
      prev ? { ...prev, updates: { ...prev.updates, ...updates } } : prev
    );
    addToast({ type: "success", message: "Update source saved" });
  }, [csrfToken, addToast]);

  const handleActivateConnect = async (key) => {
    setConnectLoading(true);
    try {
      const result = await activateConnect(key, csrfToken);
      setConnectStatus(result);
      // Refresh plan catalog so any limit changes since the page loaded are reflected.
      getConnectInfo()
        .then((info) => setConnectInfo(info))
        .catch(() => null);

      // Poll for provisioning completion — the backend provisions
      // services in the background after returning the activation
      // response. Services start as "disabled" and flip to "connected"
      // as provisioning completes.
      const pollStatus = async () => {
        const deadline = Date.now() + 60000; // 60s timeout
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 3000));
          try {
            const status = await getConnectStatus();
            setConnectStatus(status);
            // Check if all services are no longer "disabled"
            const services = status?.services || {};
            const stillProvisioning = Object.values(services).some(
              s => s.state === "disabled"
            );
            if (!stillProvisioning) break;
          } catch {
            // Ignore poll errors — keep trying until deadline
          }
        }
      };
      pollStatus(); // Fire and forget — don't block the UI

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

  const handleRefreshConnectStatus = async () => {
    try {
      const [data, info] = await Promise.all([
        getConnectStatus(),
        getConnectInfo().catch(() => null),
      ]);
      setConnectStatus(data);
      if (info) setConnectInfo(info);
    } catch (err) {
      console.error("Failed to refresh Connect status:", err);
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
    const current = location.hash.replace(/^#/, "");
    if (current === category || current.split("-")[0] === category) return;
    navigate(
      { pathname: location.pathname, search: location.search, hash: category },
      { replace: true },
    );
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
          <Card>
            <ErrorDisplay message={error} onDismiss={() => setError(null)} />
            <Button
              variant="outline"
              surface="secondary"
              size="sm"
              onClick={loadData}
              className="mt-2 font-mono"
            >
              Retry
            </Button>
          </Card>
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
            onCategoryChange={handleCategoryChange}
          />
        </div>
        {/* Content — the only thing that scrolls */}
        <div className="flex-1 overflow-y-auto min-h-0 pl-10 pr-4 pb-24 animate-in fade-in slide-in-from-right-1 duration-150">
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
            connectInfo={connectInfo}
            onActivateConnect={handleActivateConnect}
            onDeactivateConnect={handleDeactivateConnect}
            onRefreshConnectStatus={handleRefreshConnectStatus}
            onOpenPlanPage={handleOpenPlanPage}
            connectLoading={connectLoading}
            onUpdateSourceSave={handleUpdateSourceSave}
            csrfToken={csrfToken}
          />
        </div>
      </div>

      {/* Mobile: single scroll container, page never scrolls */}
      <div className="md:hidden flex-1 overflow-y-auto min-h-0">
        {!showMobileContent ? (
          <div className="p-4 pt-6 pb-24">
            <h1 className="text-xl font-mono font-normal text-secondary mb-4 animate-in fade-in duration-150">
              Settings
            </h1>
            <SettingsSidebar
              user={user}
              activeCategory={activeCategory}
              onCategoryChange={handleCategoryChange}
            />
          </div>
        ) : (
          <div className="p-4 pt-6 pb-24 animate-in fade-in slide-in-from-right-2 duration-150">
            <Button
              variant="ghost"
              surface="primary"
              size="sm"
              onClick={handleBackToSidebar}
              className="mb-4 -ml-3"
            >
              <ArrowLeft size={ICON_SIZE.lg} />
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
              connectInfo={connectInfo}
              onActivateConnect={handleActivateConnect}
              onDeactivateConnect={handleDeactivateConnect}
              onRefreshConnectStatus={handleRefreshConnectStatus}
              onOpenPlanPage={handleOpenPlanPage}
              connectLoading={connectLoading}
              onUpdateSourceSave={handleUpdateSourceSave}
              csrfToken={csrfToken}
            />
          </div>
        )}
      </div>
    </Page>
  );
}
