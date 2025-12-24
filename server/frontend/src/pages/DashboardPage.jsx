import {
  Activity,
  Users,
  Cpu,
  HardDrive,
  Database,
  Globe,
  Shield,
  Server,
  Search,
  Cloud,
  Code,
  MessageSquareMore,
  Link,
} from "lucide-react";
import { useMemo } from "react";

const morningMessages = [
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

import StatCard from "../components/common/cards/StatCard";
import StatusCol from "../components/common/cards/StatusCol";
import Card from "../components/common/cards/Card";
import CardButton from "../components/common/cards/CardButton";
import ServiceStatusCard from "../components/common/cards/ServiceStatusCard";

export default function Dashboard() {
  const greeting = useMemo(() => {
    const today = new Date();
    const month = today.getMonth();
    const date = today.getDate();

    // Holiday greetings
    if (month === 0 && date === 1) return "Happy New Year, ";
    if (month === 1 && date === 10) return "Happy Lunar New Year, ";
    if (month === 2 && date === 8) return "Happy International Women's Day, ";
    if (month === 2 && date === 21) return "Happy Nowruz, ";
    if (month === 3 && date === 22) return "Happy Earth Day, ";
    if (month === 4 && date === 1) return "Happy Labour Day, ";
    if (month === 5 && date === 19) return "Happy Juneteenth, ";
    if (month === 9 && date === 31) return "Happy Halloween, ";
    if (month === 10 && date === 1) return "Happy Diwali, ";
    if (month === 11 && date === 25) return "Merry Christmas, ";
    if (month === 11 && date === 26) return "Happy Kwanzaa, ";

    const hoursSinceEpoch = Math.floor(today.getTime() / 43200000);
    return morningMessages[hoursSinceEpoch % morningMessages.length];
  }, []);
  return (
    <main className="bg-primary text-secondary px-0 pt-5 pb-32">
      {/* Header */}
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
        <div className="h-1 border-t-5 rounded-full mx-auto w-[90%]" />
      </header>

      {/* Main grid */}
      <section className="flex gap-6 pl-6">
        {/* Stat cards */}
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

        <div className="w-1 h-128 bg-secondary my-auto rounded-full shrink-0" />

        {/* Service Status */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4 content-start">
          <ServiceStatusCard
            icon={Search}
            name="SearXNG"
            status="online"
            time="14 days, 3 hours"
            resourceUsage={10}
          />
          <ServiceStatusCard
            icon={Cloud}
            name="Nextcloud"
            status="online"
            detail="441 ms"
            time="2 hours, 15 minutes"
            resourceUsage={80}
          />
          <ServiceStatusCard
            icon={Code}
            name="N8N"
            status="warning"
            detail="807 ms"
            warningMessage="High latency detected"
            resourceUsage={40}
          />
          <ServiceStatusCard
            icon={MessageSquareMore}
            name="IRC"
            status="offline"
            detail="Mumble IRC"
            time="1 hour, 30 minutes"
            resourceUsage={0}
          />
        </div>
      </section>
    </main>
  );
}
