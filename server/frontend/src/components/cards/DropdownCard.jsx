import { Server } from "lucide-react";
import Card from "./Card";
import MiniStatCard from "./MiniStatCard";
import CollapsibleSection from "../common/CollapsibleSection";

export default function DropdownCard({
  title,
  subtitle,
  value,
  breakdownItems = [],
  defaultOpen = false,
  Icon = Server,
}) {
  return (
    <div className="transition-transform duration-200 ease-[var(--motion-easing-emphasized)] hover:scale-[1.02] w-full h-fit self-start">
    <Card padding={false}>
      <div className="p-6">
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
      </div>
      <div className="px-6 pb-4">
        <CollapsibleSection title="Breakdown" size="sm" pill defaultOpen={defaultOpen}>
          <div className="grid grid-cols-2 gap-2">
            {breakdownItems.length === 0 ? (
              <div className="col-span-2 text-center py-3 px-4 text-primary font-mono">
                Loading...
              </div>
            ) : (
              breakdownItems.map((item) => (
                <MiniStatCard
                  key={item.label}
                  icon={item.icon}
                  label={item.label}
                  value={item.value}
                />
              ))
            )}
          </div>
        </CollapsibleSection>
      </div>
    </Card>
    </div>
  );
}
