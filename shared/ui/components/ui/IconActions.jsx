import PropTypes from "prop-types";
import { Link } from "react-router-dom";
import { cn } from "../../lib/utils";
import { haptic } from "../../utils/haptics.js";
import { buttonVariants } from "./Button.jsx";
import { TooltipTargets } from "./Tooltip.jsx";

/** @type {Map<string, string>} */
const classCache = new Map();
/** @param {"primary" | "secondary"} surface */
function iconButtonClass(surface) {
  let cls = classCache.get(surface);
  if (!cls) {
    // Exactly Button's ghost icon button, worked out once instead of per row.
    cls = cn(buttonVariants({ variant: "ghost", size: "iconSm", surface, smoothResize: false }));
    classCache.set(surface, cls);
  }
  return cls;
}

/**
 * A row of small icon buttons with one shared tooltip: the light version of
 * `Button size="iconSm"` + `Tooltip` for lists that put the same actions on
 * every row (file rows, search results). Each button looks, sounds (light
 * haptic) and reads (aria-label) like that pair, and `data-tooltip` gives its
 * visible label, without a Button and a Tooltip mounted per icon.
 *
 * An action is a button (`run`), a router link (`to`; `run` also runs on
 * click, such as closing a panel) or a plain link (`href`, for downloads;
 * `run` is left to other places, such as a phone menu).
 *
 * @param {{
 *   actions: Array<{
 *     key: string,
 *     label: string,
 *     aria: string,
 *     icon: import("react").ComponentType<{ size?: number }>,
 *     run?: (event?: any) => void,
 *     to?: string,
 *     href?: string,
 *   }>,
 *   surface?: "primary" | "secondary",
 *   iconSize?: number,
 *   tabIndex?: number,
 *   className?: string,
 *   [key: string]: any,
 * }} props
 */
export default function IconActions({
  actions,
  surface = "secondary",
  iconSize = 14,
  tabIndex = undefined,
  className = "",
  ...rest
}) {
  const cls = iconButtonClass(surface);
  return (
    <TooltipTargets className={cn("flex items-center gap-0.5 flex-wrap justify-end", className)} {...rest}>
      {actions.map(({ key, label, aria, icon: Icon, run, to, href }) => {
        const common = {
          className: cls,
          "data-slot": "button",
          "data-surface": surface,
          "data-variant": "ghost",
          "data-tooltip": label,
          "aria-label": aria,
          tabIndex,
        };
        const icon = <Icon size={iconSize} aria-hidden="true" />;
        if (to) {
          return (
            <Link
              key={key}
              {...common}
              to={to}
              onClick={(event) => {
                haptic("light");
                run?.(event);
              }}
            >
              {icon}
            </Link>
          );
        }
        if (href) {
          return (
            <a key={key} {...common} href={href} onClick={() => haptic("light")}>
              {icon}
            </a>
          );
        }
        return (
          <button
            key={key}
            {...common}
            type="button"
            onClick={(event) => {
              haptic("light");
              run?.(event);
            }}
          >
            {icon}
          </button>
        );
      })}
    </TooltipTargets>
  );
}

IconActions.propTypes = {
  actions: PropTypes.arrayOf(
    PropTypes.shape({
      key: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      aria: PropTypes.string.isRequired,
      icon: PropTypes.elementType.isRequired,
      run: PropTypes.func,
      to: PropTypes.string,
      href: PropTypes.string,
    }),
  ).isRequired,
  surface: PropTypes.oneOf(["primary", "secondary"]),
  iconSize: PropTypes.number,
  tabIndex: PropTypes.number,
  className: PropTypes.string,
};
