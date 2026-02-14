import React, { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { Link } from "react-router-dom";
import HeaderCard from "../components/common/cards/HeaderCard";
import Card from "../components/common/cards/Card";
import LoadingSpinner from "../components/common/LoadingSpinner";
import ErrorDisplay from "../components/common/ErrorDisplay";
import { getSettings, updateSettings } from "../lib/settings-api.js";
import { Settings, Server, FileText, Palette, Check, AlertCircle, ChevronRight, Shield, Globe } from "lucide-react";

export default function SettingsPage() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [logLevel, setLogLevel] = useState("info");

  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem("theme");
    if (saved) return saved === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  const successTimeoutRef = useRef(null);

  useEffect(() => {
    loadSettings();

    return () => {
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }, [darkMode]);

  const loadSettings = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getSettings();
      setSettings(data);
      if (data?.logging?.level) {
        setLogLevel(data.logging.level);
      }
    } catch (err) {
      const errorMessage = err?.message || err?.response?.data?.message || "Failed to load settings. Please try again.";
      setError(errorMessage);
      console.error("Error loading settings:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleLogLevelChange = (level) => {
    setLogLevel(level);
  };

  const handleDarkModeToggle = () => {
    setDarkMode((prev) => !prev);
  };

  const handleSave = async () => {
    if (successTimeoutRef.current) {
      clearTimeout(successTimeoutRef.current);
    }

    try {
      setSaving(true);
      setError(null);
      setSuccessMessage(null);
      await updateSettings({
        logging: {
          level: logLevel,
        },
      });
      setSuccessMessage("Settings saved successfully!");
      successTimeoutRef.current = setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      const errorMessage = err?.message || err?.response?.data?.message || "Failed to save settings. Please try again.";
      setError(errorMessage);
      console.error("Error saving settings:", err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <main
        className="bg-primary text-secondary px-8 pt-5 pb-32"
        aria-labelledby="settings-title"
        id="main-content"
        tabIndex={-1}
      >
        <HeaderCard id="settings-title" title="Settings" />
        <div className="flex justify-center items-center mt-12">
          <LoadingSpinner size="lg" />
        </div>
      </main>
    );
  }

  return (
    <main
      className="bg-primary text-secondary px-8 pt-5 pb-32"
      aria-labelledby="settings-title"
      id="main-content"
      tabIndex={-1}
    >
      <HeaderCard
        id="settings-title"
        title="Settings"
        subtitle="Manage your application settings and preferences"
      />

      {error && (
        <div className="mt-6">
          <ErrorDisplay error={error} />
        </div>
      )}

      {successMessage && (
        <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg flex items-center gap-2 text-green-700">
          <Check size={20} />
          <span>{successMessage}</span>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Server size={20} className="text-accent" />
            <h2 className="font-medium">Backend API</h2>
          </div>
          <div className="space-y-4">
            <div className="flex items-center justify-between py-2 border-b border-secondary/20">
              <span className="text-accent">Host</span>
              <span className="font-medium">{settings?.backend?.host || "N/A"}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-secondary/20">
              <span className="text-accent">Port</span>
              <span className="font-medium">{settings?.backend?.port || "N/A"}</span>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-accent">Mode</span>
              <span className="font-medium">
                <span
                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    settings?.backend?.mode === "production"
                      ? "bg-green-100 text-green-800"
                      : "bg-yellow-100 text-yellow-800"
                  }`}
                >
                  {settings?.backend?.mode || "N/A"}
                </span>
              </span>
            </div>
          </div>
        </Card>

        {settings?.proxy && (
          <Card>
            <div className="flex items-center gap-2 mb-4">
              <Globe size={20} className="text-accent" />
              <h2 className="font-medium">Reverse Proxy</h2>
            </div>
            <div className="space-y-4">
              <div className="flex items-center justify-between py-2 border-b border-secondary/20">
                <span className="text-accent">Type</span>
                <span className="font-medium">{settings?.proxy?.type || "N/A"}</span>
              </div>
              {settings?.proxy?.mode && (
                <div className="flex items-center justify-between py-2 border-b border-secondary/20">
                  <span className="text-accent">Mode</span>
                  <span className="font-medium">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        settings?.proxy?.mode === "production"
                          ? "bg-green-100 text-green-800"
                          : "bg-yellow-100 text-yellow-800"
                      }`}
                    >
                      {settings?.proxy?.mode}
                    </span>
                  </span>
                </div>
              )}
              {settings?.proxy?.admin_api && (
                <div className="flex items-center justify-between py-2 border-b border-secondary/20">
                  <span className="text-accent">Admin API</span>
                  <span className="font-medium font-mono text-sm">{settings?.proxy?.admin_api}</span>
                </div>
              )}
              {settings?.proxy?.default_domain && (
                <div className="flex items-center justify-between py-2 border-b border-secondary/20">
                  <span className="text-accent">Default Domain</span>
                  <span className="font-medium">{settings?.proxy?.default_domain}</span>
                </div>
              )}
              <div className="flex items-center justify-between py-2">
                <span className="text-accent">Auto HTTPS</span>
                <span className="font-medium">
                  <span
                    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      settings?.proxy?.auto_https
                        ? "bg-green-100 text-green-800"
                        : "bg-gray-100 text-gray-800"
                    }`}
                  >
                    {settings?.proxy?.auto_https ? "true" : "false"}
                  </span>
                </span>
              </div>
            </div>
          </Card>
        )}

        <Card>
          <div className="flex items-center gap-2 mb-4">
            <FileText size={20} className="text-accent" />
            <h2 className="font-medium">Logging Configuration</h2>
          </div>
          <div className="space-y-6">
            <div>
              <label htmlFor="log-level" className="block font-medium mb-2">
                Log Level
              </label>
              <select
                id="log-level"
                value={logLevel}
                onChange={(e) => handleLogLevelChange(e.target.value)}
                className="w-full px-3 py-2 border border-secondary/30 rounded-lg bg-primary text-secondary focus:outline-none focus:ring-2 focus:ring-blue-500"
                aria-label="Select log level"
              >
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>

            <div className="border-t border-secondary/20 pt-4">
              <span className="text-accent text-sm">Log Path</span>
              <p className="font-mono text-sm mt-1 bg-secondary/10 px-3 py-2 rounded">
                {settings?.logging?.path || "N/A"}
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Palette size={20} className="text-accent" />
            <h2 className="font-medium">Appearance</h2>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-medium">Dark Mode</h3>
              <p className="text-sm text-accent mt-1">
                Use dark theme for the interface
              </p>
            </div>
            <button
              onClick={handleDarkModeToggle}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                darkMode ? "bg-blue-600" : "bg-gray-200"
              }`}
              role="switch"
              aria-checked={darkMode}
              aria-label="Toggle dark mode"
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  darkMode ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Settings size={20} className="text-accent" />
            <h2 className="font-medium">Quick Links</h2>
          </div>
          <div className="space-y-2">
            <Link
              to="/settings/security"
              className="flex items-center justify-between p-3 rounded-lg border border-secondary/20 hover:bg-secondary/10 transition-colors"
              aria-label="Go to security settings"
            >
              <div className="flex items-center gap-3">
                <Shield size={18} className="text-accent" />
                <div>
                  <div className="font-medium">Security Settings</div>
                  <div className="text-sm text-accent">
                    Manage security and notification preferences
                  </div>
                </div>
              </div>
              <ChevronRight size={18} className="text-accent" />
            </Link>
          </div>
        </Card>
      </div>

      <div className="mt-6 flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? (
            <>
              <LoadingSpinner size="sm" />
              Saving...
            </>
          ) : (
            "Save Settings"
          )}
        </button>
      </div>
    </main>
  );
}

SettingsPage.propTypes = {};
