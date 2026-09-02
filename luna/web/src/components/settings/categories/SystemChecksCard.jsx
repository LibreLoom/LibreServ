import { Activity, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import SettingsCard from "../SettingsCard.jsx";
import { useSystemHealthCheck } from "../../../hooks/useSystemHealthCheck.jsx";
import { displayLabel } from "../../../lib/healthChecks.js";

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
  const summary = data?.summary;
  const passed = summary?.passed ?? checks.filter(([, c]) => c.status === "passed").length;
  const failed = summary?.failed ?? checks.filter(([, c]) => c.status === "failed").length;
  const skipped = summary?.skipped ?? checks.filter(([, c]) => c.status === "skipped").length;
  const actionable = checks.filter(([, c]) => c.status !== "skipped");
  const allOk = failed === 0 && actionable.length > 0;

  const ordered = [...checks].sort((a, b) => {
    const rank = (s) => (s === "failed" ? 0 : s === "passed" ? 1 : 2);
    const fa = rank(a[1].status);
    const fb = rank(b[1].status);
    return fa - fb || displayLabel(a[0], a[1]).localeCompare(displayLabel(b[0], b[1]));
  });

  return (
    <SettingsCard icon={Activity} title="System Checks" padding={false} index={index}>
      <div className="px-5 py-4">
        <div className="flex items-center justify-between gap-3 mb-4">
          <p className="text-sm text-accent">
            {checks.length === 0
              ? "No checks recorded yet."
              : allOk
                ? `${passed} of ${actionable.length} checks passed — everything looks good.`
                : `${failed} of ${actionable.length} checks need attention.`}
            {skipped > 0 ? ` ${skipped} optional report${skipped === 1 ? "" : "s"} skipped.` : ""}
          </p>
          <span
            className={cn(
              "text-xs px-3 py-1 rounded-pill font-medium shrink-0 border-2",
              allOk
                ? "bg-success/20 border-success/30 text-primary"
                : "bg-error/20 border-error/30 text-primary",
            )}
          >
            {allOk ? "Healthy" : "Issues found"}
          </span>
        </div>

        <ul className="space-y-1">
          {ordered.map(([name, check]) => {
            const ok = check.status === "passed";
            const skippedCheck = check.status === "skipped";
            return (
              <li
                key={name}
                className="flex items-center justify-between gap-3 py-2 border-b border-primary/10 last:border-0"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {ok ? (
                    <CheckCircle2 size={15} className="text-success shrink-0" aria-hidden="true" />
                  ) : skippedCheck ? (
                    <Activity size={15} className="text-accent shrink-0" aria-hidden="true" />
                  ) : (
                    <XCircle size={15} className="text-error shrink-0" aria-hidden="true" />
                  )}
                  <div className="min-w-0">
                    <div className="text-sm text-primary">{displayLabel(name, check)}</div>
                    {check.message && (
                      <div className="text-xs text-accent break-words">{check.message}</div>
                    )}
                  </div>
                </div>
                <span
                  className={cn(
                    "text-[10px] font-mono uppercase tracking-widest shrink-0",
                    ok ? "text-accent" : skippedCheck ? "text-accent" : "text-error",
                  )}
                >
                  {ok ? "ok" : skippedCheck ? "n/a" : "fail"}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </SettingsCard>
  );
}
