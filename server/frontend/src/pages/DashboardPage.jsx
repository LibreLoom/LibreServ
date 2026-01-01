import { useMemo } from "react";
import { Clock, Server } from "lucide-react";

import StatCard from "../components/common/cards/StatCard";
import Card from "../components/common/cards/Card";
import ServiceCards from "../components/common/cards/ServiceCards";
import DropdownCard from "../components/common/cards/DropdownCard";

import {
  resources,
  getBreakdownItems,
  totalResourceUsage,
} from "../data/services";

const greetingMessages = [
  "Welcome back. The pigeon is managing operations and snacks, ",
  "Hi there. The mouse intern arrived early and looks determined, ",
  "Hello! The pigeon says today is ‘under control’, ",
  "Welcome! Snack inventory is stable and morale is high, ",
  "Hey there. The seagull was spotted but the pigeon remains calm, ",
  "Welcome back. The raccoon accountant is balancing the snack budget, ",
  "Hello! The pigeon adjusted its clipboard and nodded confidently, ",
  "Welcome! The mouse intern labeled today ‘promising’, ",
  "Hi there. The turtle from HR is observing quietly, ",
  "Welcome back. The pigeon believes this is a good moment to begin, ",

  "Hello! The pigeon reorganized things and feels accomplished, ",
  "Welcome! The snacks are exactly where they should be, ",
  "Hey there. The seagull asked questions. The pigeon declined to answer, ",
  "Welcome back. The raccoon accountant requested a recount, ",
  "Hi there. The mouse intern took notes and added doodles, ",
  "Hello! The pigeon says progress is happening ‘slowly but correctly’, ",
  "Welcome! The owl auditor has not appeared. Everyone is relieved, ",
  "Hey there. The turtle from HR approved today’s tone, ",
  "Welcome back. The pigeon inspected everything twice, ",
  "Hello! Snack morale has been officially acknowledged, ",

  "Welcome! The pigeon filed today under ‘manageable’, ",
  "Hi there. The mouse intern is practicing professionalism, ",
  "Hello! The raccoon accountant says the numbers look ‘friendly’, ",
  "Welcome back. The pigeon is pleased with the level of order, ",
  "Hey there. The seagull is nearby but pretending not to be, ",
  "Welcome! The snacks are resting comfortably, ",
  "Hello! The turtle from HR scheduled nothing urgently, ",
  "Welcome back. The pigeon says this is a safe place to start, ",
  "Hi there. The mouse intern believes in this moment, ",
  "Welcome! The clipboard has been consulted, ",

  "Hello! The pigeon is quietly proud of this setup, ",
  "Welcome back. The raccoon accountant made a note and smirked, ",
  "Hey there. The seagull was denied entry politely, ",
  "Welcome! Snack access remains fair and just, ",
  "Hi there. The turtle from HR nodded approvingly, ",
  "Welcome back. The pigeon says things are aligned, ",
  "Hello! The mouse intern filed something under ‘important’, ",
  "Welcome! The owl auditor remains a rumor, ",
  "Hey there. The pigeon adjusted its tiny tie, ",
  "Welcome back. Order has been gently applied, ",

  "Hello! The pigeon declared this a ‘working atmosphere’, ",
  "Welcome! The snacks are part of the plan, ",
  "Hi there. The raccoon accountant double-checked everything, ",
  "Welcome back. The seagull is waiting outside dramatically, ",
  "Hey there. The mouse intern asked a good question, ",
  "Welcome! The turtle from HR is very calm about everything, ",
  "Hello! The pigeon says clarity is present, ",
  "Welcome back. The clipboard is satisfied, ",
  "Hi there. Snack crumbs indicate recent success, ",
  "Welcome! This feels officially organized, ",

  "Hello! The pigeon believes momentum is building, ",
  "Welcome back. The raccoon accountant approved today’s math, ",
  "Hey there. The seagull attempted eye contact and failed, ",
  "Welcome! The mouse intern labeled this ‘Phase One’, ",
  "Hi there. The turtle from HR remains unbothered, ",
  "Welcome back. The pigeon says things are proceeding nicely, ",
  "Hello! Snack morale is holding steady, ",
  "Welcome! The owl auditor has not requested documentation, ",
  "Hey there. The pigeon marked today as ‘good’, ",
  "Welcome back. Everything is politely arranged, ",

  "Hello! The pigeon trusts this configuration, ",
  "Welcome! The raccoon accountant adjusted the ledger, ",
  "Hi there. The mouse intern is learning quickly, ",
  "Welcome back. The seagull was redirected successfully, ",
  "Hey there. The turtle from HR approved a flexible pace, ",
  "Welcome! Snacks are being treated with respect, ",
  "Hello! The pigeon checked twice and smiled once, ",
  "Welcome back. The clipboard feels important, ",
  "Hi there. This is the calm version of things, ",
  "Welcome! Order is present and comfortable, ",

  "Hello! The pigeon believes today is promising, ",
  "Welcome back. The raccoon accountant counted crumbs, ",
  "Hey there. The seagull is negotiating from afar, ",
  "Welcome! The mouse intern requested mentorship, ",
  "Hi there. The turtle from HR scheduled a check-in eventually, ",
  "Welcome back. The pigeon says everything is fine, ",
  "Hello! Snacks have been acknowledged officially, ",
  "Welcome! The owl auditor remains theoretical, ",
  "Hey there. The clipboard has been updated, ",
  "Welcome back. This is a good place to continue, ",

  "Hello! The pigeon declared this a low-drama moment, ",
  "Welcome! The raccoon accountant nodded knowingly, ",
  "Hi there. The mouse intern is feeling optimistic, ",
  "Welcome back. The seagull has been distracted elsewhere, ",
  "Hey there. The turtle from HR smiled faintly, ",
  "Welcome! Snacks are calm and cooperative, ",
  "Hello! The pigeon says things are aligned enough, ",
  "Welcome back. The clipboard agrees, ",
  "Hi there. Everything feels manageable here, ",
  "Welcome! The pigeon is ready when you are, ",

  "Hello! The pigeon adjusted the rules slightly, ",
  "Welcome back. The raccoon accountant approved the change, ",
  "Hey there. The mouse intern celebrated quietly, ",
  "Welcome! The seagull is temporarily uninterested, ",
  "Hi there. The turtle from HR is satisfied, ",
  "Welcome back. Snacks remain a unifying force, ",
  "Hello! The pigeon believes this is the right moment, ",
  "Welcome! Everything is set up thoughtfully, ",
  "Hey there. The clipboard has no objections, ",
  "Welcome back. The pigeon-verse is stable, ",
];

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
