import { useState, useRef } from "react";
import { Shield, Bell, Mail, Check, AlertCircle } from "lucide-react";
import SettingsRow from "../SettingsRow";

const FREQUENCY_OPTIONS = [
  { value: "instant", label: "Instant", description: "Send emails immediately" },
  { value: "normal", label: "Normal", description: "Batch non-critical, instant for critical" },
  { value: "digest", label: "Daily Digest", description: "Send daily summary" },
];

const NOTIFICATION_OPTIONS = [
  { key: "notify_on_login", label: "Successful logins", description: "When someone logs in" },
  { key: "notify_on_failed_login", label: "Failed login attempts", description: "When access is attempted" },
  { key: "notify_on_password_change", label: "Password changes", description: "When password is changed" },
  { key: "notify_on_admin_action", label: "Admin actions", description: "When settings or apps are modified" },
];

export default function SecurityCategory({ settings, onSettingsChange, onTestNotification }) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const testTimeoutRef = useRef(null);

  const handleToggle = (key) => {
    onSettingsChange?.({ ...settings, [key]: !settings[key] });
  };

  const handleFrequencyChange = (frequency) => {
    onSettingsChange?.({ ...settings, notification_frequency: frequency });
  };

  const handleTestNotification = async () => {
    if (testTimeoutRef.current) clearTimeout(testTimeoutRef.current);
    
    try {
      setTesting(true);
      setTestResult(null);
      await onTestNotification?.();
      setTestResult({ success: true, message: "Test notification sent!" });
    } catch (err) {
      setTestResult({ success: false, message: err?.message || "Failed to send test" });
    } finally {
      setTesting(false);
      testTimeoutRef.current = setTimeout(() => setTestResult(null), 5000);
    }
  };

  return (
    <div className="space-y-4">
      {testResult && (
        <div
          className={`p-3 rounded-large-element flex items-center gap-2 text-sm animate-in fade-in slide-in-from-top-2 duration-200 ${
            testResult.success
              ? "bg-primary/10 text-primary"
              : "bg-error/20 text-error"
          }`}
        >
          {testResult.success ? <Check size={16} /> : <AlertCircle size={16} />}
          {testResult.message}
        </div>
      )}

      <div className="bg-secondary rounded-large-element overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/10">
          <Bell size={18} className="text-accent" />
          <h2 className="font-mono font-normal text-primary">Notifications</h2>
        </div>

        <SettingsRow label="Enable Notifications" description="Receive security alerts">
          <button
            onClick={() => handleToggle("notifications_enabled")}
            className={`relative inline-flex h-7 w-12 items-center rounded-pill transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-secondary ${
              settings?.notifications_enabled ? "bg-accent" : "bg-primary/20"
            }`}
            role="switch"
            aria-checked={settings?.notifications_enabled}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-primary transition-all duration-300 ease-out ${
                settings?.notifications_enabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </SettingsRow>

        <div
          className={`overflow-hidden transition-all duration-300 ease-in-out ${
            settings?.notifications_enabled ? "max-h-[600px] opacity-100" : "max-h-0 opacity-0"
          }`}
        >
          <div className="px-4 py-3 border-b border-primary/10">
            <div className="font-medium text-primary mb-3">Frequency</div>
            <div className="space-y-2">
              {FREQUENCY_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`flex items-center gap-3 p-2.5 rounded-large-element border cursor-pointer transition-all duration-200 ${
                    settings?.notification_frequency === opt.value
                      ? "border-accent bg-accent/10"
                      : "border-primary/10 hover:bg-primary/5"
                  }`}
                >
                  <input
                    type="radio"
                    name="frequency"
                    value={opt.value}
                    checked={settings?.notification_frequency === opt.value}
                    onChange={() => handleFrequencyChange(opt.value)}
                    className="sr-only"
                  />
                  <div
                    className={`w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors duration-200 ${
                      settings?.notification_frequency === opt.value
                        ? "border-accent"
                        : "border-accent/40"
                    }`}
                  >
                    {settings?.notification_frequency === opt.value && (
                      <div className="w-2 h-2 rounded-full bg-accent" />
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="font-medium text-primary text-sm">{opt.label}</div>
                    <div className="text-xs text-accent">{opt.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="px-4 py-3">
            <div className="font-medium text-primary mb-3">Notify Me About</div>
            <div className="space-y-2">
              {NOTIFICATION_OPTIONS.map((opt) => (
                <label
                  key={opt.key}
                  className="flex items-center gap-3 p-2.5 rounded-large-element border border-primary/10 hover:bg-primary/5 cursor-pointer transition-all duration-200"
                >
                  <input
                    type="checkbox"
                    checked={settings?.[opt.key] || false}
                    onChange={() => handleToggle(opt.key)}
                    className="w-4 h-4 rounded border-accent/40 text-accent focus:ring-accent focus:ring-offset-0 accent-accent"
                  />
                  <div className="flex-1">
                    <div className="font-medium text-primary text-sm">{opt.label}</div>
                    <div className="text-xs text-accent">{opt.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="bg-secondary rounded-large-element overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300" style={{ animationDelay: "50ms" }}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/10">
          <Shield size={18} className="text-accent" />
          <h2 className="font-mono font-normal text-primary">Account Security</h2>
        </div>

        <SettingsRow label="Account Lockout" description="Lock after 5 failed attempts">
          <div className="flex items-center gap-1.5 text-primary text-sm">
            <Check size={14} className="text-success" />
            <span>Enabled</span>
          </div>
        </SettingsRow>

        <SettingsRow label="Password Requirements">
          <div className="text-sm text-accent">12+ chars, letters + numbers</div>
        </SettingsRow>

        <div className="px-4 py-3">
          <div className="text-sm text-accent mb-2">Test Email</div>
          <button
            onClick={handleTestNotification}
            disabled={testing || !settings?.notifications_enabled}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-secondary rounded-pill hover:bg-accent hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 text-sm"
          >
            <Mail size={16} />
            {testing ? "Sending..." : "Send Test"}
          </button>
        </div>
      </div>
    </div>
  );
}