/**
 * Preflight error remediation for Luna setup.
 */

/** @type {Array<{ id: string, match: (error: string) => boolean, tip: string, severity: "warning" | "critical" }>} */
export const ERROR_REMEDIATIONS = [
  {
    id: "permission",
    match: (err) => /cannot|permission|read-only|denied|forbidden|write/i.test(err),
    tip: "Luna needs permission to write to its folders. Try restarting Luna, or check that its data folder is not read-only.",
    severity: "warning",
  },
  {
    id: "disk_space",
    match: (err) => /disk space|no space|512 MB|free space/i.test(err),
    tip: "Luna needs at least 512 MB of free space on its system disk. Delete old files or use a larger disk.",
    severity: "critical",
  },
  {
    id: "database",
    match: (err) => /database|sqlite/i.test(err),
    tip: "Luna can't write its file index. Restart Luna. If it still fails, contact support.",
    severity: "critical",
  },
];

/**
 * @param {Array<[string, { status?: string, error?: string }]>} failedChecks
 */
export function getRemediations(failedChecks) {
  if (!Array.isArray(failedChecks) || failedChecks.length === 0) return [];
  const errors = failedChecks
    .filter(([, check]) => check && check.status !== "ok" && check.error)
    .map(([, check]) => check.error);
  if (errors.length === 0) return [];
  const seen = new Set();
  return ERROR_REMEDIATIONS.filter(({ match }) => errors.some(match))
    .filter(({ id }) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map(({ id, tip, severity }) => ({ id, tip, severity }));
}

/** @param {string} error */
export function summarizeError(error) {
  if (!error) return "";
  const lower = error.toLowerCase();
  if (lower.includes("512 mb") || lower.includes("disk space")) return "Low disk space";
  if (lower.includes("database")) return "File index problem";
  if (lower.includes("write") || lower.includes("permission")) return "Can't write here";
  return error.length > 48 ? `${error.slice(0, 45)}…` : error;
}
