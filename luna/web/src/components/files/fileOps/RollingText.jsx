import PropTypes from "prop-types";
import { AnimatePresence, motion as Motion } from "motion/react";
import { cn } from "@libreloom/ui/lib/utils.js";
import RollingNumber from "@libreloom/ui/components/common/RollingNumber.jsx";
import { TEXT_EXIT, TEXT_SWAP } from "../../../lib/fileOps/motion.js";

/**
 * A word that slides to its new text instead of snapping.
 *
 * `value` is the whole string and doubles as the animation key, so give it a
 * value that changes only when the *words* change — never one with a number in
 * it that ticks, or the animation restarts on every tick. Numbers that count
 * belong in `RollingNumber`, which is why the dock's summary is split.
 *
 * **Inline, not block.** It sits inside a line of other text (a count, a
 * percentage), so it has to flow with them; as a block it pushed everything
 * after it onto a new line. `align-bottom` keeps the line box honest, and
 * `leading-[1.4]` gives the slide room so the glyphs are never clipped.
 *
 * @param {{ value: string, className?: string, children?: import("react").ReactNode }} props
 *   `children` overrides the plain text when the word needs a pill or a counter.
 */
export default function RollingText({ value, className = "", children }) {
  return (
    <span className={cn("relative inline-block overflow-hidden align-bottom leading-[1.4]", className)}>
      <AnimatePresence mode="wait" initial={false}>
        <Motion.span
          key={value}
          initial={{ opacity: 0, y: "70%" }}
          animate={{ opacity: 1, y: "0%" }}
          exit={{ opacity: 0, y: "-70%", transition: TEXT_EXIT }}
          transition={TEXT_SWAP}
          className="inline-block"
        >
          {children ?? value}
        </Motion.span>
      </AnimatePresence>
    </span>
  );
}

/**
 * A line built from text and counters: text stays put, counters roll.
 *
 * This is the shape for any line that changes on every progress emit. Pass the
 * segments from `opMetaParts` (or build the same shape): a string is drawn as
 * it is, `{ number }` becomes an odometer so only the digits that change move.
 *
 * @param {{ parts: Array<string | { number: number, suffix?: string }>, className?: string }} props
 */
export function RollingNumbers({ parts, className = "" }) {
  return (
    <span className={cn("inline-flex items-baseline whitespace-nowrap", className)}>
      {parts.map((part, i) =>
        typeof part === "string" ? (
          <span key={i}>{part}</span>
        ) : (
          <span key={i} className="inline-flex items-baseline">
            <RollingNumber value={part.number} />
            {part.suffix}
          </span>
        ),
      )}
    </span>
  );
}

RollingNumbers.propTypes = {
  parts: PropTypes.array.isRequired,
  className: PropTypes.string,
};

RollingText.propTypes = {
  value: PropTypes.string.isRequired,
  className: PropTypes.string,
  children: PropTypes.node,
};
