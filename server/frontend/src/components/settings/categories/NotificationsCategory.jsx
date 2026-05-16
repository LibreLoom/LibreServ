import { useState, useCallback } from "react";
import PropTypes from "prop-types";
import { Mail, Bell, RefreshCw, ExternalLink, AlertTriangle, ShieldAlert } from "lucide-react";
import Toggle from "../../common/Toggle";
import CheckboxOptionGroup from "../../common/CheckboxOptionGroup";
import RadioOptionGroup from "../../common/RadioOptionGroup";
import Alert from "../../common/Alert";
import ValueDisplay from "../../common/ValueDisplay";
import Pill from "../../common/Pill";
import SettingsCard from "../SettingsCard";
import Button from "../../ui/Button";
import ConfirmModal from "../../common/ConfirmModal";
import SmtpWizard from "../../smtp/SmtpWizard";
import { SMTP_PRESETS } from "../../smtp/smtp-wiz-constants";
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
    description: "When settings or apps are modified",
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
    label: "Docker failures",
    description: "When Docker daemon fails",
  },
  {
    key: "notify_on_database_issue",
    label: "Database issues",
    description: "When database has problems",
  },
];

function detectPresetFromHost(host) {
  for (const [id, p] of Object.entries(SMTP_PRESETS)) {
    if (id === "custom") continue;
    if (p.host && host === p.host) return id;
  }
  return "custom";
}

function SmtpStatusCard({ smtp, onReconfigure, onDisconnect }) {
  const { addToast } = useToast();
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const smtpConfigured = smtp?.configured || false;
  const host = smtp?.host || "";
  const from = smtp?.from || "";
  const preset = detectPresetFromHost(host);
  const providerLabel = SMTP_PRESETS[preset]?.label || "Custom";

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      const csrfRes = await fetch("/api/v1/auth/csrf");
      const csrfData = await csrfRes.json();
      const csrfToken = csrfData.csrf_token;

      const res = await fetch("/api/v1/notify/config", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        credentials: "include",
        body: JSON.stringify({
          smtp: { host: "", port: 587, username: "", password: "", from: "", use_tls: false, skip_verify: false },
        }),
      });

      if (res.ok) {
        addToast({ type: "warning", message: "SMTP disconnected" });
        onDisconnect();
        setShowDisconnectModal(false);
      } else {
        const data = await res.json();
        addToast({ type: "error", message: data.error || "Failed to disconnect SMTP" });
      }
    } catch (err) {
      addToast({ type: "error", message: err.message });
    } finally {
      setDisconnecting(false);
    }
  }, [addToast, onDisconnect]);

  if (!smtpConfigured) {
    return (
      <SettingsCard icon={Mail} title="Email (SMTP)" index={0}>
        <div className="flex flex-col items-center text-center py-8">
          <div className="inline-flex items-center gap-4 px-8 py-4 rounded-pill bg-accent/15 text-accent mb-8 border border-accent/20">
            <Mail size={28} />
            <span className="font-mono text-lg tracking-wide">Not Configured</span>
          </div>
          <p className="text-sm text-primary/60 max-w-xs mb-8 leading-relaxed">
            LibreServ needs an email provider to deliver password resets and notifications. Since you control your own server, you choose who sends on your behalf.
          </p>
          <Button
            variant="primary"
            onClick={onReconfigure}
            className="w-full max-w-sm"
          >
            <ExternalLink size={16} />
            Configure SMTP
          </Button>
        </div>
      </SettingsCard>
    );
  }

  return (
    <>
      <SettingsCard icon={Mail} title="Email (SMTP)" padding={false} index={0}>
        <div className="px-4 pb-4 pt-3 space-y-2">
          <div className="flex items-center justify-between py-2 px-3 border border-primary/10 rounded-large-element bg-primary/5">
            <span className="text-sm text-primary font-medium">Status</span>
            <Pill variant="accent">
              <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              Connected
            </Pill>
          </div>
          <ValueDisplay label="Provider" value={providerLabel} />
          <ValueDisplay label="Server" value={host} />
          <ValueDisplay label="From" value={from} />

          <div className="flex gap-3 pt-2">
            <Button
              variant="accent"
              className="flex-1"
              onClick={onReconfigure}
            >
              Change SMTP
            </Button>
            <Button
              variant="danger"
              className="flex-1"
              onClick={() => setShowDisconnectModal(true)}
            >
              Disconnect
            </Button>
          </div>

          <div className="flex items-start gap-2 px-3 py-2.5 rounded-pill bg-warning/10 border border-warning/20">
            <ShieldAlert size={16} className="text-warning mt-0.5 flex-shrink-0" />
            <div className="text-xs text-warning leading-relaxed">
              <strong className="font-mono">Warning:</strong> Disconnecting will disable all email notifications, password resets, and welcome emails.
            </div>
          </div>
        </div>
      </SettingsCard>

      <ConfirmModal
        open={showDisconnectModal}
        onClose={() => setShowDisconnectModal(false)}
        onConfirm={handleDisconnect}
        icon={AlertTriangle}
        title="Disconnect SMTP"
        message={`Disconnect ${providerLabel} SMTP? Email notifications and password resets will stop working.`}
        variant="danger"
        confirmLabel="Disconnect"
        loading={disconnecting}
      />
    </>
  );
}

SmtpStatusCard.propTypes = {
  smtp:          PropTypes.object,
  onReconfigure: PropTypes.func.isRequired,
  onDisconnect:  PropTypes.func.isRequired,
};

export default function NotificationsCategory({ settings, onSettingsChange }) {
  const { addToast } = useToast();
  const [testing, setTesting] = useState(false);
  const [showSmtpWizard, setShowSmtpWizard] = useState(false);

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

  const handleFrequencyChange = (frequency) => {
    onSettingsChange?.({ ...settings, notification_frequency: frequency });
  };

  const handleNotificationChange = (key) => {
    onSettingsChange?.({ ...settings, [key]: !settings[key] });
  };

  const handleSmtpReconfigure = () => {
    setShowSmtpWizard(true);
  };

  const handleSmtpDisconnect = () => {
    onSettingsChange?.({
      ...settings,
      smtp: {
        host: "",
        port: 587,
        username: "",
        from: "",
        use_tls: false,
        skip_verify: false,
        configured: false,
      },
    });
  };

  const handleSmtpWizardComplete = () => {
    setShowSmtpWizard(false);
    window.location.reload();
  };

  const handleSmtpWizardSkip = () => {
    setShowSmtpWizard(false);
  };

  const smtpConfigured = settings?.smtp?.configured || false;

  return (
    <div className="space-y-4">
      <SmtpStatusCard
        smtp={settings?.smtp}
        onReconfigure={handleSmtpReconfigure}
        onDisconnect={handleSmtpDisconnect}
      />

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
                <button
                  onClick={handleTestNotification}
                  disabled={testing}
                  className="inline-flex items-center justify-center gap-2 rounded-pill px-4 py-2 text-sm font-medium bg-primary text-secondary hover:bg-secondary hover:text-primary hover:ring-2 hover:ring-primary motion-safe:transition-all focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-primary disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {testing ? (
                    <>
                      <RefreshCw size={14} className="animate-spin" />
                      Sending...
                    </>
                  ) : (
                    <>
                      <Mail size={14} />
                      Send Test
                    </>
                  )}
                </button>
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
        <div className="px-4 py-3">
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

          {settings?.notify?.enabled && (
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
                <div className="font-medium text-primary mb-3">
                  Security Notifications
                </div>
                <CheckboxOptionGroup
                  options={NOTIFICATION_OPTIONS}
                  values={{
                    notify_on_login: settings?.notify_on_login || false,
                    notify_on_failed_login:
                      settings?.notify_on_failed_login || false,
                    notify_on_password_change:
                      settings?.notify_on_password_change || false,
                    notify_on_admin_action:
                      settings?.notify_on_admin_action || false,
                  }}
                  onChange={handleNotificationChange}
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
                      settings?.notify_on_health_alert || false,
                    notify_on_disk_warning:
                      settings?.notify_on_disk_warning || false,
                    notify_on_docker_failure:
                      settings?.notify_on_docker_failure || false,
                    notify_on_database_issue:
                      settings?.notify_on_database_issue || false,
                  }}
                  onChange={handleNotificationChange}
                />
              </div>
            </div>
          )}
        </div>
      </SettingsCard>

      {showSmtpWizard && (
        <SmtpWizard
          open={showSmtpWizard}
          onComplete={handleSmtpWizardComplete}
          onSkip={handleSmtpWizardSkip}
          onDismiss={() => setShowSmtpWizard(false)}
        />
      )}
    </div>
  );
}
