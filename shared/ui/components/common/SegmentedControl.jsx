import PropTypes from "prop-types";
import { cn } from "../../lib/utils.js";
import { haptic } from "../../utils/haptics.js";
import { ICON_SIZE } from "../../lib/ui-tokens.js";

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
 * surface — backdrop the control sits on. `"default"`/`"secondary"` are
 *   cards: a primary selected pill on a primary-tinted track. `"primary"`
 *   is for sections on the page background: the track tints with the
 *   secondary color and the selected pill is solid secondary.
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
  // Selected pill inverts against the track: surface text color as the fill.
  const indicatorClass = onPrimary ? "surface-secondary" : "surface-primary";
  const trackClass = onPrimary ? "bg-secondary/10" : "bg-primary/10";
  const idleTextClass = onPrimary ? "text-secondary" : "text-primary";
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
              ? cn(idleTextClass, "opacity-50 cursor-not-allowed")
              : value === optValue
                ? selectedTextClass
                : idleTextClass
          )}
          style={{ transitionDuration: "var(--motion-duration-short2)" }}
          role="radio"
          // The selected button sits on the sliding indicator, a sibling —
          // say so for the contrast check (shared/ui/test/contrast.js).
          data-contrast-surface={value === optValue && !disabled ? (onPrimary ? "secondary" : "primary") : undefined}
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
