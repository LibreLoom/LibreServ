import { cn } from "@/lib/utils";
import { useState } from "react";
import { Mail, Bell } from "lucide-react";
import Toggle from "../../common/Toggle";
import CheckboxOptionGroup from "../../common/CheckboxOptionGroup";
import RadioOptionGroup from "../../common/RadioOptionGroup";
import Alert from "../../common/Alert";
import SettingsCard from "../SettingsCard";
import SettingsRow from "../SettingsRow.jsx";
import Button from "../../ui/Button";
import { useToast } from "../../../context/ToastContext";

const FREQUENCY_OPTIONS = [
  {
    value: "instant",
    label: "Instant",
    description: "Send emails immediately",
  },
  {
    value: "normal",
    label: "Normal",
    description: "Batch non-critical, instant for critical",
  },
  { value: "digest", label: "Daily Digest", description: "Send daily summary" },
];

const NOTIFICATION_OPTIONS = [
  {
    key: "notify_on_login",
    label: "Successful logins",
    description: "When someone logs in",
  },
  {
    key: "notify_on_failed_login",
    label: "Failed login attempts",
    description: "When access is attempted",
  },
  {
    key: "notify_on_password_change",
    label: "Password changes",
    description: "When password is changed",
  },
  {
    key: "notify_on_admin_action",
    label: "Admin actions",
    description: "When settings, routes, or domains are modified",
  },
];

const APP_OPTIONS = [
  {
    key: "notify_on_app_updates",
    label: "App updates",
    description: "When apps are installed, updated, or removed",
  },
];

const USER_MANAGEMENT_OPTIONS = [
  {
    key: "notify_on_user_management",
    label: "User management",
    description: "When users are created or deleted",
  },
];

const HEALTH_NOTIFICATION_OPTIONS = [
  {
    key: "notify_on_health_alert",
    label: "Health check failures",
    description: "When system checks fail",
  },
  {
    key: "notify_on_disk_warning",
    label: "Disk space warnings",
    description: "When disk space is low",
  },
  {
    key: "notify_on_docker_failure",
    label: "Runtime failures",
    description: "When the container engine fails",
  },
  {
    key: "notify_on_database_issue",
    label: "Database issues",
    description: "When database has problems",
  },
];

export default function NotificationsCategory({ settings, securitySettings, onSecuritySettingsChange, onSettingsChange }) {
  const { addToast } = useToast();
  const [testing, setTesting] = useState(false);

  const handleTestNotification = async () => {
    try {
      setTesting(true);

      const csrfRes = await fetch("/api/v1/auth/csrf");
      const csrfData = await csrfRes.json();
      const csrfToken = csrfData.csrf_token;

      const res = await fetch("/api/v1/monitoring/email/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          to: settings?.smtp?.from || "test@example.com",
        }),
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

  const handleSecurityChange = (key) => {
    onSecuritySettingsChange?.({
      ...securitySettings,
      [key]: !securitySettings[key],
    });
  };

  const smtpConfigured = settings?.smtp?.configured || false;

  const securityPrefs = securitySettings || {};

  return (
    <div className="space-y-4" data-slot="notifications-category">
      <SettingsCard icon={Mail} title="Email / SMTP" padding={false} index={0}>
        <SettingsRow
          label="Email provider configuration"
          description={smtpConfigured ? "Connected — change provider in External Services" : "Not configured — set up in External Services"}
        >
          <a
            href="#external_services"
            className="text-xs px-3 py-1.5 rounded-pill bg-primary text-secondary border-2 border-secondary/10 hover:bg-accent hover:text-primary hover:border-accent motion-safe:transition-colors"
          >
            External Services →
          </a>
        </SettingsRow>
      </SettingsCard>

      {smtpConfigured && (
        <SettingsCard icon={Mail} title="Test Email" padding={false} index={1}>
          <div className="px-4 py-3">
            <div className="rounded-large-element border border-accent/30 bg-accent/5 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-accent/10 border border-accent/20">
                    <Mail size={16} className="text-accent" />
                  </div>
                  <div>
                    <div className="font-medium text-primary text-sm">
                      Send Test Notification
                    </div>
                    <div className="text-xs text-accent mt-0.5">
                      Verify your SMTP configuration is working
                    </div>
                  </div>
                </div>
                <Button
                  variant="primary"
                  onClick={handleTestNotification}
                  loading={testing}
                >
                  {testing ? (
                    "Sending..."
                  ) : (
                    <>
                      <Mail size={14} />
                      Send Test
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </SettingsCard>
      )}

      <SettingsCard
        icon={Bell}
        title="Notification Preferences"
        padding={false}
        index={2}
      >
        <div className={cn("px-4 pt-3", settings?.notify?.enabled ? "" : "pb-3")}>
          <Toggle
            checked={settings?.notify?.enabled || false}
            onChange={() =>
              onSettingsChange?.({
                ...settings,
                notify: {
                  ...settings.notify,
                  enabled: !settings.notify.enabled,
                },
              })
            }
            label="Enable Notifications"
            description="Receive email notifications"
          />

          <div
            className={cn("overflow-hidden transition-all ease-[var(--motion-easing-emphasized)]", settings?.notify?.enabled ? "max-h-[100dvh] opacity-100 mt-4 pb-4" : "max-h-0 opacity-0")}
            style={{ transitionDuration: "var(--motion-duration-medium2)" }}
          >
            <div className="pt-4 border-t border-primary/10 space-y-6">
              <div>
                <div className="font-medium text-primary mb-3">Frequency</div>
                <RadioOptionGroup
                  name="frequency"
                  options={FREQUENCY_OPTIONS}
                  value={securityPrefs.notification_frequency || "normal"}
                  onChange={(frequency) =>
                    onSecuritySettingsChange?.({
                      ...securitySettings,
                      notification_frequency: frequency,
                    })
                  }
                />
              </div>

              <div>
                <div className="font-medium text-primary mb-3">
                  Security Notifications
                </div>
                <CheckboxOptionGroup
                  options={NOTIFICATION_OPTIONS}
                  values={{
                    notify_on_login: securityPrefs.notify_on_login || false,
                    notify_on_failed_login:
                      securityPrefs.notify_on_failed_login || false,
                    notify_on_password_change:
                      securityPrefs.notify_on_password_change || false,
                    notify_on_admin_action:
                      securityPrefs.notify_on_admin_action || false,
                  }}
                  onChange={handleSecurityChange}
                />
              </div>

              <div>
                <div className="font-medium text-primary mb-3">
                  Apps
                </div>
                <CheckboxOptionGroup
                  options={APP_OPTIONS}
                  values={{
                    notify_on_app_updates:
                      securityPrefs.notify_on_app_updates ?? true,
                  }}
                  onChange={handleSecurityChange}
                />
              </div>

              <div>
                <div className="font-medium text-primary mb-3">
                  User Management
                </div>
                <CheckboxOptionGroup
                  options={USER_MANAGEMENT_OPTIONS}
                  values={{
                    notify_on_user_management:
                      securityPrefs.notify_on_user_management ?? true,
                  }}
                  onChange={handleSecurityChange}
                />
              </div>

              <div>
                <div className="font-medium text-primary mb-3">
                  System Health Notifications
                </div>
                <CheckboxOptionGroup
                  options={HEALTH_NOTIFICATION_OPTIONS}
                  values={{
                    notify_on_health_alert:
                      securityPrefs.notify_on_health_alert || false,
                    notify_on_disk_warning:
                      securityPrefs.notify_on_disk_warning || false,
                    notify_on_docker_failure:
                      securityPrefs.notify_on_docker_failure || false,
                    notify_on_database_issue:
                      securityPrefs.notify_on_database_issue || false,
                  }}
                  onChange={handleSecurityChange}
                />
              </div>
            </div>
          </div>
        </div>
      </SettingsCard>

    </div>
  );
}
