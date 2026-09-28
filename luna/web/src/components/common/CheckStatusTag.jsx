import PropTypes from "prop-types";
import { cn } from "@libreloom/ui/lib/utils.js";
import Pill from "@libreloom/ui/components/common/Pill.jsx";

const TAGS = {
  passed: { text: "Passed", tone: "bg-success/20 border-success/30" },
  warning: { text: "Warning", tone: "bg-warning/20 border-warning/30" },
  failed: { text: "Failed", tone: "bg-error/20 border-error/30" },
};

/** Status chip for a health-check row: tinted pill, full-contrast text. */
export default function CheckStatusTag({ status, className = "" }) {
  const tag = TAGS[status] ?? TAGS.failed;
  return (
    <Pill
      variant="custom"
      className={cn(
        "px-2.5 py-0.5 rounded-pill text-xs border text-primary shrink-0 motion-safe:transition-colors motion-safe:duration-300",
        tag.tone,
        className,
      )}
    >
      {tag.text}
    </Pill>
  );
}

CheckStatusTag.propTypes = {
  status: PropTypes.string,
  className: PropTypes.string,
};
