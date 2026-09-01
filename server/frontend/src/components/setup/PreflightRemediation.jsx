import { cn } from "@/lib/utils";
import PropTypes from 'prop-types';
import { getRemediations } from '../../lib/preflight-errors';
import Callout from '../common/Callout';

/**
 * Displays remediation guidance for failed preflight checks.
 * Only renders when there are failed checks with known remediations.
 */
export function PreflightRemediation({ failedChecks }) {
  const remediations = getRemediations(failedChecks);

  if (remediations.length === 0) {
    return null;
  }

  const hasCritical = remediations.some(r => r.severity === 'critical');

  return (
    <div data-slot="preflight-remediation" className="animate-in fade-in slide-in-from-bottom-1 duration-500">
      <Callout tone={hasCritical ? 'error' : 'neutral'}>
        {remediations.map(({ id, tip, severity }) => (
          <div key={id} className="mb-2 last:mb-0">
            <span className={cn("font-semibold", severity === 'critical' ? 'text-error' : 'text-primary')}>
              {severity === 'critical' ? 'Critical:' : 'Tip:'}
            </span>{' '}
            {tip}
          </div>
        ))}
      </Callout>
    </div>
  );
}

PreflightRemediation.propTypes = {
  /** Array of [checkName, checkResult] tuples from preflight API */
  failedChecks: PropTypes.arrayOf(
    PropTypes.arrayOf(PropTypes.any)
  ).isRequired
};

export default PreflightRemediation;
