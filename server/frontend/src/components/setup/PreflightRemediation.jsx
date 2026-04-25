import PropTypes from 'prop-types';
import { AlertCircle } from 'lucide-react';
import { getRemediations } from '../../lib/preflight-errors';

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
    <div className={`rounded-card border p-3 animate-in fade-in slide-in-from-bottom-1 duration-500 ${
      hasCritical 
        ? 'bg-error/5 border-error/15' 
        : 'bg-primary/5 border-primary/10'
    }`}>
      {remediations.map(({ id, tip, severity }) => (
        <div key={id} className="flex items-start gap-2 mb-2 last:mb-0">
          <AlertCircle 
            className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${
              severity === 'critical' ? 'text-error' : 'text-primary/60'
            }`} 
          />
          <p className="text-xs text-primary/60">
            <span className={`font-semibold ${
              severity === 'critical' ? 'text-error/80' : 'text-primary/80'
            }`}>
              {severity === 'critical' ? 'Critical:' : 'Tip:'}
            </span>{' '}
            {tip}
          </p>
        </div>
      ))}
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
