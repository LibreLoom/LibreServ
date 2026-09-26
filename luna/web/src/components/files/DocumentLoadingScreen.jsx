import PropTypes from "prop-types";
import DotMatrixLoader from "@libreloom/ui/components/ui/DotMatrixLoader.jsx";
import { cn } from "@libreloom/ui/lib/utils.js";

/**
 * Unified document editor loading screen.
 *
 * Displays a viewport-filling matrix of dots pulsing in a diagonal wave
 * from top-left to bottom-right, symbolizing loading without visual text.
 * The label is retained for screen-reader accessibility.
 *
 * @param {{
 *   label?: string,
 *   className?: string,
 *   [key: string]: any
 * }} props
 */
export default function DocumentLoadingScreen({
  label = "Opening…",
  className = "",
  ...props
}) {
  return (
    <DotMatrixLoader
      label={label}
      className={cn("h-full w-full", className)}
      {...props}
    />
  );
}

DocumentLoadingScreen.propTypes = {
  label: PropTypes.string,
  className: PropTypes.string,
};
