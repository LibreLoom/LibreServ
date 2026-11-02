import PropTypes from "prop-types";
import CollapsibleSection from "@libreloom/ui/components/common/CollapsibleSection.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import ValueDisplay from "@libreloom/ui/components/common/ValueDisplay.jsx";
import { TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { describeDriveHealth } from "../../lib/driveHealth.js";

/**
 * A drive card's "Drive health" section: the verdict, each reading with a
 * plain explanation, and (for a failing or worn drive) what to do next.
 * Pass the raw `/health` report. Renders nothing while the report is still
 * loading, or for a drive that has no hard drive health report.
 *
 * @param {{
 *   health: import("../../lib/driveHealth.js").DriveHealthReport | null | undefined,
 *   defaultOpen?: boolean,
 * }} props
 */
export default function DriveHealthDetails({ health, defaultOpen = false }) {
  const copy = health ? describeDriveHealth(health) : null;
  if (!copy || copy.verdict === "checking") return null;

  return (
    <CollapsibleSection title="Drive health" size="sm" mono pill defaultOpen={defaultOpen}>
      <div className="flex flex-col gap-3" data-slot="drive-health-details">
        <div>
          <Pill variant={copy.pill.variant}>{copy.pill.label}</Pill>
        </div>
        {copy.rows.length > 0 && (
          <div className="flex flex-col gap-2" role="list" aria-label="Drive health readings">
            {copy.rows.map((row) => (
              <ValueDisplay
                key={row.key}
                label={<TermHint content={row.hint}>{row.label}</TermHint>}
                value={row.value}
              />
            ))}
          </div>
        )}
        {copy.steps.length > 0 && (
          <div>
            <h4 className="font-mono text-sm mb-1">What to do</h4>
            <ol className="list-decimal pl-5 text-sm text-primary space-y-1">
              {copy.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

DriveHealthDetails.propTypes = {
  health: PropTypes.object,
  defaultOpen: PropTypes.bool,
};
