import { Activity, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@libreloom/ui/lib/utils.js";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import { useSystemHealthCheck } from "../../../hooks/useSystemHealthCheck.jsx";
import CheckMore from "../../common/CheckMore.jsx";
import CheckStatusTag from "../../common/CheckStatusTag.jsx";
import { displayLabel, statusRank } from "../../../lib/healthChecks.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";

export default function SystemChecksCard({ index = 1 }) {
  const { data, isLoading, error } = useSystemHealthCheck();

  if (isLoading && !data) {
    return (
      <SettingsCard icon={Activity} title="System Checks" padding={false} index={index}>
        <div className="px-5 py-4 space-y-3 animate-pulse">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="w-4 h-4 rounded-full bg-primary/20" />
              <div className="h-3 rounded-pill bg-primary/10 flex-1" />
            </div>
          ))}
        </div>
      </SettingsCard>
    );
  }

  if (!data && error) {
    return (
      <SettingsCard icon={Activity} title="System Checks" padding={false} index={index}>
        <p className="px-5 py-4 text-sm text-error">
          Luna couldn&apos;t run system checks right now. Try again in a moment.
        </p>
      </SettingsCard>
    );
  }

  const checks = data?.checks ? Object.entries(data.checks) : [];
  const count = (status) => checks.filter(([, c]) => c.status === status).length;
  const warnings = data?.summary?.warnings ?? count("warning");
  const failed = data?.summary?.failed ?? count("failed");
  const total = checks.length;

  const ordered = [...checks].sort(
    (a, b) =>
      statusRank(a[1].status) - statusRank(b[1].status) ||
      displayLabel(a[0], a[1]).localeCompare(displayLabel(b[0], b[1])),
  );

  const warningText = `${warnings} ${warnings === 1 ? "warning" : "warnings"}`;
  let summaryText = "No checks recorded yet.";
  if (total > 0 && failed > 0) {
    summaryText = `${failed} of ${total} checks failed${warnings > 0 ? `, plus ${warningText}` : ""}.`;
  } else if (total > 0 && warnings > 0) {
    summaryText = `${warnings} of ${total} checks ${warnings === 1 ? "has a warning" : "have warnings"}.`;
  } else if (total > 0) {
    summaryText = `All ${total} checks passed.`;
  }
  const badge =
    failed > 0
      ? { text: "Issues found", tone: "bg-error/20 border-error/30" }
      : warnings > 0
        ? { text: "Warnings", tone: "bg-warning/20 border-warning/30" }
        : { text: "Healthy", tone: "bg-success/20 border-success/30" };

  return (
    <SettingsCard icon={Activity} title="System Checks" padding={false} index={index}>
      <div className="px-5 py-4">
        <div className="flex items-center justify-between gap-3 mb-4">
          <p className="text-sm">{summaryText}</p>
          {total > 0 && (
            <span
              className={cn(
                "text-xs px-3 py-1 rounded-pill font-medium shrink-0 border-2 text-primary motion-safe:transition-colors motion-safe:duration-300",
                badge.tone,
              )}
            >
              {badge.text}
            </span>
          )}
        </div>

        <ul className="space-y-1">
          {ordered.map(([name, check]) => {
            const ok = check.status === "passed";
            const warn = check.status === "warning";
            return (
              <li
                key={name}
                className="flex items-start justify-between gap-3 py-2 border-b border-primary/10 last:border-0"
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  {ok ? (
                    <CheckCircle2 size={ICON_SIZE.md} className="text-success shrink-0 mt-0.5" aria-hidden="true" />
                  ) : warn ? (
                    <AlertTriangle size={ICON_SIZE.md} className="text-warning shrink-0 mt-0.5" aria-hidden="true" />
                  ) : (
                    <XCircle size={ICON_SIZE.md} className="text-error shrink-0 mt-0.5" aria-hidden="true" />
                  )}
                  <div className="min-w-0">
                    <div className="text-sm text-primary">{displayLabel(name, check)}</div>
                    {check.message && (
                      <div className="text-xs text-primary break-words">{check.message}</div>
                    )}
                    {check.more && <CheckMore text={check.more} />}
                  </div>
                </div>
                <CheckStatusTag status={check.status} />
              </li>
            );
          })}
        </ul>
      </div>
    </SettingsCard>
  );
}
