import {
  Activity,
  Users,
  Cpu,
  HardDrive,
  Search,
  Cloud,
  Code,
  MessageSquareMore,
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
    name: "Mumble IRC",
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
      <header className="max-w-7xl mx-auto mb-10">
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
        <br />
        {/* Decorative divider line */}
        <div className="h-1 border-t-5 rounded-full mx-auto w-[90%]" />
      </header>

      {/* Main grid section containing stats and service status */}
      <section className="flex gap-6 pl-6">
        {/* Stat cards - displays key metrics and system statistics */}
        <div className="grid grid-cols-1 gap-6 shrink-0">
          <StatCard
            icon={Users}
            label="Active Users"
            value="1,284"
            delta="+4.2%"
          />
          <StatCard icon={Cpu} label="CPU Usage" value="38%" delta="-1.1%" />
          <StatCard
            icon={HardDrive}
            label="Storage Used"
            value="412 GB"
            delta="+12 GB"
          />
          <StatCard
            icon={Activity}
            label="Requests / min"
            value="9,421"
            delta="+8.9%"
          />
        </div>

        {/* Vertical divider line separating stat cards from service status */}
        <div className="w-1 h-128 bg-secondary my-auto rounded-full shrink-0" />

        {/* Service Status - displays status of various services and their metrics */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4 content-start">
          {ServiceCards()}
        </div>
      </section>
    </main>
  );
}
