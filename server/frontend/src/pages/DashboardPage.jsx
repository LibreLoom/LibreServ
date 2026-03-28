import { useMemo, useState, useEffect, useRef } from "react";
import { Clock, Server, CheckCircle, RefreshCw } from "lucide-react";

import StatCard from "../components/cards/StatCard";
import HeaderCard from "../components/cards/HeaderCard";
import AppCards from "../components/cards/AppCards";
import DropdownCard from "../components/cards/DropdownCard";
import RefreshDropdown, { REFRESH_INTERVALS } from "../components/ui/RefreshDropdown";
import WelcomeCard from "../components/onboarding/WelcomeCard";

import { dashboard as greetingMessages } from "../assets/greetings";
import { useUser } from "../hooks/useUser";
import { useUptime } from "../hooks/useUptime";
import { useMonitoring } from "../hooks/useMonitoring";

import {
  getBreakdownItems,
  totalResourceUsage,
} from "../data/services";

function getGreeting() {
  const today = new Date();
  const month = today.getMonth();
  const date = today.getDate();

  if (month === 0 && date === 1) return "Happy New Year, ";
  if (month === 2 && date === 8) return "Happy International Women's Day, ";
  if (month === 2 && date === 21) return "Happy Nowruz, ";
  if (month === 3 && date === 22) return "Happy Earth Day, ";
  if (month === 4 && date === 1) return "Happy Labour Day, ";
  if (month === 5 && date === 19) return "Happy Juneteenth, ";
  if (month === 9 && date === 31) return "Happy Halloween, ";
  if (month === 10 && date === 1) return "Happy Diwali, ";
  if (month === 11 && date === 25) return "Merry Christmas, ";
  if (month === 11 && date === 26) return "Happy Kwanzaa, ";
  if (month === 7 && date === 4) return "Happy Independence Day, ";

  const hoursSinceEpoch = Math.floor(today.getTime() / 43200000);
  return greetingMessages[hoursSinceEpoch % greetingMessages.length];
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days} day${days !== 1 ? "s" : ""}`);
  if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? "s" : ""}`);
  if (minutes > 0 && days === 0) parts.push(`${minutes} min${minutes !== 1 ? "s" : ""}`);
  if (days === 0 && hours === 0 && secs > 0) parts.push(`${secs} sec${secs !== 1 ? "s" : ""}`);

  return parts.join(" ") || "0 secs";
}

const REFRESH_INTERVAL_STORAGE_KEY = "dashboard_stress_refresh_interval_ms";

function isValidRefreshInterval(value) {
  return REFRESH_INTERVALS.some((interval) => interval.value === value);
}

function getInitialRefreshInterval() {
  if (typeof window === "undefined") return 30000;
  const raw = window.localStorage.getItem(REFRESH_INTERVAL_STORAGE_KEY);
  const parsed = Number(raw);
  return isValidRefreshInterval(parsed) ? parsed : 30000;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export default function Dashboard() {
  const greeting = useMemo(() => getGreeting(), []);
  const { data: user } = useUser();
  const { data: uptimeSeconds = 0 } = useUptime();
  const [refreshInterval, setRefreshInterval] = useState(getInitialRefreshInterval);
  const { data: resources } = useMonitoring(refreshInterval);

  // Local uptime counter for smooth display between API syncs
  const uptimeRef = useRef(uptimeSeconds);

  // Sync ref when API provides new value
  useEffect(() => {
    uptimeRef.current = uptimeSeconds;
  }, [uptimeSeconds]);

  // Increment local counter every second
  const [displayUptime, setDisplayUptime] = useState(formatUptime(uptimeSeconds));
  useEffect(() => {
    const interval = setInterval(() => {
      uptimeRef.current += 1;
      setDisplayUptime(formatUptime(uptimeRef.current));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Persist user-selected refresh interval
  useEffect(() => {
    window.localStorage.setItem(REFRESH_INTERVAL_STORAGE_KEY, String(refreshInterval));
  }, [refreshInterval]);

  const stressIndex = useMemo(() => {
    if (!resources) return 0;
    return totalResourceUsage({
      cpu: clamp01(Number(resources.cpu)),
      ram: clamp01(Number(resources.ram)),
      disk: clamp01(Number(resources.disk)),
      net: clamp01(Number(resources.net)),
    });
  }, [resources]);

  const stressBreakdown = useMemo(() => {
    if (!resources) return [];
    return getBreakdownItems({
      cpu: clamp01(Number(resources.cpu)),
      ram: clamp01(Number(resources.ram)),
      disk: clamp01(Number(resources.disk)),
      net: clamp01(Number(resources.net)),
    });
  }, [resources]);

  const systemStatus = useMemo(
    () => ({
      status: "online",
      text: "All Systems Operational",
      icon: CheckCircle,
      className: "text-accent",
    }),
    [],
  );

  const greetingBase = greeting.endsWith(", ")
    ? greeting.slice(0, -2)
    : greeting;
  const showUsername = user?.username;
  const StatusIcon = systemStatus.icon;
  const greetingTitle = (
    <span className="inline-flex flex-wrap items-center justify-center gap-2">
      <span>{showUsername ? `${greetingBase},` : greetingBase}</span>
      <span
        className={`transition-all duration-300 ease-out ${
          showUsername ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"
        } motion-reduce:transition-none`}
        aria-hidden={!showUsername}
      >
        {showUsername ? user.username : ""}
      </span>
    </span>
  );
  const statusBadge = (
    <span className="inline-flex items-center gap-2 text-xs md:text-sm font-semibold">
      <StatusIcon
        className={`w-4 h-4 md:w-5 md:h-5 ${systemStatus.className}`}
        aria-hidden="true"
      />
      <span>{systemStatus.text}</span>
    </span>
  );
  const refreshControl = (
    <div className="flex items-center gap-2 text-xs md:text-sm text-secondary/70">
      <RefreshCw size={14} className="text-accent" aria-hidden="true" />
      <RefreshDropdown value={refreshInterval} onChange={setRefreshInterval} />
    </div>
  );

  return (
    <main
      className="bg-primary text-secondary px-0 pt-5 pb-32"
      aria-labelledby="dashboard-title"
      id="main-content"
      tabIndex={-1}
    >
      <header className="px-8 mb-10">
        <HeaderCard
          id="dashboard-title"
          title={greetingTitle}
          className="group"
          leftContent={refreshControl}
          rightContent={statusBadge}
        ></HeaderCard>
      </header>

      <section className="px-8 mb-10">
        <WelcomeCard />
      </section>

      <section
        className="flex flex-col md:flex-row gap-8 px-8 w-full"
        aria-label="Dashboard metrics"
      >
        <div className="grid grid-cols-1 gap-6 flex-1 content-start order-1 md:order-0">
          <StatCard
            icon={Clock}
            label="Uptime"
            value={displayUptime}
            delta=""
          />
          <DropdownCard
            title="Server Stress Index"
            value={resources ? Math.round(stressIndex * 100) + "%" : "Loading..."}
            breakdownItems={stressBreakdown}
            Icon={Server}
          />
        </div>

        <div className="flex-1 grid grid-cols-1 xl:grid-cols-3 gap-6 content-start order-2 md:order-1">
          <AppCards refreshInterval={refreshInterval} />
        </div>
      </section>
    </main>
  );
}
