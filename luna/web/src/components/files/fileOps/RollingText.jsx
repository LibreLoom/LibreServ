import PropTypes from "prop-types";
import { AnimatePresence, motion as Motion } from "motion/react";
import { cn } from "@libreloom/ui/lib/utils.js";
import { TEXT_EXIT, TEXT_SWAP } from "../../../lib/fileOps/motion.js";

/**
 * A line of text that slides to its new words instead of snapping.
 *
 * `value` is the whole string. When it changes, the old line rises out through
 * the top and the new one rises in from the bottom — the conveyor the rescan
 * menu and the odometer already use, so a word changing in this app looks the
 * same wherever it happens.
 *
 * Give it a `key` that changes only when the *words* change, not when a number
 * inside them does. A percentage that ticks 10 times a second must not restart
 * the animation each time; that is what `RollingNumber` is for, and why the
 * dock splits its summary into stable words and a counting number.
 *
 * The height is animated too, so a longer or shorter line does not jump the
 * layout around it.
 *
 * @param {{ value: string, className?: string, children?: import("react").ReactNode }} props
 *   `children` overrides the plain text when the line needs pills or a counter.
 */
export default function RollingText({ value, className = "", children }) {
  return (
    <span className={cn("relative block overflow-hidden", className)}>
      <AnimatePresence mode="wait" initial={false}>
        <Motion.span
          key={value}
          initial={{ opacity: 0, y: "60%" }}
          animate={{ opacity: 1, y: "0%" }}
          exit={{ opacity: 0, y: "-60%", transition: TEXT_EXIT }}
          transition={TEXT_SWAP}
          className="block"
        >
          {children ?? value}
        </Motion.span>
      </AnimatePresence>
    </span>
  );
}

RollingText.propTypes = {
  value: PropTypes.string.isRequired,
  className: PropTypes.string,
  children: PropTypes.node,
};
