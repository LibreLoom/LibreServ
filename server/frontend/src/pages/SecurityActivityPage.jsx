import React, { useState, useEffect } from "react";
import HeaderCard from "../components/common/cards/HeaderCard";
import Card from "../components/common/cards/Card";
import LoadingSpinner from "../components/common/LoadingSpinner";
import ErrorDisplay from "../components/common/ErrorDisplay";
import {
  getSecurityEvents,
  getSecurityStats,
  getEventTypeDisplayName,
  getSeverityColor,
  formatTimestamp,
} from "../lib/security-api.js";
import { sanitizeEvent, stripHTML } from "../lib/sanitize.js";
import {
  Activity,
  Shield,
  AlertTriangle,
  CheckCircle,
  Filter,
  RefreshCw,
} from "lucide-react";

/**
 * Security activity page component
 * Displays security events, statistics, and activity logs
 * @returns {JSX.Element} Security activity page
 */
export default function SecurityActivityPage() {
  const [events, setEvents] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all");
  const [lastUpdated, setLastUpdated] = useState(null);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  /**
   * Loads security events and statistics from the API
   * @returns {Promise<void>}
   */
  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);

      // Calculate time filter
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
          since.setDate(since.getDate() - 7); // Default to 7 days
      }

      const eventFilters = {
        limit: 100,
      };
      if (since) {
        eventFilters.since = since.toISOString();
      }

      const eventsData = await getSecurityEvents(eventFilters);
      const rawEvents = Array.isArray(eventsData)
        ? eventsData
        : Array.isArray(eventsData?.events)
          ? eventsData.events
          : [];

      // Stats are admin-only; keep activity visible even when stats are unavailable.
      let statsData = null;
      try {
        statsData = await getSecurityStats(
          since ? { since: since.toISOString() } : {},
        );
      } catch (statsErr) {
        const status = statsErr?.cause?.status;
        if (status !== 403) {
          throw statsErr;
        }
      }

      // Sanitize events to prevent XSS attacks
      const sanitizedEvents = rawEvents.map((event) => sanitizeEvent(event));
      setEvents(sanitizedEvents);
      setStats(statsData);
      setLastUpdated(new Date());
    } catch (err) {
      const errorMessage =
        err?.message ||
        err?.response?.data?.message ||
        "Failed to load security activity. Please try again.";
      setError(errorMessage);
      console.error("Error loading security data:", err);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Returns the appropriate icon component based on severity level
   * @param {string} severity - The severity level (critical, warning, info)
   * @returns {JSX.Element} Icon component
   */
  const getSeverityIcon = (severity) => {
    switch (severity) {
      case "critical":
        return <AlertTriangle size={18} className="text-red-500" />;
      case "warning":
        return <AlertTriangle size={18} className="text-yellow-500" />;
      default:
        return <CheckCircle size={18} className="text-blue-500" />;
    }
  };

  return (
    <main
      className="bg-primary text-secondary px-8 pt-5 pb-32"
      aria-labelledby="security-activity-title"
      id="main-content"
      tabIndex={-1}
    >
      <HeaderCard
        id="security-activity-title"
        title="Security Activity"
        subtitle="Monitor security events and account activity"
      />

      {error && (
        <div className="mt-6">
          <ErrorDisplay message={error} />
        </div>
      )}

      {/* Stats Overview */}
      {!loading && stats && (
        <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="text-center">
            <div className="text-3xl font-bold text-blue-600">
              {stats.total_events}
            </div>
            <div className="text-sm text-accent mt-1">Total Events</div>
          </Card>
          <Card className="text-center">
            <div className="text-3xl font-bold text-green-600">
              {stats.successful_logins}
            </div>
            <div className="text-sm text-accent mt-1">Successful Logins</div>
          </Card>
          <Card className="text-center">
            <div className="text-3xl font-bold text-yellow-600">
              {stats.failed_logins}
            </div>
            <div className="text-sm text-accent mt-1">Failed Attempts</div>
          </Card>
          <Card className="text-center">
            <div className="text-3xl font-bold text-red-600">
              {stats.critical_events}
            </div>
            <div className="text-sm text-accent mt-1">Critical Events</div>
          </Card>
        </div>
      )}

      {/* Filters and Actions */}
      <div className="mt-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex items-center gap-2">
          <Filter size={18} className="text-accent" />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="px-3 py-2 border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All time</option>
          </select>
        </div>

        <div className="flex items-center gap-4">
          {lastUpdated && (
            <span className="text-sm text-accent">
              Last updated: {formatTimestamp(lastUpdated.toISOString())}
            </span>
          )}
          <button
            onClick={loadData}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 border rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {/* Activity Log */}
      <Card className="mt-6" title="Activity Log" icon={<Activity size={20} />}>
        {loading ? (
          <div className="flex justify-center items-center py-12">
            <LoadingSpinner size="lg" />
          </div>
        ) : events.length === 0 ? (
          <div className="text-center py-12">
            <Shield size={48} className="mx-auto text-gray-300 mb-4" />
            <h3 className="text-lg font-medium text-secondary">
              No security events found
            </h3>
            <p className="text-accent mt-2">
              No security activity has been recorded in the selected time
              period.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-3 px-4 font-medium text-accent">
                    Time
                  </th>
                  <th className="text-left py-3 px-4 font-medium text-accent">
                    Event
                  </th>
                  <th className="text-left py-3 px-4 font-medium text-accent">
                    User
                  </th>
                  <th className="text-left py-3 px-4 font-medium text-accent">
                    Severity
                  </th>
                  <th className="text-left py-3 px-4 font-medium text-accent">
                    Details
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {events.map((event) => (
                  <tr
                    key={event.id}
                    className="hover:bg-gray-50 transition-colors"
                  >
                    <td className="py-3 px-4 text-sm whitespace-nowrap">
                      {formatTimestamp(event.timestamp)}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        {getSeverityIcon(event.severity)}
                        <span className="font-medium">
                          {getEventTypeDisplayName(event.event_type)}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-sm">
                      {stripHTML(event.actor_username) || "System"}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${getSeverityColor(
                          event.severity,
                        )}`}
                      >
                        {event.severity}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-sm text-accent max-w-md truncate">
                      {stripHTML(event.details)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Security Tips */}
      <Card className="mt-6" title="Security Tips" icon={<Shield size={20} />}>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="p-4 bg-blue-50 rounded-lg">
            <h4 className="font-medium text-blue-900 mb-2">
              Use a Strong Password
            </h4>
            <p className="text-sm text-blue-700">
              Use a unique, strong password for your LibreServ account. Consider
              using a password manager.
            </p>
          </div>
          <div className="p-4 bg-green-50 rounded-lg">
            <h4 className="font-medium text-green-900 mb-2">
              Monitor Your Account
            </h4>
            <p className="text-sm text-green-700">
              Regularly review your security activity log to ensure there are no
              unauthorized access attempts.
            </p>
          </div>
          <div className="p-4 bg-yellow-50 rounded-lg">
            <h4 className="font-medium text-yellow-900 mb-2">
              Enable Notifications
            </h4>
            <p className="text-sm text-yellow-700">
              Turn on security notifications to stay informed about important
              account activity.
            </p>
          </div>
          <div className="p-4 bg-purple-50 rounded-lg">
            <h4 className="font-medium text-purple-900 mb-2">
              Keep Software Updated
            </h4>
            <p className="text-sm text-purple-700">
              Ensure your LibreServ and all installed apps are kept up to date
              with the latest security patches.
            </p>
          </div>
        </div>
      </Card>
    </main>
  );
}

SecurityActivityPage.propTypes = {};
