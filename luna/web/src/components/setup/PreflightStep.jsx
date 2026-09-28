import { useState, useEffect, useCallback, useMemo } from "react";
import PropTypes from "prop-types";
import { AlertCircle, AlertTriangle, ArrowRight, Check, Loader2, X } from "lucide-react";
import { cn } from "@libreloom/ui/lib/utils.js";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import CheckMore from "../common/CheckMore.jsx";
import CheckStatusTag from "../common/CheckStatusTag.jsx";
import { getJsonAllowErrorStatus } from "../../lib/api.js";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  displayLabel,
  statusRank,
} from "../../lib/healthChecks.js";

function PreflightRow({ name, check, delay, done, rerunning }) {
  const label = displayLabel(name, check);
  const status = check?.status;
  const isOk = status === "passed";
  const isWarn = status === "warning";
  const isFail = check && !isOk && !isWarn;
  const showPrev = rerunning && check;
  const showEmpty = !done && !check;
  const freeSpace = name === "disk_space" && isOk ? check.details?.free_human : null;

  return (
    <div
      className={cn(
        "flex items-start gap-4 py-3.5 border-b border-primary/10 last:border-0 motion-safe:transition-opacity motion-safe:duration-300",
        rerunning ? "opacity-45" : "opacity-100",
        "animate-in fade-in slide-in-from-bottom-2 duration-400",
      )}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div
        className={cn(
          "flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center motion-safe:transition-all motion-safe:duration-300",
          showEmpty || isOk ? "bg-primary/15" : isWarn ? "bg-warning/20" : "bg-error/20",
        )}
      >
        {showEmpty ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
        ) : isOk ? (
          <Check className="w-3.5 h-3.5" aria-hidden="true" />
        ) : isWarn ? (
          <AlertTriangle className="w-3.5 h-3.5 text-warning" aria-hidden="true" />
        ) : (
          <X className="w-3.5 h-3.5 text-error" aria-hidden="true" />
        )}
      </div>
      <div className="flex-1 min-w-0 pt-1">
        <span className="text-sm text-primary">{label}</span>
        {(isWarn || isFail) && check.message && (
          <p className="text-xs text-primary mt-1 break-words animate-in fade-in duration-300">
            {check.message}
          </p>
        )}
        {(isWarn || isFail) && check.more && <CheckMore text={check.more} />}
        {freeSpace && <p className="text-xs text-primary mt-0.5">{freeSpace} free</p>}
      </div>
      {(done || showPrev) && check && (
        <CheckStatusTag status={status} className="mt-0.5 motion-safe:transition-opacity" />
      )}
    </div>
  );
}

PreflightRow.propTypes = {
  name: PropTypes.string.isRequired,
  check: PropTypes.object,
  delay: PropTypes.number.isRequired,
  done: PropTypes.bool.isRequired,
  rerunning: PropTypes.bool,
};

export default function PreflightStep({ onPass }) {
  const [checks, setChecks] = useState(null);
  const [healthy, setHealthy] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(true);

  const runChecks = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const data = await getJsonAllowErrorStatus("/api/v1/setup/preflight");
      if (data.checks) {
        setChecks(data.checks);
        setHealthy(data.healthy);
      } else {
        throw new Error("Luna sent an unexpected response.");
      }
    } catch {
      setError("Could not run the system check. Make sure this device can reach Luna, then tap Re-run checks.");
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const data = await getJsonAllowErrorStatus("/api/v1/setup/preflight");
        if (cancelled) return;
        if (data.checks) {
          setChecks(data.checks);
          setHealthy(data.healthy);
        } else {
          throw new Error("Luna sent an unexpected response.");
        }
      } catch {
        if (cancelled) return;
        setError("Could not run the system check. Make sure this device can reach Luna, then tap Re-run checks.");
      } finally {
        if (!cancelled) setRunning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const checkEntries = useMemo(() => (checks ? Object.entries(checks) : []), [checks]);
  const hasCheckResults = checkEntries.length > 0;
  const showSkeleton = !hasCheckResults && running && !error;
  const rerunning = running && hasCheckResults;
  const done = checks !== null && !running;
  const hasFailed = done && healthy === false;
  const canContinue = done && healthy === true;
  const warningCount = checkEntries.filter(([, c]) => c?.status === "warning").length;
  const showRerunButton = hasFailed || warningCount > 0 || error || rerunning;

  const checksByCategory = useMemo(() => {
    if (!hasCheckResults) return {};
    const grouped = {};
    for (const [name, check] of checkEntries) {
      const cat = check?.category || "system";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push([name, check]);
    }
    for (const list of Object.values(grouped)) {
      list.sort(
        ([an, a], [bn, b]) =>
          statusRank(a?.status) - statusRank(b?.status) ||
          displayLabel(an, a).localeCompare(displayLabel(bn, b)),
      );
    }
    return grouped;
  }, [checkEntries, hasCheckResults]);

  return (
    <>
      <div className="mb-7">
        <h2 className="font-mono text-3xl font-normal text-primary tracking-tight">System check</h2>
        <p className="text-sm mt-2">
          Luna checks its storage, network, and features before you continue setup.
        </p>
      </div>

      <div className="mb-6">
        {showSkeleton && (
          <div>
            {Array.from({ length: 5 }, (_, i) => (
              <div
                key={i}
                className="flex items-center gap-4 py-3.5 border-b border-primary/10 last:border-0 animate-in fade-in duration-300"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
                  <Loader2 className="w-3.5 h-3.5 text-primary/25 animate-spin" aria-hidden="true" />
                </div>
                <div className="h-3 rounded-full bg-primary/10" style={{ width: `${50 + i * 9}%` }} />
              </div>
            ))}
          </div>
        )}

        {hasCheckResults &&
          CATEGORY_ORDER.map((category) => {
            const catChecks = checksByCategory[category];
            if (!catChecks?.length) return null;
            return (
              <div key={category}>
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] mt-5 mb-1 first:mt-0">
                  {CATEGORY_LABELS[category] || category}
                </p>
                {catChecks.map(([name, check], i) => (
                  <PreflightRow
                    key={name}
                    name={name}
                    check={check}
                    delay={i * 80}
                    done={done || rerunning}
                    rerunning={rerunning}
                  />
                ))}
              </div>
            );
          })}

        {error && (
          <div className="flex items-start gap-3 p-4 rounded-large-element border-2 border-error/30 bg-error/20 animate-in fade-in duration-300">
            <AlertCircle className="w-4 h-4 text-error flex-shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-sm text-primary">{error}</p>
          </div>
        )}
      </div>

      <div className="mb-5">
        {running && (
          <p className="text-xs animate-in fade-in duration-300 h-6">Running checks…</p>
        )}
        {canContinue && warningCount === 0 && (
          <p className="text-xs animate-in fade-in duration-300 h-6">All checks passed.</p>
        )}
        {canContinue && warningCount > 0 && (
          <p className="text-xs text-primary flex items-start gap-1.5 animate-in fade-in duration-300">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px text-warning" aria-hidden="true" />
            {warningCount === 1
              ? "One thing above won't work yet, but you can still continue setup."
              : `${warningCount} things above won't work yet, but you can still continue setup.`}
          </p>
        )}
        {hasFailed && (
          <p className="text-xs text-error flex items-center gap-1.5 animate-in fade-in slide-in-from-bottom-1 duration-500 ease-out">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
            Some checks failed. Follow the steps above, then re-run the checks.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {canContinue && (
          <Button
            variant="primary"
            fullWidth
            onClick={onPass}
            className="group py-4 font-mono tracking-wide hover:scale-[1.02] animate-in fade-in slide-in-from-bottom-2 duration-300"
          >
            Continue
            <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" aria-hidden="true" />
          </Button>
        )}
        {showRerunButton && (
          <Button
            variant="outline"
            surface="secondary"
            fullWidth
            onClick={runChecks}
            loading={running}
            className="py-3.5 font-mono animate-in fade-in slide-in-from-bottom-2 duration-300"
          >
            Re-run checks
          </Button>
        )}
      </div>
    </>
  );
}

PreflightStep.propTypes = {
  onPass: PropTypes.func.isRequired,
};
