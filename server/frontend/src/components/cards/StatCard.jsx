import { cn } from "@/lib/utils";
import { ArrowUpRight, Minus, ArrowDownRight } from "lucide-react";
import IconCircle from "../ui/IconCircle";
import Card from "./Card";
import PropTypes from "prop-types";

export default function StatCard({ icon: Icon, label, value, delta }) {
  return (
    <Card className={cn("flex items-center gap-5")} data-slot="stat-card">
      <IconCircle icon={Icon} size="lg" />
      <div>
        <div className="text-sm font-bold text-accent text-left">{label}</div>
        <div className="text-xl font-mono font-normal leading-tight text-left">
          {value}
        </div>
        {delta && (
          <div className="text-xs text-accent flex items-center gap-1">
            {delta}
            {String(delta).startsWith("+") ? (
              <ArrowUpRight size={12} aria-hidden="true" />
            ) : String(delta).startsWith("-") ? (
              <ArrowDownRight size={12} aria-hidden="true" />
            ) : (
              <Minus size={12} aria-hidden="true" />
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

StatCard.propTypes = {
  icon: PropTypes.elementType,
  label: PropTypes.string,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  delta: PropTypes.string,
};