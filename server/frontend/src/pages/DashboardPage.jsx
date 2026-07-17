import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";

import UptimeCard from "../components/cards/UptimeCard";
import Page from "../components/ui/Page";
import AppCards from "../components/cards/AppCards";
import StressIndexCard from "../components/cards/StressIndexCard";
import CriticalIssues from "../components/common/CriticalIssues";
import InstallFirstAppCard from "../components/onboarding/InstallFirstAppCard";

import { dashboard as greetingMessages } from "../assets/greetings";
import { useUser } from "../hooks/useUser";
import { useUptime } from "../hooks/useUptime";
import { useMonitoring } from "../hooks/useMonitoring";

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
  const { data: resources } = useMonitoring();

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

  return (
    <Page
      data-slot="dashboard-page"
      title={greetingTitle}
      titleId="dashboard-title"
      padded={false}
      headerClassName="px-8 mb-10"
      headerCardClassName="group"
      rightContent={<CriticalIssues />}
    >
      <section className="px-8 mb-10">
        <InstallFirstAppCard />
      </section>

      <section
        className="flex flex-col md:flex-row gap-8 px-8 w-full"
        aria-label="Dashboard metrics"
      >
        <div className="grid grid-cols-1 gap-6 flex-1 content-start order-1 md:order-0">
          <UptimeCard value={displayUptime} />
          <StressIndexCard
            value={resources ? Math.round(stressIndex * 100) + "%" : "Loading..."}
            breakdownItems={stressBreakdown}
          />
        </div>

        <div className="flex-1 grid grid-cols-1 xl:grid-cols-2 gap-6 content-start order-2 md:order-1">
          <AppCards />
        </div>
      </section>
    </Page>
  );
}
