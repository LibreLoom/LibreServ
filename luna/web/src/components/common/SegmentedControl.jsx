import PropTypes from "prop-types";
import { cn } from "@/lib/utils";
import { haptic } from "../../utils/haptics";
import { ICON_SIZE } from "@/lib/ui-tokens";

/**
 * @typedef {Record<string, any> & {
 *   options: { value: string, label?: string, icon?: import('react').ComponentType<any>, disabled?: boolean, title?: string }[],
 *   value: string,
 *   onChange: (value: string) => void,
 *   onDisabledClick?: (value: string) => void,
 *   className?: string,
 *   surface?: "default"|"primary"|"secondary",
 *   "aria-label"?: string,
 * }} SegmentedControlProps
 *
 * @param {SegmentedControlProps} props
 * surface — backdrop the control sits on. `"secondary"` uses a primary
 *   selected pill (Apps / Gallery layered search-bar pattern) so a large
 *   accent indicator does not read as the toolbar background. `"primary"`
 *   is for sections on the page background: the track tints with the
 *   secondary color so the control stays visible on bg-primary.
 */
export default function SegmentedControl({
  options,
  value,
  onChange,
  onDisabledClick = (_value) => {},
  className = "",
  surface = "default",
  "aria-label": ariaLabel,
}) {
  const selectedIndex = options.findIndex((o) => o.value === value);
  const onSecondary = surface === "secondary";
  const onPrimary = surface === "primary";
  // On secondary shells (Gallery toolbar), selected pill matches the search
  // field (`bg-primary`) so a gray accent indicator does not dominate.
  const indicatorClass = onSecondary ? "bg-primary" : "bg-accent";
  const trackClass = onPrimary ? "bg-secondary/10" : "bg-primary/10";
  const idleTextClass = onPrimary
    ? "text-accent hover:text-secondary"
    : "text-accent hover:text-primary";
  const selectedTextClass = onPrimary ? "text-primary" : "text-secondary";

  return (
    <div
      data-slot="segmented-control"
      className={cn(
        "relative inline-grid rounded-pill p-[3px]",
        trackClass,
        className
      )}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      role="radiogroup"
      aria-label={ariaLabel}
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
            "relative z-10 flex items-center justify-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-pill min-w-0",
            "text-xs font-medium transition-[color,background-color] ease-[var(--motion-easing-standard)]",
            disabled
              ? "text-accent opacity-50 cursor-not-allowed"
              : value === optValue
                ? selectedTextClass
                : idleTextClass
          )}
          style={{ transitionDuration: "var(--motion-duration-short2)" }}
          role="radio"
          aria-checked={value === optValue}
          aria-disabled={disabled || undefined}
          aria-label={label}
        >
          {Icon && <Icon size={ICON_SIZE.sm} className="shrink-0" />}
          <span className="truncate text-center w-full">{label}</span>
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
  surface: PropTypes.oneOf(["default", "primary", "secondary"]),
  "aria-label": PropTypes.string,
};
