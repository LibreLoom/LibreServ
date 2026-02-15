import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import PropTypes from "prop-types";
import HeaderCard from "../components/common/cards/HeaderCard";
import Card from "../components/common/cards/Card";
import LoadingSpinner from "../components/common/LoadingSpinner";
import ErrorDisplay from "../components/common/ErrorDisplay";
import {
  getSecuritySettings,
  updateSecuritySettings,
  sendTestNotification,
} from "../lib/security-api.js";
import { Bell, Shield, Mail, Check, AlertCircle, ArrowLeft } from "lucide-react";

export default function SecurityPage() {
  const navigate = useNavigate();
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [testResult, setTestResult] = useState(null);

  const successTimeoutRef = useRef(null);
  const testResultTimeoutRef = useRef(null);

  useEffect(() => {
    loadSettings();

    return () => {
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
      if (testResultTimeoutRef.current) {
        clearTimeout(testResultTimeoutRef.current);
      }
    };
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getSecuritySettings();
      setSettings(data);
    } catch (err) {
      const errorMessage = err?.message || err?.response?.data?.message || "Failed to load security settings. Please try again.";
      setError(errorMessage);
      console.error("Error loading security settings:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = (key) => {
    setSettings((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleFrequencyChange = (frequency) => {
    setSettings((prev) => ({
      ...prev,
      notification_frequency: frequency,
    }));
  };

  const handleSave = async () => {
    if (successTimeoutRef.current) {
      clearTimeout(successTimeoutRef.current);
    }

    try {
      setSaving(true);
      setError(null);
      setSuccessMessage(null);
      await updateSecuritySettings(settings);
      setSuccessMessage("Security settings saved successfully!");
      successTimeoutRef.current = setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      const errorMessage = err?.message || err?.response?.data?.message || "Failed to save settings. Please try again.";
      setError(errorMessage);
      console.error("Error saving security settings:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleTestNotification = async () => {
    if (testResultTimeoutRef.current) {
      clearTimeout(testResultTimeoutRef.current);
    }

    try {
      setTesting(true);
      setError(null);
      setTestResult(null);
      const result = await sendTestNotification();
      setTestResult({
        success: true,
        message: result?.message || "Test notification sent! Check your email.",
      });
      testResultTimeoutRef.current = setTimeout(() => setTestResult(null), 5000);
    } catch (err) {
      const errorMessage = err?.message || err?.response?.data?.message || "Failed to send test notification. Please check your email settings.";
      setTestResult({
        success: false,
        message: errorMessage,
      });
      console.error("Error sending test notification:", err);
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <main
        className="bg-primary text-secondary px-8 pt-5 pb-32"
        aria-labelledby="security-title"
        id="main-content"
        tabIndex={-1}
      >
        <HeaderCard
          id="security-title"
          title="Security"
          leftContent={
            <button
              type="button"
              onClick={() => navigate("/settings")}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm text-accent hover:text-secondary transition-colors rounded-lg hover:bg-secondary/10"
              aria-label="Back to settings"
            >
              <ArrowLeft size={18} aria-hidden="true" />
              <span className="hidden sm:inline">Back</span>
            </button>
          }
        />
        <div className="flex justify-center items-center mt-12">
          <LoadingSpinner size="lg" />
        </div>
      </main>
    );
  }

  return (
    <main
      className="bg-primary text-secondary px-8 pt-5 pb-32"
      aria-labelledby="security-title"
      id="main-content"
      tabIndex={-1}
    >
      <HeaderCard
        id="security-title"
        title="Security"
        subtitle="Manage your security settings and notifications"
        leftContent={
          <button
            type="button"
            onClick={() => navigate("/settings")}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm text-accent hover:text-secondary transition-colors rounded-lg hover:bg-secondary/10"
            aria-label="Back to settings"
          >
            <ArrowLeft size={18} aria-hidden="true" />
            <span className="hidden sm:inline">Back</span>
          </button>
        }
      />

      {error && (
        <div className="mt-6">
          <ErrorDisplay error={error} />
        </div>
      )}

      {successMessage && (
        <div className="mt-6 p-4 bg-secondary/10 border border-secondary/30 rounded-lg flex items-center gap-2 text-secondary">
          <Check size={20} />
          <span>{successMessage}</span>
        </div>
      )}

      {testResult && (
        <div
          className={`mt-6 p-4 rounded-lg flex items-center gap-2 ${
            testResult.success
              ? "bg-secondary/10 border border-secondary/30 text-secondary"
              : "bg-error/10 border border-error/20 text-error"
          }`}
        >
          {testResult.success ? <Check size={20} /> : <AlertCircle size={20} />}
          <span>{testResult.message}</span>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Security Notifications" icon={<Bell size={20} />}>
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">Enable Notifications</h3>
                <p className="text-sm text-accent mt-1">
                  Receive email alerts about security events
                </p>
              </div>
              <button
                onClick={() => handleToggle("notifications_enabled")}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 ${
                  settings?.notifications_enabled
                    ? "bg-accent"
                    : "bg-secondary/20"
                }`}
                role="switch"
                aria-checked={settings?.notifications_enabled}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-primary transition-transform ${
                    settings?.notifications_enabled
                      ? "translate-x-6"
                      : "translate-x-1"
                  }`}
                />
              </button>
            </div>

            {settings?.notifications_enabled && (
              <>
                <div className="border-t pt-4">
                  <h3 className="font-medium mb-3">Notification Frequency</h3>
                  <div className="space-y-2">
                    {[
                      {
                        value: "instant",
                        label: "Instant",
                        description: "Send emails immediately as events occur",
                      },
                      {
                        value: "normal",
                        label: "Normal",
                        description: "Batch non-critical events, instant for critical",
                      },
                      {
                        value: "digest",
                        label: "Daily Digest",
                        description: "Send a daily summary of all events",
                      },
                    ].map((option) => (
                      <label
                        key={option.value}
                        className="flex items-start gap-3 p-3 rounded-lg border border-secondary/20 cursor-pointer hover:bg-secondary/10"
                      >
                        <input
                          type="radio"
                          name="frequency"
                          value={option.value}
                          checked={
                            settings?.notification_frequency === option.value
                          }
                          onChange={() => handleFrequencyChange(option.value)}
                          className="mt-1"
                        />
                        <div>
                          <div className="font-medium text-primary">{option.label}</div>
                          <div className="text-sm text-accent">
                            {option.description}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="border-t pt-4">
                  <h3 className="font-medium mb-3">Notify Me About</h3>
                  <div className="space-y-3">
                    {[
                      {
                        key: "notify_on_login",
                        label: "Successful logins",
                        description: "When someone logs in to your account",
                      },
                      {
                        key: "notify_on_failed_login",
                        label: "Failed login attempts",
                        description: "When someone tries to access your account",
                      },
                      {
                        key: "notify_on_password_change",
                        label: "Password changes",
                        description: "When your password is changed",
                      },
                      {
                        key: "notify_on_admin_action",
                        label: "Admin actions",
                        description: "When settings or apps are modified",
                      },
                    ].map((item) => (
                      <label
                        key={item.key}
                        className="flex items-start gap-3 p-3 rounded-lg border border-secondary/20 cursor-pointer hover:bg-secondary/10"
                      >
                        <input
                          type="checkbox"
                          checked={settings?.[item.key]}
                          onChange={() => handleToggle(item.key)}
                          className="mt-1 rounded border-secondary/30"
                        />
                        <div>
                          <div className="font-medium text-primary">{item.label}</div>
                          <div className="text-sm text-accent">
                            {item.description}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </Card>

        <Card title="Account Security" icon={<Shield size={20} />}>
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">Account Lockout</h3>
                <p className="text-sm text-accent mt-1">
                  Temporarily lock accounts after 5 failed login attempts
                </p>
              </div>
              <div className="flex items-center gap-2 text-secondary">
                <Check size={18} />
                <span className="text-sm font-medium">Enabled</span>
              </div>
            </div>

            <div className="border-t pt-4">
              <h3 className="font-medium mb-2">Password Requirements</h3>
              <ul className="text-sm text-accent space-y-1">
                <li className="flex items-center gap-2">
                  <Check size={14} />
                  Minimum 12 characters
                </li>
                <li className="flex items-center gap-2">
                  <Check size={14} />
                  Must include letters and numbers
                </li>
              </ul>
            </div>

            <div className="border-t pt-4">
              <h3 className="font-medium mb-2">Email Configuration</h3>
              <p className="text-sm text-accent mb-3">
                Security notifications are sent to your account email address.
                Make sure your email settings are configured correctly.
              </p>
              <button
                onClick={handleTestNotification}
                disabled={testing || !settings?.notifications_enabled}
                className="inline-flex items-center gap-2 px-4 py-2 bg-secondary text-primary rounded-lg hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Mail size={18} />
                {testing ? "Sending..." : "Send Test Notification"}
              </button>
            </div>
          </div>
        </Card>
      </div>

      <div className="mt-6 flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 px-6 py-3 bg-secondary text-primary font-medium rounded-lg hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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

SecurityPage.propTypes = {};
