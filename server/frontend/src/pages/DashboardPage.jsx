import {
  Activity,
  Users,
  Cpu,
  HardDrive,
  Search,
  Cloud,
  Code,
  MessageSquareMore,
  ChevronUp,
  Wifi,
  Zap,
  MemoryStick,
} from "lucide-react";
import { useMemo } from "react";

// Array of casual greeting messages to display on the dashboard
const greetingMessages = [
  "Good day, ",
  "Welcome Back, ",
  "Hello, ",
  "Hi, ",
  "Greetings, ",
  "Salutations, ",
  "Howdy, ",
  "What's up, ",
  "What's cooking, ",
  "Hello there, ",
  "Welcome, ",
  "Welcome back to your daily dose of server, ",
  "Enjoy your day, ",
  "Hey, ",
  "Hiay, ",
  "Happy to see you, ",
];

const services = [
  {
    name: "SearXNG",
    status: "warning",
    time: "14 days, 3 hours",
    warningMessage: "High latency detected",
    resourceUsage: 10,
    icon: Search,
  },
  {
    name: "Nextcloud",
    status: "online",
    time: "14 days, 3 hours",
    resourceUsage: 60,
    icon: Cloud,
  },
  {
    name: "Convertx",
    status: "offline",
    time: "14 days, 3 hours",
    resourceUsage: 3,
    icon: MessageSquareMore,
  },
];

function ServiceCards() {
  return services.map((service) => (
    <ServiceStatusCard
      key={service.name}
      icon={service.icon}
      name={service.name}
      status={service.status}
      time={service.time}
      resourceUsage={service.resourceUsage}
      warningMessage={service.warningMessage}
    />
  ));
}

import StatCard from "../components/common/cards/StatCard";
import Card from "../components/common/cards/Card";
import ServiceStatusCard from "../components/common/cards/ServiceStatusCard";
import DropdownCard from "../components/common/cards/DropdownCard";

export default function Dashboard() {
  // Memoized greeting that selects a message based on holidays or time of day
  const greeting = useMemo(() => {
    const today = new Date();
    const month = today.getMonth();
    const date = today.getDate();

    // Holiday greetings - checks for specific dates
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

    // Calculate hours since epoch for rotating greeting selection
    // 43200000 ms = 12 hours, so greeting changes every 12 hours
    const hoursSinceEpoch = Math.floor(today.getTime() / 43200000);
    return greetingMessages[hoursSinceEpoch % greetingMessages.length];
  }, []);

  return (
    <main className="bg-primary text-secondary px-0 pt-5 pb-32">
      {/* Header section containing the greeting and user information */}
      <header className="w-[95%] mx-auto mb-10">
        <Card>
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold">
                {greeting + "Gabe" /*Replace with name */}
              </h1>
            </div>
            <div className="text-right">
              <p className="font-medium">{/*Stat average*/}</p>
            </div>
          </div>
        </Card>
      </header>

      {/* Decorative divider line */}
      <div className="h-1 w-[95%] rounded-full mx-auto bg-secondary -mt-8 mb-2" />

      {/* Main grid section containing stats and service status */}
      <section className="flex gap-8 px-8 w-full">
        {/* Stat cards - displays key metrics and system statistics */}
        <div className="grid grid-cols-1 gap-6 flex-1 content-start">
          <StatCard
            icon={ChevronUp}
            label="Uptime"
            value="41 days 67 hours"
            delta=""
          />
          <DropdownCard
            title="Server Stress Index"
            value="42%"
            subtitle=""
            breakdownItems={[
              { icon: Cpu, label: "CPU", value: "35%" },
              { icon: MemoryStick, label: "RAM", value: "60%" },
              { icon: HardDrive, label: "Disk", value: "25%" },
              { icon: Wifi, label: "Network", value: "40%" },
              { icon: Zap, label: "Energy", value: "50%" },
            ]}
          />
        </div>

        {/* Vertical divider line separating stat cards from service status */}
        <div className="w-1 h-128 bg-secondary my-auto rounded-full shrink-0" />

        {/* Service Status - displays status of various services and their metrics */}
        <div className="w-[65%] grid grid-cols-1 lg:grid-cols-3 gap-6 content-start shrink-0">
          {ServiceCards()}
        </div>
      </section>
    </main>
  );
}
