import PropTypes from "prop-types";
import { cn } from "@/lib/utils";
import { haptic } from "../../utils/haptics";

/**
 * @param {object} props
 * @param {{ value: string, label?: string, icon?: import('react').ComponentType<any>, disabled?: boolean, title?: string }[]} props.options
 * @param {string} props.value
 * @param {(value: string) => void} props.onChange
 * @param {(value: string) => void} [props.onDisabledClick]
 * @param {string} [props.className]
 * @param {"default"|"secondary"} [props.surface]
 *   Backdrop the control sits on. `"secondary"` uses a primary selected pill
 *   (Apps / Gallery layered search-bar pattern) so a large accent indicator
 *   does not read as the toolbar background.
 */
export default function SegmentedControl({
  options,
  value,
  onChange,
  onDisabledClick = (_value) => {},
  className = "",
  surface = "default",
}) {
  const selectedIndex = options.findIndex((o) => o.value === value);
  const onSecondary = surface === "secondary";
  // On secondary shells (Gallery toolbar), selected pill matches the search
  // field (`bg-primary`) so a gray accent indicator does not dominate.
  const indicatorClass = onSecondary ? "bg-primary" : "bg-accent";
  const idleTextClass = "text-accent hover:text-primary";

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
        className="absolute top-[3px] bottom-[3px] left-[3px] transition-transform ease-[var(--motion-easing-spring)] will-change-transform"
        style={{
          width: `calc((100% - 6px) / ${options.length})`,
          transform: `translateX(${selectedIndex * 100}%)`,
          transitionDuration: "var(--motion-duration-medium3)",
        }}
      >
        <div
          key={selectedIndex}
          className={cn("h-full w-full rounded-pill animate-segmented-settle", indicatorClass)}
        />
      </div>
      {options.map(({ value: optValue, icon: Icon, label, disabled, title }) => (
        <button
          key={optValue}
          title={title}
          onClick={() => {
            if (disabled) {
              haptic("error");
              onDisabledClick(optValue);
              return;
            }
            haptic("selection");
            onChange(optValue);
          }}
          className={cn(
            "relative z-10 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-pill",
            "text-xs font-medium transition-[color,background-color] ease-[var(--motion-easing-standard)]",
            disabled
              ? "text-accent opacity-50 cursor-not-allowed"
              : value === optValue
                ? "text-secondary"
                : idleTextClass
          )}
          style={{ transitionDuration: "var(--motion-duration-short2)" }}
          role="radio"
          aria-checked={value === optValue}
          aria-disabled={disabled || undefined}
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
      disabled: PropTypes.bool,
      title: PropTypes.string,
    })
  ).isRequired,
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  onDisabledClick: PropTypes.func,
  className: PropTypes.string,
  surface: PropTypes.oneOf(["default", "secondary"]),
};
