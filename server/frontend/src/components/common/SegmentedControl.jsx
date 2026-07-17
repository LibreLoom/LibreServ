import PropTypes from "prop-types";
import { cn } from "@/lib/utils";
import { haptic } from "../../utils/haptics";

export default function SegmentedControl({
  options,
  value,
  onChange,
  className = "",
}) {
  const selectedIndex = options.findIndex((o) => o.value === value);

  return (
    <div
      data-slot="segmented-control"
      className={cn(
        "relative inline-grid bg-primary/10 rounded-pill p-[3px]",
        className
      )}
      style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}
      role="radiogroup"
    >
      <div
        data-slot="segmented-control-indicator"
        className="absolute top-[3px] bottom-[3px] left-[3px] transition-transform ease-[var(--motion-easing-emphasized)]"
        style={{
          width: `calc((100% - 6px) / ${options.length})`,
          transform: `translateX(${selectedIndex * 100}%)`,
          transitionDuration: "var(--motion-duration-short4)",
        }}
      >
        <div
          key={selectedIndex}
          className="h-full w-full rounded-pill bg-accent animate-segmented-settle"
        />
      </div>
      {options.map(({ value: optValue, icon: Icon, label }) => (
        <button
          key={optValue}
          onClick={() => {
            haptic("tap");
            onChange(optValue);
          }}
          className={cn(
            "relative z-10 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-pill",
            "text-xs font-medium transition-[color] ease-[var(--motion-easing-standard)]",
            value === optValue ? "text-primary" : "text-accent hover:text-primary"
          )}
          style={{ transitionDuration: "var(--motion-duration-short2)" }}
          role="radio"
          aria-checked={value === optValue}
          aria-label={label}
        >
          {Icon && <Icon size={14} />}
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

SegmentedControl.propTypes = {
  options: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      icon: PropTypes.elementType,
    })
  ).isRequired,
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  className: PropTypes.string,
};
