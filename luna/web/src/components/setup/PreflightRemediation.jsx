import PropTypes from "prop-types";
import { getRemediations } from "../../lib/preflight-errors.js";

/**
 * Remediation guidance for failed setup preflight checks.
 */
export default function PreflightRemediation({ failedChecks }) {
  const tips = getRemediations(failedChecks);
  if (tips.length === 0) return null;

  return (
    <div data-slot="preflight-remediation" className="animate-in fade-in slide-in-from-bottom-1 duration-500 space-y-2">
      {tips.map((item) => (
        <p
          key={item.id}
          className={
            item.severity === "critical"
              ? "text-xs text-error"
              : "text-xs text-accent"
          }
        >
          {item.tip}
        </p>
      ))}
    </div>
  );
}

PreflightRemediation.propTypes = {
  failedChecks: PropTypes.arrayOf(PropTypes.array).isRequired,
};
