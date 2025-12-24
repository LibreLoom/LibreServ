import { ArrowUpRight, Minus, ArrowDownRight } from "lucide-react";

export default function StatCard({ icon: Icon, label, value, delta }) {
  return (
    <div className="bg-secondary text-primary rounded-large-element p-6 flex items-center gap-5 motion-safe:transition hover:scale-[1.02] min-w-64">
      <div className="h-14 w-14 rounded-pill bg-primary text-secondary flex items-center justify-center">
        <Icon size={26} />
      </div>
      <div>
        <div className="text-sm opacity-70">{label}</div>
        <div className="text-xl font-semibold leading-tight text-left">
          {value}
        </div>
        <div className="text-xs opacity-60 flex items-center gap-1">
          {delta}
          {String(delta).startsWith("+") ? (
            <ArrowUpRight size={12} />
          ) : String(delta).startsWith("-") ? (
            <ArrowDownRight size={12} />
          ) : (
            <Minus size={12} />
          )}
        </div>
      </div>
    </div>
  );
}
