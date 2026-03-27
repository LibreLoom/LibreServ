import { ArrowUpRight, Minus, ArrowDownRight } from "lucide-react";
import IconCircle from "../ui/IconCircle";
import PropTypes from "prop-types";

export default function StatCard({ icon: Icon, label, value, delta }) {
  return (
    <div className="pop-in bg-secondary text-primary rounded-large-element p-6 flex items-center gap-5 transition-all duration-300 ease-in-out hover:scale-[1.02] w-full h-fit">
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
    </div>
  );
}

StatCard.propTypes = {
  icon: PropTypes.elementType,
  label: PropTypes.string,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  delta: PropTypes.string,
};
