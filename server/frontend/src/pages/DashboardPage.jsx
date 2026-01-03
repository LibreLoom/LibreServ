import { useMemo, useState, useEffect } from "react";
import {
  Clock,
  Server,
  EllipsisVertical,
  Circle,
  X,
  AlertTriangle,
} from "lucide-react";

import StatCard from "../components/common/cards/StatCard";
import Card from "../components/common/cards/Card";
import ServiceCards from "../components/common/cards/ServiceCards";
import DropdownCard from "../components/common/cards/DropdownCard";

import { dashboard as greetingMessages } from "../assets/greetings";

import { Link } from "react-router-dom";
import api from "../lib/api";

import {
  resources,
  getBreakdownItems,
  totalResourceUsage,
  services,
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

export default function Dashboard() {
  // Memoize so the greeting doesn't change on re-renders.
  const greeting = useMemo(() => getGreeting(), []);
  const [user, setUser] = useState(null);

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const response = await api("/auth/me");
        const userData = await response.json();
        setUser(userData);
      } catch (err) {
        console.error("Failed to fetch user:", err);
      }
    };
    fetchUser();
  }, []);

  // Calculate overall system status
  const systemStatus = useMemo(() => {
    const hasOffline = services.some((s) => s.status === "offline");
    const hasWarning = services.some((s) => s.status === "warning");

    if (hasOffline) {
      return {
        status: "offline",
        text: "Some Services Offline",
        icon: X,
        className: "text-accent",
      };
    } else if (hasWarning) {
      return {
        status: "warning",
        text: "Some Services Have Warnings",
        icon: AlertTriangle,
        className: "text-accent",
      };
    } else {
      return {
        status: "online",
        text: "All Systems Operational",
        icon: Circle,
        className: "fill-accent text-accent",
      };
    }
  }, []);

  return (
    <main
      className="bg-primary text-secondary px-0 pt-5 pb-32"
      aria-labelledby="dashboard-title"
      id="main-content"
      tabIndex={-1}
    >
      {/* Header */}
      <header className="px-8 mb-10">
        <Card className="group">
          <div className="flex justify-between items-center">
            <div>
              <h1 id="dashboard-title" className="text-2xl font-bold">
                {greeting + (user?.username || "User")}
              </h1>
            </div>
            <div className="flex items-center gap-4">
              <systemStatus.icon
                className={`w-6 h-6 -mr-3 ${systemStatus.className}`}
              />
              <span className="text-sm font-semibold">{systemStatus.text}</span>
              <Link to="/lore" aria-label="Open lore page">
                <EllipsisVertical
                  className="cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity duration-500 text-accent"
                  aria-hidden="true"
                />
              </Link>
            </div>
          </div>
        </Card>
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
            value="41 days 67 hours"
            delta=""
          />
          <DropdownCard
            title="Server Stress Index"
            value={Math.round(totalResourceUsage(resources) * 100) + "%"}
            subtitle=""
            breakdownItems={getBreakdownItems(resources)}
            Icon={Server}
          />
        </div>

        {/* Services */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 content-start order-2 md:order-o">
          {ServiceCards()}
        </div>
      </section>
    </main>
  );
}
