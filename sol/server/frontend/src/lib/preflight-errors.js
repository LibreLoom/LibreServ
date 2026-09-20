/**
 * Pre-flight error remediation rules.
 * Each rule defines how to detect an error type and what guidance to show.
 */

/**
 * @typedef {Object} ErrorRemediationRule
 * @property {string} id - Unique identifier for the rule
 * @property {(error: string) => boolean} match - Predicate to detect this error type
 * @property {string} tip - User-facing remediation guidance
 * @property {'warning' | 'critical'} severity - How urgent is this issue
 * @property {string[]} [categories] - Which check categories this applies to (optional)
 */

/** @type {ErrorRemediationRule[]} */
export const ERROR_REMEDIATIONS = [
  {
    id: 'permission',
    match: (err) => /cannot|permission|read-only|denied|forbidden/i.test(err),
    tip: 'Storage permission errors often mean the directory is owned by root. Try restarting your device, or check that directories are writable by the libreserv user.',
    severity: 'warning'
  },
  {
    id: 'disk_space',
    match: (err) => /disk space|no space left|insufficient space/i.test(err),
    tip: 'Free up storage space or add a larger drive. The system needs at least 512 MB free to operate.',
    severity: 'critical'
  },
  {
    id: 'runtime',
    match: (err) => /podman|container|daemon|runtime/i.test(err),
    tip: 'The container engine (Podman) needs to be running. Try restarting your device, or ask the person who set up your LibreServ for help.',
    severity: 'critical'
  },
  {
    id: 'database',
    match: (err) => /database|sqlite|migration/i.test(err),
    tip: 'Database errors may indicate file corruption or permission issues. Check that the database directory is writable.',
    severity: 'critical'
  },
  {
    id: 'network',
    match: (err) => /network|connection|timeout|unreachable/i.test(err),
    tip: 'Check your network connection and ensure required services are accessible.',
    severity: 'warning'
  }
];

/**
 * Extract failed checks and return applicable remediations.
 * @param {Array<[string, {status: string, error?: string, category?: string}]>} failedChecks
 * @returns {Array<{id: string, tip: string, severity: 'warning' | 'critical'}>}
 */
export function getRemediations(failedChecks) {
  if (!Array.isArray(failedChecks) || failedChecks.length === 0) {
    return [];
  }

  const errors = failedChecks
    .filter(([, check]) => check && check.status !== 'ok' && check.error)
    .map(([, check]) => check.error);

  if (errors.length === 0) {
    return [];
  }

  const seen = new Set();
  return ERROR_REMEDIATIONS
    .filter(({ match }) => errors.some(match))
    .filter(({ id }) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map(({ id, tip, severity }) => ({ id, tip, severity }));
}

/**
 * Get a short, user-friendly error summary for inline display.
 * @param {string} error - Full error message from backend
 * @returns {string} - Truncated summary (max 50 chars)
 */
export function summarizeError(error) {
  if (!error) return '';
  
  // Take first line, remove common prefixes, truncate
  const firstLine = error.split('\n')[0].trim();
  const cleaned = firstLine.replace(/^(cannot|failed to|unable to)\s*/i, '');
  
  if (cleaned.length <= 50) {
    return cleaned;
  }
  
  // Try to cut at word boundary
  const truncated = cleaned.slice(0, 47);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated) + '...';
}
