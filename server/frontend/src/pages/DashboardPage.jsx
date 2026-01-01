import { useMemo } from "react";
import { Clock, Server } from "lucide-react";

import StatCard from "../components/common/cards/StatCard";
import Card from "../components/common/cards/Card";
import ServiceCards from "../components/common/cards/ServiceCards";
import DropdownCard from "../components/common/cards/DropdownCard";

import { dashboard as greetingMessages } from "../assets/greetings";

import {
  resources,
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

export default function Dashboard() {
  // Memoize so the greeting doesn't change on re-renders.
  const greeting = useMemo(() => getGreeting(), []);

  return (
    <main
      className="bg-primary text-secondary px-0 pt-5 pb-32"
      aria-labelledby="dashboard-title"
    >
      {/* Header */}
      <header className="px-8 mb-10">
        <Card>
          <div className="flex justify-between items-center">
            <div>
              <h1 id="dashboard-title" className="text-2xl font-bold">
                {greeting + "Gabe" /* TODO: Replace with user name */}
              </h1>
            </div>
            <div className="text-right">
              <p className="font-medium">{/* TODO: Stat average */}</p>
            </div>
          </div>
        </Card>
      </header>

      {/* Main content */}
      <section className="flex gap-8 px-8 w-full">
        {/* Stats column */}
        <div className="grid grid-cols-1 gap-6 flex-1 content-start">
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
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 content-start">
          {ServiceCards()}
        </div>
      </section>
    </main>
  );
}
