import { useState } from "react";
import { ChevronDown, Server } from "lucide-react";

function MiniStatCard({ icon: Icon, label, value }) {
  return (
    <div className="bg-primary text-secondary rounded-pill p-3 flex items-center gap-3">
      <div className="h-8 w-8 rounded-pill bg-secondary text-primary flex items-center justify-center">
        <Icon size={16} />
      </div>
      <div>
        <div className="text-xs text-accent text-left">{label}</div>
        <div className="text-sm font-semibold text-left">{value}</div>
      </div>
    </div>
  );
}

export default function DropdownCard({
  title,
  subtitle,
  value,
  breakdownItems = [],
  defaultOpen = false,
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="bg-secondary text-primary rounded-3xl p-6 motion-safe:transition hover:scale-[1.02] w-full h-fit">
      <div className="flex items-center gap-5">
        <div className="h-14 w-14 rounded-pill bg-primary text-secondary flex items-center justify-center">
          <Server size={26} />
        </div>
        <div>
          <div className="text-sm font-bold text-accent text-left">{title}</div>
          <div className="text-xl font-semibold leading-tight text-left">
            {value}
          </div>
          {subtitle && (
            <div className="text-sm text-accent text-left">{subtitle}</div>
          )}
        </div>
      </div>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 text-sm text-accent hover:text-primary mt-3 cursor-pointer"
      >
        <ChevronDown
          size={16}
          className={`motion-safe:transition-transform duration-200 ${isOpen ? "rotate-180" : "rotate-0"}`}
        />
        <span>{isOpen ? "Hide breakdown" : "Show breakdown"}</span>
      </button>
      <div
        className={`grid grid-cols-2 gap-2 overflow-hidden motion-safe:transition-all duration-300 ease-out ${
          isOpen
            ? "max-h-96 opacity-100 mt-4 pt-4 border-t border-primary"
            : "max-h-0 opacity-0"
        }`}
      >
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
  );
}
