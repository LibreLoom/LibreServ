import { Activity, Users, Cpu, HardDrive, ArrowUpRight } from "lucide-react";

import StatCard from "../components/common/cards/StatCard";
import StatusCol from "../components/common/cards/StatusCol";
import Card from "../components/common/cards/Card";
import CardHeader from "../components/common/cards/CardHeader";

export default function Dashboard() {
  return (
    <main className="min-h-screen bg-primary text-secondary px-0 pt-5 pb-32">
      {/* Header */}
      <header className="max-w-7xl mx-auto mb-10">
        <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-secondary/70 mt-1">
          System overview & recent activity
        </p>
        <br />
        <div className="w-5xl h-1 border-t-5 rounded-full mx-auto" />
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
              "User jayden logged in",
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
