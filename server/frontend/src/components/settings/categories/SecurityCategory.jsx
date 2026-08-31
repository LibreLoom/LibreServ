import { cn } from "@/lib/utils";
import { useState, useEffect, memo } from "react";
import {
  Check,
  Shield,
  Activity,
  AlertTriangle,
  RefreshCw,
  Filter,
} from "lucide-react";
import Toggle from "../../common/Toggle";
import RadioOptionGroup from "../../common/RadioOptionGroup";
import CheckboxOptionGroup from "../../common/CheckboxOptionGroup";
import Dropdown from "../../common/Dropdown";
import Table from "../../common/Table";
import Pill from "../../common/Pill";
import Button from "../../ui/Button";
import TypewriterLoader from "../../ui/TypewriterLoader";
import SettingsCard from "../SettingsCard";
import { useToast } from "../../../context/ToastContext";
import {
  getSecurityEvents,
  getEventTypeDisplayName,
  formatTimestamp,
} from "../../../lib/security-api.js";
import { stripHTML } from "../../../lib/sanitize.js";
import { useTimeFormat } from "../../../hooks/useTimeFormat.jsx";

const SEVERITY_PILL_VARIANT = {
  info: "default",
  warning: "warning",
  critical: "error",
};

// Module-scope so the memoized filter dropdown sees a stable `options`
// reference across renders (a fresh array literal would defeat React.memo).
const ACTIVITY_FILTER_OPTIONS = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "all", label: "All" },
];

// Memoized so refreshing the activity log (which re-renders the card with
// new loading/data state) never re-renders the dropdown itself — the reload
// only affects the log. The dropdown's open/close and width animations are
// therefore never interrupted by a reload.
function ActivityFilterDropdown({ value, onChange }) {
  return (
    <Dropdown
      value={value}
      onChange={onChange}
      bg="primary"
      options={ACTIVITY_FILTER_OPTIONS}
    />
  );
}

const ActivityFilterDropdownMemo = memo(ActivityFilterDropdown);

function getActivityColumns(use12HourTime) {
  return [
    {
      key: "timestamp",
      label: "Time",
      render: (row) => <Pill variant="muted">{formatTimestamp(row.timestamp, use12HourTime)}</Pill>,
    },
    {
      key: "event_type",
      label: "Event",
      render: (row) => (
        <Pill>
          {getSeverityIcon(row.severity)}
          <span className="font-medium truncate">{getEventTypeDisplayName(row.event_type)}</span>
        </Pill>
      ),
    },
    {
      key: "actor_username",
      label: "User",
      hidden: "sm",
      render: (row) => <Pill>{stripHTML(row.actor_username) || "System"}</Pill>,
    },
    {
      key: "severity",
      label: "Severity",
      render: (row) => <Pill variant={SEVERITY_PILL_VARIANT[row.severity] || "default"} className="font-medium">{row.severity}</Pill>,
    },
  ];
}

function getSeverityIcon(severity) {
  switch (severity) {
    case "critical":
      return <AlertTriangle size={12} className="text-error" />;
    case "warning":
      return <AlertTriangle size={12} className="text-warning" />;
    default:
      return <Check size={12} className="text-accent" />;
  }
}

export default function SecurityCategory() {
  const { addToast } = useToast();
  const { use12HourTime } = useTimeFormat();
  const activityColumns = getActivityColumns(use12HourTime);

  const [events, setEvents] = useState([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [filter, setFilter] = useState("7d");
  const [lastUpdated, setLastUpdated] = useState(null);

  useEffect(() => {
    loadActivityData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

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

      setEvents(rawEvents);
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

  return (
    <div className="space-y-4" data-slot="security-category">
      <SettingsCard
        icon={Activity}
        title="Activity Log"
        padding={false}
        index={0}
        headerActions={
            <div className="flex items-center gap-3">
              <ActivityFilterDropdownMemo value={filter} onChange={setFilter} />
            {lastUpdated && (
              <span className="text-xs text-accent hidden sm:inline">
                {formatTimestamp(lastUpdated.toISOString(), use12HourTime)}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              surface="primary"
              onClick={loadActivityData}
              disabled={activityLoading}
              aria-label="Refresh activity log"
            >
              <RefreshCw size={14} className={cn("text-accent", activityLoading && "animate-spin")} aria-hidden="true" />
            </Button>
          </div>
        }
      >
        <div className="px-4 pb-4 pt-3">
          {events.length === 0 && activityLoading ? (
            <div className="flex justify-center items-center py-12">
              <TypewriterLoader size="md" />
            </div>
          ) : events.length === 0 ? (
            <div className="text-center py-12">
              <Shield size={40} className="mx-auto text-accent/30 mb-3" />
              <p className="text-sm text-accent">No security events found</p>
            </div>
          ) : (
            // Reloads keep the current table mounted (stale-while-revalidate)
            // so the log never blanks out — it just dims briefly while the new
            // rows come in. The full loader only appears when there is no data
            // to preserve (first load).
            <div
              className={cn("motion-safe:transition-opacity motion-safe:duration-200", activityLoading && "opacity-60")}
              aria-busy={activityLoading}
            >
              <Table
                columns={activityColumns}
                data={events}
                rowKey="id"
                scrollable
                maxHeight="24rem"
                headClassName="text-primary"
              />
            </div>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}
