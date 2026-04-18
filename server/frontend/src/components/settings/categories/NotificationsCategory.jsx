import { useState } from "react";
import { Mail, Bell, AlertCircle, CheckCircle, RefreshCw } from "lucide-react";
import Toggle from "../../common/Toggle";
import CheckboxOptionGroup from "../../common/CheckboxOptionGroup";
import RadioOptionGroup from "../../common/RadioOptionGroup";
import Alert from "../../common/Alert";
import Pill from "../../common/Pill";
import SettingsCard from "../SettingsCard";
import ValueDisplay from "../../common/ValueDisplay";
import { useToast } from "../../../context/ToastContext";

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

const HEALTH_NOTIFICATION_OPTIONS = [
  { key: "notify_on_health_alert", label: "Health check failures", description: "When system checks fail" },
  { key: "notify_on_disk_warning", label: "Disk space warnings", description: "When disk space is low" },
  { key: "notify_on_docker_failure", label: "Docker failures", description: "When Docker daemon fails" },
  { key: "notify_on_database_issue", label: "Database issues", description: "When database has problems" },
];

export default function NotificationsCategory({ settings, onSettingsChange }) {
  const { addToast } = useToast();
  const [testing, setTesting] = useState(false);
  const smtpConfigured = settings?.smtp?.configured || false;

  const handleTestNotification = async () => {
    try {
      setTesting(true);
      
      // Get CSRF token
      const csrfRes = await fetch("/api/v1/auth/csrf");
      const csrfData = await csrfRes.json();
      const csrfToken = csrfData.csrf_token;
      
      const res = await fetch("/api/v1/monitoring/email/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ to: settings?.smtp?.from || "test@example.com" }),
      });
      
      if (!res.ok) {
        const data = await res.json();
        const errorMsg = data.message || data.error || "Failed to send test";
        throw new Error(errorMsg);
      }
      
      addToast({ type: "success", message: "Test email sent!" });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      addToast({ type: "error", message: errorMsg });
    } finally {
      setTesting(false);
    }
  };

  const handleFrequencyChange = (frequency) => {
    onSettingsChange?.({ ...settings, notification_frequency: frequency });
  };

  const handleNotificationChange = (key) => {
    onSettingsChange?.({ ...settings, [key]: !settings[key] });
  };

  return (
    <div className="space-y-4">
      <SettingsCard icon={Mail} title="SMTP Configuration" padding={false} index={0}>
        <div className="px-4 py-3 space-y-4">
          {!smtpConfigured ? (
            <Alert
              variant="warning"
              message="SMTP is not configured. Email notifications will not work until SMTP settings are provided."
            />
          ) : (
            <Alert
              variant="success"
              message="SMTP is configured and ready to send emails."
            />
          )}

          <div className="grid gap-4">
            <div>
              <label className="text-accent font-sans text-sm text-left translate-x-5 mb-1 block">
                SMTP Host
              </label>
              <input
                type="text"
                value={settings?.smtp?.host || ""}
                onChange={(e) => onSettingsChange?.({
                  ...settings,
                  smtp: { ...settings.smtp, host: e.target.value }
                })}
                placeholder="smtp.example.com"
                className="w-full px-5 py-3.5 rounded-pill border border-primary/20 bg-transparent text-primary placeholder:text-primary/25 font-mono text-sm focus:outline-none focus:border-primary/50 motion-safe:transition-colors motion-safe:duration-150"
              />
            </div>

            <div>
              <label className="text-accent font-sans text-sm text-left translate-x-5 mb-1 block">
                Port
              </label>
              <input
                type="number"
                value={settings?.smtp?.port || ""}
                onChange={(e) => onSettingsChange?.({
                  ...settings,
                  smtp: { ...settings.smtp, port: parseInt(e.target.value) }
                })}
                placeholder="587"
                className="w-full px-5 py-3.5 rounded-pill border border-primary/20 bg-transparent text-primary placeholder:text-primary/25 font-mono text-sm focus:outline-none focus:border-primary/50 motion-safe:transition-colors motion-safe:duration-150"
              />
            </div>

            <div>
              <label className="text-accent font-sans text-sm text-left translate-x-5 mb-1 block">
                Username
              </label>
              <input
                type="text"
                value={settings?.smtp?.username || ""}
                onChange={(e) => onSettingsChange?.({
                  ...settings,
                  smtp: { ...settings.smtp, username: e.target.value }
                })}
                placeholder="username"
                className="w-full px-5 py-3.5 rounded-pill border border-primary/20 bg-transparent text-primary placeholder:text-primary/25 font-mono text-sm focus:outline-none focus:border-primary/50 motion-safe:transition-colors motion-safe:duration-150"
              />
            </div>

            <div>
              <label className="text-accent font-sans text-sm text-left translate-x-5 mb-1 block">
                Password
              </label>
              <input
                type="password"
                value={settings?.smtp?.password || ""}
                onChange={(e) => onSettingsChange?.({
                  ...settings,
                  smtp: { ...settings.smtp, password: e.target.value }
                })}
                placeholder="••••••••"
                className="w-full px-5 py-3.5 rounded-pill border border-primary/20 bg-transparent text-primary placeholder:text-primary/25 font-mono text-sm focus:outline-none focus:border-primary/50 motion-safe:transition-colors motion-safe:duration-150"
              />
            </div>

            <div>
              <label className="text-accent font-sans text-sm text-left translate-x-5 mb-1 block">
                From Email
              </label>
              <input
                type="email"
                value={settings?.smtp?.from || ""}
                onChange={(e) => onSettingsChange?.({
                  ...settings,
                  smtp: { ...settings.smtp, from: e.target.value }
                })}
                placeholder="noreply@example.com"
                className="w-full px-5 py-3.5 rounded-pill border border-primary/20 bg-transparent text-primary placeholder:text-primary/25 font-mono text-sm focus:outline-none focus:border-primary/50 motion-safe:transition-colors motion-safe:duration-150"
              />
            </div>

            <Toggle
              checked={settings?.smtp?.use_tls || false}
              onChange={() => onSettingsChange?.({
                ...settings,
                smtp: { ...settings.smtp, use_tls: !settings.smtp.use_tls }
              })}
              label="Use TLS"
              description="Encrypt SMTP connection"
            />

            <Toggle
              checked={settings?.smtp?.skip_verify || false}
              onChange={() => onSettingsChange?.({
                ...settings,
                smtp: { ...settings.smtp, skip_verify: !settings.smtp.skip_verify }
              })}
              label="Skip Certificate Verification"
              description="Allow self-signed certificates (dev only)"
            />
          </div>

          <div className="pt-4 border-t border-primary/10">
            <button
              onClick={handleTestNotification}
              disabled={testing || !smtpConfigured}
              className={`w-full inline-flex items-center justify-center gap-2 rounded-pill px-4 py-2 text-sm font-medium motion-safe:transition-all focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-primary disabled:opacity-50 disabled:cursor-not-allowed ${
                smtpConfigured
                  ? 'bg-primary text-secondary hover:bg-secondary hover:text-primary hover:ring-2 hover:ring-primary'
                  : 'bg-primary text-secondary'
              }`}
            >
              {testing ? (
                <>
                  <RefreshCw size={16} className="animate-spin mr-2" />
                  Sending...
                </>
              ) : (
                <>
                  <Mail size={16} className="mr-2" />
                  Send Test Email
                </>
              )}
            </button>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard icon={Bell} title="Notification Preferences" padding={false} index={1}>
        <div className="px-4 py-3">
          <Toggle
            checked={settings?.notify?.enabled || false}
            onChange={() => onSettingsChange?.({
              ...settings,
              notify: { ...settings.notify, enabled: !settings.notify.enabled }
            })}
            label="Enable Notifications"
            description="Receive email notifications"
          />

          <div
            className={`overflow-hidden transition-all duration-300 ${
              settings?.notify?.enabled ? "max-h-[1000px] opacity-100" : "max-h-0 opacity-0"
            }`}
          >
            <div className="pt-4 mt-4 border-t border-primary/10 space-y-6">
              <div>
                <div className="font-medium text-primary mb-3">Frequency</div>
                <RadioOptionGroup
                  name="frequency"
                  options={FREQUENCY_OPTIONS}
                  value={settings?.notification_frequency || "normal"}
                  onChange={handleFrequencyChange}
                />
              </div>

              <div>
                <div className="font-medium text-primary mb-3">Security Notifications</div>
                <CheckboxOptionGroup
                  options={NOTIFICATION_OPTIONS}
                  values={{
                    notify_on_login: settings?.notify_on_login || false,
                    notify_on_failed_login: settings?.notify_on_failed_login || false,
                    notify_on_password_change: settings?.notify_on_password_change || false,
                    notify_on_admin_action: settings?.notify_on_admin_action || false,
                  }}
                  onChange={handleNotificationChange}
                />
              </div>

              <div>
                <div className="font-medium text-primary mb-3">System Health Notifications</div>
                <CheckboxOptionGroup
                  options={HEALTH_NOTIFICATION_OPTIONS}
                  values={{
                    notify_on_health_alert: settings?.notify_on_health_alert || false,
                    notify_on_disk_warning: settings?.notify_on_disk_warning || false,
                    notify_on_docker_failure: settings?.notify_on_docker_failure || false,
                    notify_on_database_issue: settings?.notify_on_database_issue || false,
                  }}
                  onChange={handleNotificationChange}
                />
              </div>

              <div className="pt-4 border-t border-primary/10">
                <div className="font-medium text-primary mb-3">Test Email</div>
                <div className="flex items-center gap-3">
                  <Mail size={16} className="text-accent" />
                  <span className="text-sm text-accent">Send a test notification to your email</span>
                  <button
                    onClick={handleTestNotification}
                    disabled={testing || !smtpConfigured}
                    className={`inline-flex items-center justify-center gap-2 rounded-pill px-3 py-1.5 text-xs font-medium motion-safe:transition-all focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-primary disabled:opacity-50 disabled:cursor-not-allowed ${
                      smtpConfigured
                        ? 'bg-primary text-secondary hover:bg-secondary hover:text-primary hover:ring-2 hover:ring-primary'
                        : 'bg-primary text-secondary'
                    }`}
                  >
                    {testing ? "Sending..." : "Send Test"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
