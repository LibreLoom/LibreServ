import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { Clock, Server, CheckCircle, RefreshCw } from "lucide-react";

import StatCard from "../components/common/cards/StatCard";
import HeaderCard from "../components/common/cards/HeaderCard";
import AppCards from "../components/common/cards/AppCards";
import DropdownCard from "../components/common/cards/DropdownCard";
import RefreshDropdown, { REFRESH_INTERVALS } from "../components/common/RefreshDropdown";

import { dashboard as greetingMessages } from "../assets/greetings";
import api from "../lib/api";

import {
  getBreakdownItems,
  totalResourceUsage,
} from "../data/services";

function getGreeting() {
  const today = new Date();
  const month = today.getMonth();
  const date = today.getDate();

  // Holiday greetings
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

  // Rotating greeting (changes every 12 hours)
  const hoursSinceEpoch = Math.floor(today.getTime() / 43200000);
  return greetingMessages[hoursSinceEpoch % greetingMessages.length];
}

// Format seconds into human-readable uptime string
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

export default function Dashboard() {
  // Memoize so the greeting doesn't change on re-renders.
  const greeting = useMemo(() => getGreeting(), []);
  const [user, setUser] = useState(null);
  const [userLoaded, setUserLoaded] = useState(false);

  // Uptime state
  const [, setUptimeSeconds] = useState(0);
  const [displayUptime, setDisplayUptime] = useState("Loading...");
  const uptimeRef = useRef(0);
  const uptimeIntervalRef = useRef(null);

  // Stress index state
  const [stressIndex, setStressIndex] = useState(0);
  const [stressLoaded, setStressLoaded] = useState(false);
  const [stressBreakdown, setStressBreakdown] = useState([]);
  const [refreshInterval, setRefreshInterval] = useState(getInitialRefreshInterval);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  // Fetch user data
  useEffect(() => {
    const fetchUser = async () => {
      try {
        const response = await api("/auth/me");
        const userData = await response.json();
        setUser(userData);
      } catch {
        // Silently handle error - user will be shown as not logged in
      } finally {
        setUserLoaded(true);
      }
    };
    fetchUser();
  }, []);

  // Fetch uptime from health endpoint
  const fetchUptime = useCallback(async () => {
    try {
      const response = await fetch("/health");
      if (response.ok) {
        const data = await response.json();
        if (data.uptime_seconds !== undefined) {
          uptimeRef.current = data.uptime_seconds;
          setUptimeSeconds(data.uptime_seconds);
          setDisplayUptime(formatUptime(data.uptime_seconds));
        }
      }
    } catch (err) {
      console.error("Failed to fetch uptime:", err);
    }
  }, []);

  // Initial uptime fetch and setup interval
  useEffect(() => {
    fetchUptime();

    // Set up uptime counter (increments locally every second)
    uptimeIntervalRef.current = setInterval(() => {
      uptimeRef.current += 1;
      setUptimeSeconds(uptimeRef.current);
      setDisplayUptime(formatUptime(uptimeRef.current));
    }, 1000);

    // Refresh from API every minute to stay in sync
    const apiRefreshInterval = setInterval(() => {
      fetchUptime();
    }, 60000);

    return () => {
      if (uptimeIntervalRef.current) {
        clearInterval(uptimeIntervalRef.current);
      }
      clearInterval(apiRefreshInterval);
    };
  }, [fetchUptime]);

  // Fetch stress index data
  const fetchStressData = useCallback(async () => {
    try {
      const response = await api("/monitoring/system");
      const data = await response.json();
      const source = data?.resources;
      if (!source) {
        throw new Error("Missing resources in /monitoring/system response");
      }
      const liveResources = {
        cpu: clamp01(Number(source.cpu)),
        ram: clamp01(Number(source.ram)),
        disk: clamp01(Number(source.disk)),
        net: clamp01(Number(source.net)),
      };

      const stress = totalResourceUsage(liveResources);
      setStressIndex(stress);
      setStressBreakdown(getBreakdownItems(liveResources));
      setStressLoaded(true);
    } catch (err) {
      console.error("Failed to fetch stress data:", err);
    }
  }, []);

  // Fetch stress data on mount and when refresh interval changes
  useEffect(() => {
    fetchStressData();

    const interval = setInterval(() => {
      fetchStressData();
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [fetchStressData, refreshInterval]);

  // Refetch on bfcache restore so stale values don't linger until interval tick.
  useEffect(() => {
    const onPageShow = () => {
      fetchStressData();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [fetchStressData]);

  // Persist user-selected refresh interval.
  useEffect(() => {
    window.localStorage.setItem(REFRESH_INTERVAL_STORAGE_KEY, String(refreshInterval));
  }, [refreshInterval]);

  // Calculate overall system status
  const systemStatus = useMemo(() => {
    return {
      status: "online",
      text: "All Systems Operational",
      icon: CheckCircle,
      className: "text-accent",
    };
  }, []);
  const greetingBase = greeting.endsWith(", ")
    ? greeting.slice(0, -2)
    : greeting;
  const showUsername = userLoaded && user?.username;
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
      <RefreshDropdown value={refreshInterval} onChange={setRefreshInterval} onOpenChange={setIsDropdownOpen} />
    </div>
  );

  return (
    <main
      className="bg-primary text-secondary px-0 pt-5 pb-32"
      aria-labelledby="dashboard-title"
      id="main-content"
      tabIndex={-1}
    >
      {/* Header */}
      <header className="px-8 mb-10">
        <HeaderCard
          id="dashboard-title"
          title={greetingTitle}
          className="group"
          leftContent={refreshControl}
          rightContent={statusBadge}
        ></HeaderCard>
      </header>

      {/* Main content */}
      <section
        className="flex flex-col md:flex-row gap-8 px-8 w-full"
        aria-label="Dashboard metrics"
      >
        {/* Stats column */}
        <div className="grid grid-cols-1 gap-6 flex-1 content-start order-1 md:order-0">
          <StatCard
            icon={Clock}
            label="Uptime"
            value={displayUptime}
            delta=""
          />
          <DropdownCard
            title="Server Stress Index"
            value={stressLoaded ? Math.round(stressIndex * 100) + "%" : "Loading..."}
            breakdownItems={stressBreakdown}
            Icon={Server}
            forceHover={isDropdownOpen}
          />
        </div>

        {/* Apps */}
        <div className="flex-1 grid grid-cols-1 xl:grid-cols-3 gap-6 content-start order-2 md:order-1">
          <AppCards refreshInterval={refreshInterval} />
        </div>
      </section>
    </main>
  );
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
