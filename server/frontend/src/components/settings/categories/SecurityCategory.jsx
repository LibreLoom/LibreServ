import { useState, useRef, useEffect } from "react";
import {
  Shield,
  Bell,
  Mail,
  Check,
  AlertCircle,
  Activity,
  AlertTriangle,
  RefreshCw,
  Filter,
} from "lucide-react";
import SettingsRow from "../SettingsRow";
import Card from "../../common/cards/Card";
import TypewriterLoader from "../../common/TypewriterLoader";
import ErrorDisplay from "../../common/ErrorDisplay";
import {
  getSecurityEvents,
  getSecurityStats,
  getEventTypeDisplayName,
  getSeverityColor,
  formatTimestamp,
} from "../../../lib/security-api.js";
import { sanitizeEvent, stripHTML } from "../../../lib/sanitize.js";

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

  const [events, setEvents] = useState([]);
  const [stats, setStats] = useState(null);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState(null);
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

  const loadActivityData = async () => {
    try {
      setActivityLoading(true);
      setActivityError(null);

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

      const sanitizedEvents = rawEvents.map((event) => sanitizeEvent(event));
      setEvents(sanitizedEvents);
      setStats(statsData);
      setLastUpdated(new Date());
    } catch (err) {
      const errorMessage =
        err?.message ||
        err?.response?.data?.message ||
        "Failed to load security activity.";
      setActivityError(errorMessage);
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

      {activityError && <ErrorDisplay message={activityError} />}

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <Card className="text-center py-3">
            <div className="text-2xl font-bold text-accent">{stats.total_events}</div>
            <div className="text-xs text-accent mt-1">Total Events</div>
          </Card>
          <Card className="text-center py-3">
            <div className="text-2xl font-bold text-accent">{stats.successful_logins}</div>
            <div className="text-xs text-accent mt-1">Successful Logins</div>
          </Card>
          <Card className="text-center py-3">
            <div className="text-2xl font-bold text-warning">{stats.failed_logins}</div>
            <div className="text-xs text-accent mt-1">Failed Attempts</div>
          </Card>
          <Card className="text-center py-3">
            <div className="text-2xl font-bold text-error">{stats.critical_events}</div>
            <div className="text-xs text-accent mt-1">Critical Events</div>
          </Card>
        </div>
      )}

      <div className="bg-secondary rounded-large-element overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/10">
          <Activity size={18} className="text-accent" />
          <h2 className="font-mono font-normal text-primary">Activity Log</h2>
          <div className="ml-auto flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Filter size={14} className="text-accent" />
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="text-xs px-2 py-1 border rounded bg-primary focus-visible:ring-2 focus:ring-accent"
              >
                <option value="24h">24h</option>
                <option value="7d">7d</option>
                <option value="30d">30d</option>
                <option value="all">All</option>
              </select>
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
              title="Refresh"
            >
              <RefreshCw size={14} className={`text-accent ${activityLoading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        <div className="max-h-64 overflow-y-auto">
          {activityLoading ? (
            <div className="flex justify-center items-center py-8">
              <TypewriterLoader size="md" />
            </div>
          ) : events.length === 0 ? (
            <div className="text-center py-8">
              <Shield size={32} className="mx-auto text-secondary/30 mb-2" />
              <p className="text-sm text-accent">No security events found</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-secondary">
                <tr className="border-b border-primary/10">
                  <th className="text-left py-2 px-4 font-medium text-accent">Time</th>
                  <th className="text-left py-2 px-4 font-medium text-accent">Event</th>
                  <th className="text-left py-2 px-4 font-medium text-accent hidden sm:table-cell">User</th>
                  <th className="text-left py-2 px-4 font-medium text-accent">Severity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-primary/10">
                {events.map((event) => (
                  <tr key={event.id} className="hover:bg-primary/5 transition-colors">
                    <td className="py-2 px-4 whitespace-nowrap text-xs">
                      {formatTimestamp(event.timestamp)}
                    </td>
                    <td className="py-2 px-4">
                      <div className="flex items-center gap-1.5">
                        {getSeverityIcon(event.severity)}
                        <span className="font-medium text-xs">
                          {getEventTypeDisplayName(event.event_type)}
                        </span>
                      </div>
                    </td>
                    <td className="py-2 px-4 text-xs hidden sm:table-cell">
                      {stripHTML(event.actor_username) || "System"}
                    </td>
                    <td className="py-2 px-4">
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium ${getSeverityColor(
                          event.severity
                        )}`}
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

      <div className="bg-secondary rounded-large-element overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300" style={{ animationDelay: "50ms" }}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/10">
          <Bell size={18} className="text-accent" />
          <h2 className="font-mono font-normal text-primary">Notifications</h2>
        </div>

        <SettingsRow label="Enable Notifications" description="Receive security alerts">
          <button
            onClick={() => handleToggle("notifications_enabled")}
            className={`relative inline-flex h-7 w-12 items-center rounded-pill transition-all duration-300 ease-out focus-visible:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-secondary ${
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

      <div className="bg-secondary rounded-large-element overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300" style={{ animationDelay: "100ms" }}>
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

      <div className="bg-secondary rounded-large-element overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300" style={{ animationDelay: "150ms" }}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/10">
          <Shield size={18} className="text-accent" />
          <h2 className="font-mono font-normal text-primary">Security Tips</h2>
        </div>
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
      </div>

      <div className="h-12 md:h-16" aria-hidden="true"></div>
    </div>
  );
}
