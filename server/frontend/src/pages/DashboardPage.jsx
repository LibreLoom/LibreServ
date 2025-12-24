import { useMemo } from "react";
import {
  Cpu,
  HardDrive,
  Search,
  Cloud,
  Wifi,
  Zap,
  MemoryStick,
  FileSliders,
  Clock,
} from "lucide-react";

import StatCard from "../components/common/cards/StatCard";
import Card from "../components/common/cards/Card";
import ServiceStatusCard from "../components/common/cards/ServiceStatusCard";
import DropdownCard from "../components/common/cards/DropdownCard";

// Greeting messages for the dashboard header
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

// Mock data - TODO: Replace with API calls
const resources = {
  cpu: 0.35,
  ram: 0.6,
  disk: 0.25,
  net: 0.4,
  energy: 0.5,
};

const services = [
  {
    name: "SearXNG",
    status: "warning",
    time: "14 days, 3 hours",
    warningMessage: "High latency detected",
    resourceUsage: 10,
    icon: Search,
    resources: {
      cpu: 0.35,
      ram: 0.6,
      disk: 0.25,
      net: 0.4,
      energy: 0.5,
    },
  },
  {
    name: "Nextcloud",
    status: "online",
    time: "14 days, 3 hours",
    resourceUsage: 60,
    icon: Cloud,
    resources: {
      cpu: 0.45,
      ram: 0.7,
      disk: 0.55,
      net: 0.3,
      energy: 0.4,
    },
  },
  {
    name: "Convertx",
    status: "offline",
    time: "14 days, 3 hours",
    resourceUsage: 3,
    icon: FileSliders,
    resources: {
      cpu: 0.02,
      ram: 0.05,
      disk: 0.01,
      net: 0.0,
      energy: 0.03,
    },
  },
];

// Helper functions
function totalResourceUsage({ cpu, ram, disk, net }) {
  const weights = { cpu: 0.3, ram: 0.25, disk: 0.2, net: 0.15 };
  return (
    cpu * weights.cpu +
    ram * weights.ram +
    disk * weights.disk +
    net * weights.net
  );
}

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

  // Rotating greeting (changes every 12 hours)
  const hoursSinceEpoch = Math.floor(today.getTime() / 43200000);
  return greetingMessages[hoursSinceEpoch % greetingMessages.length];
}

// Components
function getBreakdownItems(resources) {
  if (!resources) return [];
  return [
    { icon: Cpu, label: "CPU", value: Math.round(resources.cpu * 100) + "%" },
    {
      icon: MemoryStick,
      label: "RAM",
      value: Math.round(resources.ram * 100) + "%",
    },
    {
      icon: HardDrive,
      label: "Disk",
      value: Math.round(resources.disk * 100) + "%",
    },
    {
      icon: Wifi,
      label: "Network",
      value: Math.round(resources.net * 100) + "%",
    },
    {
      icon: Zap,
      label: "Energy",
      value: Math.round(resources.energy * 100) + "%",
    },
  ];
}

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
      breakdownItems={getBreakdownItems(service.resources)}
    />
  ));
}

export default function Dashboard() {
  const greeting = useMemo(() => getGreeting(), []);

  return (
    <main className="bg-primary text-secondary px-0 pt-5 pb-32">
      {/* Header */}
      <header className="w-[95%] mx-auto mb-10">
        <Card>
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold">
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
          />
        </div>

        {/* Services column */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 content-start">
          {ServiceCards()}
        </div>
      </section>
    </main>
  );
}
