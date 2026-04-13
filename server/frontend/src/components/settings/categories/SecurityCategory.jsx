import { useState, useEffect } from "react";
import {
  Shield,
  Bell,
  Mail,
  Check,
  Activity,
  AlertTriangle,
  RefreshCw,
  Filter,
} from "lucide-react";
import Card from "../../cards/Card";
import Toggle from "../../common/Toggle";
import RadioOptionGroup from "../../common/RadioOptionGroup";
import CheckboxOptionGroup from "../../common/CheckboxOptionGroup";
import Dropdown from "../../common/Dropdown";
import TypewriterLoader from "../../ui/TypewriterLoader";
import SettingsRow from "../SettingsRow";
import { useToast } from "../../../context/ToastContext";
import {
  getSecurityEvents,
  getSecurityStats,
  getEventTypeDisplayName,
  getSeverityColor,
  formatTimestamp,
} from "../../../lib/security-api.js";
import { stripHTML } from "../../../lib/sanitize.js";

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

function StatCard({ value, label, variant = "accent" }) {
  const colorClass = variant === "warning" ? "text-warning" : variant === "error" ? "text-error" : "text-accent";
  return (
    <Card className="text-center py-3">
      <div className={`text-2xl font-bold ${colorClass}`}>{value}</div>
      <div className="text-xs text-accent mt-1">{label}</div>
    </Card>
  );
}

export default function SecurityCategory({ settings, onSettingsChange, onTestNotification }) {
  const { addToast } = useToast();

  const [testing, setTesting] = useState(false);

  const [events, setEvents] = useState([]);
  const [stats, setStats] = useState(null);
  const [activityLoading, setActivityLoading] = useState(true);
  const [filter, setFilter] = useState("7d");
  const [lastUpdated, setLastUpdated] = useState(null);

  useEffect(() => {
    loadActivityData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const handleToggle = (key) => {
    onSettingsChange?.({ ...settings, [key]: !settings[key] });
  };

  const handleFrequencyChange = (frequency) => {
    onSettingsChange?.({ ...settings, notification_frequency: frequency });
  };

  const handleNotificationChange = (key) => {
    onSettingsChange?.({ ...settings, [key]: !settings[key] });
  };

  const handleTestNotification = async () => {
    try {
      setTesting(true);
      await onTestNotification?.();
      addToast({ type: "success", message: "Test notification sent!" });
    } catch (err) {
      addToast({ type: "error", message: err?.message || "Failed to send test" });
    } finally {
      setTesting(false);
    }
  };

  const loadActivityData = async () => {
    try {
      setActivityLoading(true);

      let since;
      switch (filter) {
        case "24h":
          since = new Date();
          since.setHours(since.getHours() - 24);
          break;
        case "7d":
          since = new Date();
          since.setDate(since.getDate() - 7);
          break;
        case "30d":
          since = new Date();
          since.setDate(since.getDate() - 30);
          break;
        case "all":
          since = null;
          break;
        default:
          since = new Date();
          since.setDate(since.getDate() - 7);
      }

      const eventFilters = { limit: 100 };
      if (since) {
        eventFilters.since = since.toISOString();
      }

      const eventsData = await getSecurityEvents(eventFilters);
      const rawEvents = Array.isArray(eventsData)
        ? eventsData
        : Array.isArray(eventsData?.events)
          ? eventsData.events
          : [];

      let statsData = null;
      try {
        statsData = await getSecurityStats(since ? { since: since.toISOString() } : {});
      } catch (statsErr) {
        const status = statsErr?.cause?.status;
        if (status !== 403) {
          throw statsErr;
        }
      }

      setEvents(rawEvents);
      setStats(statsData);
      setLastUpdated(new Date());
    } catch (err) {
      const errorMessage =
        err?.message ||
        err?.response?.data?.message ||
        "Failed to load security activity.";
      addToast({ type: "error", message: errorMessage });
      console.error("Error loading security data:", err);
    } finally {
      setActivityLoading(false);
    }
  };

  const getSeverityIcon = (severity) => {
    switch (severity) {
      case "critical":
        return <AlertTriangle size={18} className="text-error" />;
      case "warning":
        return <AlertTriangle size={18} className="text-warning" />;
      default:
        return <Check size={18} className="text-accent" />;
    }
  };

  return (
    <div className="space-y-4">
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <StatCard value={stats.total_events} label="Total Events" />
          <StatCard value={stats.successful_logins} label="Successful Logins" />
          <StatCard value={stats.failed_logins} label="Failed Attempts" variant="warning" />
          <StatCard value={stats.critical_events} label="Critical Events" variant="error" />
        </div>
      )}

      <Card
        icon={Activity}
        title="Activity Log"
        padding={false}
        headerActions={
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Filter size={14} className="text-accent" />
              <Dropdown
                value={filter}
                onChange={setFilter}
                width={80}
                options={[
                  { value: "24h", label: "24h" },
                  { value: "7d", label: "7d" },
                  { value: "30d", label: "30d" },
                  { value: "all", label: "All" },
                ]}
              />
            </div>
            {lastUpdated && (
              <span className="text-xs text-accent hidden sm:inline">
                {formatTimestamp(lastUpdated.toISOString())}
              </span>
            )}
            <button
              onClick={loadActivityData}
              disabled={activityLoading}
              className="p-1.5 rounded hover:bg-primary/10 disabled:opacity-50 transition-colors"
              aria-label="Refresh activity log"
            >
              <RefreshCw size={14} className={`text-accent ${activityLoading ? "animate-spin" : ""}`} aria-hidden="true" />
            </button>
          </div>
        }
        className="animate-in fade-in slide-in-from-bottom-2 duration-300"
      >
        <div className="px-4 pb-4 pt-3">
          <div className="bg-primary/5 rounded-card p-3">
            <div className="max-h-96 overflow-y-auto">
              {activityLoading ? (
                <div className="flex justify-center items-center py-12">
                  <TypewriterLoader size="md" />
                </div>
              ) : events.length === 0 ? (
                <div className="text-center py-12">
                  <Shield size={40} className="mx-auto text-accent/30 mb-3" />
                  <p className="text-sm text-accent">No security events found</p>
                </div>
              ) : (
                <table className="w-full text-sm border-separate border-spacing-y-2">
                  <thead>
                    <tr>
                      <th scope="col" className="text-left px-3 py-1.5 text-xs font-medium text-accent/70">Time</th>
                      <th scope="col" className="text-left px-3 py-1.5 text-xs font-medium text-accent/70">Event</th>
                      <th scope="col" className="text-left px-3 py-1.5 text-xs font-medium text-accent/70 hidden sm:table-cell">User</th>
                      <th scope="col" className="text-left px-3 py-1.5 text-xs font-medium text-accent/70">Severity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event) => (
                      <tr key={event.id} className="group transition-colors">
                        <td className="py-2.5 pl-3 bg-secondary rounded-l-large-element group-hover:bg-primary/5 transition-colors">
                          <span className="inline-flex items-center px-2.5 py-1 rounded-pill bg-primary/10 text-xs text-accent whitespace-nowrap">
                            {formatTimestamp(event.timestamp)}
                          </span>
                        </td>
                        <td className="py-2.5 px-1 bg-secondary group-hover:bg-primary/5 transition-colors">
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill bg-primary/10">
                            {getSeverityIcon(event.severity)}
                            <span className="font-medium text-xs text-primary truncate">
                              {getEventTypeDisplayName(event.event_type)}
                            </span>
                          </span>
                        </td>
                        <td className="py-2.5 px-1 bg-secondary group-hover:bg-primary/5 transition-colors hidden sm:table-cell">
                          <span className="inline-flex items-center px-2.5 py-1 rounded-pill bg-primary/10 text-xs text-primary">
                            {stripHTML(event.actor_username) || "System"}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 bg-secondary rounded-r-large-element group-hover:bg-primary/5 transition-colors">
                          <span
                            className={`inline-flex items-center px-2.5 py-1 rounded-pill text-xs font-medium ${getSeverityColor(event.severity)}`}
                          >
                            {event.severity}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </Card>

      <Card
        icon={Bell}
        title="Notifications"
        padding={false}
        className="animate-in fade-in slide-in-from-bottom-2 duration-300"
        style={{ animationDelay: "50ms" }}
      >
        <div className="px-4 py-3">
          <Toggle
            checked={settings?.notifications_enabled || false}
            onChange={() => handleToggle("notifications_enabled")}
            label="Enable Notifications"
            description="Receive security alerts"
          />

          <div
            className={`overflow-hidden transition-all duration-300 ease-in-out ${
              settings?.notifications_enabled ? "max-h-[600px] opacity-100" : "max-h-0 opacity-0"
            }`}
          >
            <div className="pt-3 mt-3 border-t border-primary/10">
              <div className="font-medium text-primary mb-3">Frequency</div>
              <RadioOptionGroup
                name="frequency"
                options={FREQUENCY_OPTIONS}
                value={settings?.notification_frequency || "normal"}
                onChange={handleFrequencyChange}
              />
            </div>

            <div className="pt-4 mt-4 border-t border-primary/10 pb-3">
              <div className="font-medium text-primary mb-3">Notify Me About</div>
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
          </div>
        </div>
      </Card>

      <Card
        icon={Shield}
        title="Account Security"
        padding={false}
        className="animate-in fade-in slide-in-from-bottom-2 duration-300"
        style={{ animationDelay: "100ms" }}
      >
        <div className="px-4 py-3">
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
      </Card>

      <Card
        icon={Shield}
        title="Security Tips"
        padding={false}
        className="animate-in fade-in slide-in-from-bottom-2 duration-300"
        style={{ animationDelay: "150ms" }}
      >
        <div className="p-4 grid md:grid-cols-2 gap-3">
          <div className="p-3 bg-primary/5 rounded-large-element">
            <h4 className="font-medium text-primary mb-1 text-sm">Use a Strong Password</h4>
            <p className="text-xs text-accent">
              Use a unique, strong password. Consider using a password manager.
            </p>
          </div>
          <div className="p-3 bg-primary/5 rounded-large-element">
            <h4 className="font-medium text-primary mb-1 text-sm">Monitor Your Account</h4>
            <p className="text-xs text-accent">
              Regularly review your security activity log for unauthorized access.
            </p>
          </div>
          <div className="p-3 bg-warning/10 rounded-large-element">
            <h4 className="font-medium text-warning mb-1 text-sm">Enable Notifications</h4>
            <p className="text-xs text-accent">
              Turn on security notifications to stay informed about important activity.
            </p>
          </div>
          <div className="p-3 bg-primary/5 rounded-large-element">
            <h4 className="font-medium text-primary mb-1 text-sm">Keep Software Updated</h4>
            <p className="text-xs text-accent">
              Ensure LibreServ and all installed apps have the latest security patches.
            </p>
          </div>
        </div>
      </Card>

    </div>
  );
}
