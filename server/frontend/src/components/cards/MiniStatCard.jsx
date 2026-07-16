import { cn } from "@/lib/utils";
import Card from "./Card";

export default function MiniStatCard({ icon: Icon, label, value }) {
  return (
    <Card padding={false} className={cn("p-3", "flex items-center gap-3")} data-slot="mini-stat-card">
      <div className="h-8 w-8 rounded-pill bg-primary text-secondary flex items-center justify-center">
        <Icon size={16} aria-hidden="true" />
      </div>
      <div>
        <div className="text-xs text-accent text-left">{label}</div>
        <div className="text-sm font-mono font-normal text-left">{value}</div>
      </div>
    </Card>
  );
}