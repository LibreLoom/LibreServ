import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Clock, Server, CheckCircle, AlertCircle, XCircle, WifiOff, RefreshCw, Database } from "lucide-react";

import StatCard from "../components/cards/StatCard";
import Page from "../components/ui/Page";
import AppCards from "../components/cards/AppCards";
import DropdownCard from "../components/cards/DropdownCard";
import SystemHealthCard from "../components/cards/SystemHealthCard";
import RefreshDropdown, { REFRESH_INTERVALS } from "../components/common/RefreshDropdown";
import WelcomeCard from "../components/onboarding/WelcomeCard";
import api from "../lib/api";

import { dashboard as greetingMessages } from "../assets/greetings";
import { useUser } from "../hooks/useUser";
import { useUptime } from "../hooks/useUptime";
import { useMonitoring } from "../hooks/useMonitoring";
import { useSystemHealthCheck } from "../hooks/useSystemHealthCheck";
import { useConnectivity, getRemoteAccessStatus } from "../hooks/useConnectivity";

import {
  getBreakdownItems,
  totalResourceUsage,
} from "../utils/resourceUtils";

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
  const { data: uptimeSeconds } = useUptime();
  const [refreshInterval, setRefreshInterval] = useState(getInitialRefreshInterval);
  const { data: resources } = useMonitoring(refreshInterval);
  const {
    data: healthCheck,
    isLoading: healthLoading,
    error: healthError,
  } = useSystemHealthCheck();
  const { data: connectivity } = useConnectivity(30000);
  const navigate = useNavigate();

  // Store server uptime and fetch timestamp for drift-free calculation
  const uptimeDataRef = useRef({ serverUptime: 0, fetchTime: 0 });

  // Calculate display uptime: server uptime + elapsed time since last fetch
  const getDisplayUptime = useCallback(() => {
    const { serverUptime, fetchTime } = uptimeDataRef.current;
    if (fetchTime === 0) return "...";
    const elapsed = (Date.now() - fetchTime) / 1000;
    return formatUptime(Math.floor(serverUptime + elapsed));
  }, []);

  const [displayUptime, setDisplayUptime] = useState(getDisplayUptime);

  // Update stored uptime when API returns new data
  useEffect(() => {
    if (uptimeSeconds == null) return;
    uptimeDataRef.current = {
      serverUptime: uptimeSeconds,
      fetchTime: Date.now(),
    };
    setDisplayUptime(getDisplayUptime());
  }, [uptimeSeconds, getDisplayUptime]);

  useEffect(() => {
    const interval = setInterval(() => {
      setDisplayUptime(getDisplayUptime());
    }, 1000);
    return () => clearInterval(interval);
  }, [getDisplayUptime]);

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

  const [repoStatus, setRepoStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const fetchRepoStatus = async () => {
      try {
        const res = await api("/repos/status");
        if (res.ok && !cancelled) {
          const data = await res.json();
          setRepoStatus(data);
        }
      } catch {
        // Silently ignore - non-critical
      }
    };
    fetchRepoStatus();
    return () => { cancelled = true; };
  }, []);

  const remoteAccessStatus = useMemo(
    () => getRemoteAccessStatus(connectivity),
    [connectivity],
  );

  const StatusIconComponent = useMemo(() => {
    switch (remoteAccessStatus.icon) {
      case "check-circle":
        return CheckCircle;
      case "alert-circle":
        return AlertCircle;
      case "x-circle":
        return XCircle;
      case "wifi-off":
        return WifiOff;
      default:
        return CheckCircle;
    }
  }, [remoteAccessStatus.icon]);

  const greetingBase = greeting.endsWith(", ")
    ? greeting.slice(0, -2)
    : greeting;
  const showUsername = user?.username;
  const greetingTitle = (
    <span className="inline-flex flex-wrap items-center justify-center gap-2">
      <span>{showUsername ? `${greetingBase},` : greetingBase}</span>
      <span
        className={cn(
          "transition-all duration-300 ease-out motion-reduce:transition-none",
          showUsername ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1",
        )}
        aria-hidden={!showUsername}
      >
        {showUsername ? user.username : ""}
      </span>
    </span>
  );
  const statusBadge = (
    <button
      type="button"
      onClick={() => navigate("/settings/network")}
      className="inline-flex items-center gap-2 text-xs md:text-sm font-semibold hover:opacity-80 transition-opacity cursor-pointer"
      title="Click to view remote access settings"
    >
      <StatusIconComponent
        className={cn("w-4 h-4 md:w-5 md:h-5", remoteAccessStatus.className)}
        aria-hidden="true"
      />
      <span>{remoteAccessStatus.text}</span>
    </button>
  );
  const refreshControl = (
    <div className="flex items-center gap-2 text-xs md:text-sm text-primary/70">
      <RefreshCw size={14} className="text-accent" aria-hidden="true" />
      <RefreshDropdown value={refreshInterval} onChange={setRefreshInterval} />
    </div>
  );

  return (
    <Page
      data-slot="dashboard-page"
      title={greetingTitle}
      titleId="dashboard-title"
      padded={false}
      headerClassName="px-8 mb-10"
      headerCardClassName="group"
      leftContent={refreshControl}
      rightContent={statusBadge}
    >

      <section className="px-8 mb-10">
        <WelcomeCard />
        {repoStatus && repoStatus.length > 0 && (
          <div className="mt-3 flex items-center gap-2 text-xs text-secondary/60">
            <Database size={12} className="text-accent" />
            <span>
              App repository: last checked{" "}
              {repoStatus[0].last_pull && repoStatus[0].last_pull !== "0001-01-01T00:00:00Z"
                ? new Date(repoStatus[0].last_pull).toLocaleString(undefined, { timeStyle: "short" })
                : "never"}
            </span>
            <Link to="/settings" className="text-accent hover:text-secondary transition-colors">
              Check now
            </Link>
          </div>
        )}
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
            subtitle="How busy your device is"
            value={resources ? Math.round(stressIndex * 100) + "%" : "Loading..."}
            breakdownItems={stressBreakdown}
            Icon={Server}
          />
          <SystemHealthCard
            checks={healthCheck?.checks}
            overallPass={healthCheck?.overall_pass}
            loading={healthLoading}
            error={healthError}
          />
        </div>

        <div className="flex-1 grid grid-cols-1 xl:grid-cols-3 gap-6 content-start order-2 md:order-1">
          <AppCards refreshInterval={refreshInterval} />
        </div>
      </section>
    </Page>
  );
}
