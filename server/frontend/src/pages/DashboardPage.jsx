import { Activity, Users, Cpu, HardDrive, ArrowUpRight } from "lucide-react";
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
import CardHeader from "../components/common/cards/CardHeader";

export default function Dashboard() {
  const morningMessage = useMemo(() => {
    return morningMessages[Math.floor(Math.random() * morningMessages.length)];
  }, []);

  return (
    <main className="bg-primary text-secondary px-0 pt-5 pb-32">
      {/* Header */}
      <header className="max-w-7xl mx-auto mb-10">
        <Card>
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold">
                {morningMessage + "Gabe" /*Replace with name */}
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

        {/* Activity feed */}
        <Card className="flex-1">
          <CardHeader title="Recent Activity" action="View all" />
          <ul className="divide-y divide-secondary/10">
            {[
              "User trafficcone logged in",
              "Backup completed successfully",
              "New app deployed",
              "Settings updated",
            ].map((item, i) => (
              <li key={i} className="py-3 text-sm text-secondary/80">
                {item}
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </main>
  );
}
