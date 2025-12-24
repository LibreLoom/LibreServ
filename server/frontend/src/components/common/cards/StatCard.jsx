import { ArrowUpRight, Minus, ArrowDownRight } from "lucide-react";

export default function StatCard({ icon: Icon, label, value, delta }) {
  const IconComponent = Icon;

  return (
    <div className="bg-secondary text-primary rounded-3xl p-6 flex items-center gap-5 motion-safe:transition hover:scale-[1.02] w-full h-fit">
      <div className="h-14 w-14 rounded-pill bg-primary text-secondary flex items-center justify-center">
        <IconComponent size={26} />
      </div>
      <div>
        <div className="text-sm font-bold text-accent text-left">{label}</div>
        <div className="text-xl font-semibold leading-tight text-left">
          {value}
        </div>
        {delta && (
          <div className="text-xs text-accent flex items-center gap-1">
            {delta}
            {String(delta).startsWith("+") ? (
              <ArrowUpRight size={12} />
            ) : String(delta).startsWith("-") ? (
              <ArrowDownRight size={12} />
            ) : (
              <Minus size={12} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
