import { useState } from "react";
import { ChevronDown, Server } from "lucide-react";
import MiniStatCard from "./MiniStatCard";

export default function DropdownCard({
  title,
  subtitle,
  value,
  breakdownItems = [],
  defaultOpen = false,
  Icon = Server,
}) {
  // Allow cards (like dashboards) to decide whether the breakdown starts open.
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const breakdownId = `dropdown-breakdown-${String(title)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")}`;

  return (
    <div className="pop-in bg-secondary text-primary rounded-3xl p-6 motion-safe:transition hover:scale-[1.02] w-full h-fit self-start">
      <div className="flex items-center gap-5">
        <div className="h-14 w-14 rounded-pill bg-primary text-secondary flex items-center justify-center">
          <Icon size={26} aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-accent text-left">{title}</div>
          <div className="text-xl font-mono font-normal leading-tight text-left">
            {value}
          </div>
          {subtitle && (
            <div className="text-sm text-accent text-left">{subtitle}</div>
          )}
        </div>
      </div>
      <button
        onClick={() => setIsOpen(!isOpen)}
        type="button"
        className="flex items-center gap-1 text-sm text-accent hover:text-primary mt-3 cursor-pointer"
        aria-expanded={isOpen}
        aria-controls={breakdownId}
      >
        <ChevronDown
          size={16}
          className={`motion-safe:transition-transform duration-200 ${isOpen ? "rotate-180" : "rotate-0"}`}
          aria-hidden="true"
        />
        <span>{isOpen ? "Hide breakdown" : "Show breakdown"}</span>
      </button>
      <div
        id={breakdownId}
        className={`overflow-y-hidden overflow-x-visible motion-safe:transition-all duration-300 ease-out ${
          isOpen ? "max-h-96" : "max-h-0"
        }`}
        aria-hidden={!isOpen}
      >
        {/* Breakdown tiles are optional; empty arrays render a collapsed list. */}
        <div className="grid grid-cols-2 gap-2 p-2">
          {breakdownItems.map((item) => (
            <MiniStatCard
              key={item.label}
              icon={item.icon}
              label={item.label}
              value={item.value}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
