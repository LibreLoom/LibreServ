import { useState, useEffect, useCallback, useMemo } from "react";
import PropTypes from "prop-types";
import { AlertCircle, ArrowRight, Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import Button from "../ui/Button.jsx";
import { getJsonAllowErrorStatus } from "../../lib/api.js";
import { summarizeError } from "../../lib/preflight-errors.js";
import PreflightRemediation from "./PreflightRemediation.jsx";

const KNOWN_CHECKS = new Set([
  "database",
  "database_writable",
  "data_path_writable",
  "logs_path_writable",
  "disk_space",
  "api_server",
]);

const CHECK_LABELS = {
  database: "Database",
  database_writable: "Database storage",
  data_path_writable: "Luna data storage",
  logs_path_writable: "Log storage",
  disk_space: "Storage space",
  api_server: "Luna software",
};

const CATEGORY_LABELS = {
  system: "System",
  storage: "Storage",
};

const CATEGORY_ORDER = ["system", "storage"];

function PreflightRow({ name, check, delay, done, rerunning }) {
  const label = CHECK_LABELS[name] ?? name.replace(/_/g, " ");
  const isOk = check?.status === "ok";
  const isFail = check && check.status !== "ok";
  const showPrev = rerunning && check;
  const showEmpty = !done && !check;
  const shortError = isFail && check.error ? summarizeError(check.error) : null;

  return (
    <div
      className={cn(
        "flex items-center gap-4 py-3.5 border-b border-primary/10 last:border-0 motion-safe:transition-opacity motion-safe:duration-300",
        rerunning ? "opacity-45" : "opacity-100",
        "animate-in fade-in slide-in-from-bottom-2 duration-400",
      )}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div
        className={cn(
          "flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center motion-safe:transition-all motion-safe:duration-300",
          showEmpty ? "bg-primary/10" : isOk && !showEmpty ? "bg-primary/15" : isFail && !showEmpty ? "bg-error/20" : "bg-primary/10",
        )}
      >
        {showEmpty ? (
          <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" aria-hidden="true" />
        ) : isOk ? (
          <Check className="w-3.5 h-3.5 text-accent" aria-hidden="true" />
        ) : (
          <X className="w-3.5 h-3.5 text-error" aria-hidden="true" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm text-primary">{label}</span>
          {isFail && shortError && (
            <span className="text-xs text-error truncate">({shortError})</span>
          )}
        </div>
        {name === "disk_space" && isOk && check.disk_space_bytes_free && (
          <p className="text-xs text-accent mt-0.5">
            {Math.round((check.disk_space_bytes_free / (1000 * 1000 * 1000)) * 10) / 10} GB free
          </p>
        )}
      </div>
      {(done || showPrev) && check && (
        <span
          className={cn(
            "flex-shrink-0 font-mono text-[10px] tracking-widest uppercase motion-safe:transition-opacity motion-safe:duration-300",
            isOk ? "text-primary/30" : "text-error",
          )}
        >
          {isOk ? "ok" : "fail"}
        </span>
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
  const [running, setRunning] = useState(false);

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
    } catch (err) {
      setError(`Could not reach Luna: ${err.message || "try again."}`);
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    runChecks();
  }, [runChecks]);

  const checkEntries = useMemo(
    () => (checks ? Object.entries(checks).filter(([name]) => KNOWN_CHECKS.has(name)) : []),
    [checks],
  );
  const hasCheckResults = checkEntries.length > 0;
  const showSkeleton = !hasCheckResults && running && !error;
  const rerunning = running && hasCheckResults;
  const done = checks !== null && !running;
  const hasFailed = done && healthy === false;
  const allPassed = done && healthy === true;
  const showRerunButton = hasFailed || error || rerunning;

  const checksByCategory = useMemo(() => {
    if (!hasCheckResults) return {};
    const grouped = {};
    for (const [name, check] of checkEntries) {
      const cat = check?.category || "system";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push([name, check]);
    }
    return grouped;
  }, [checkEntries, hasCheckResults]);

  return (
    <>
      <div className="mb-7">
        <h2 className="font-mono text-3xl font-normal text-primary tracking-tight">System check</h2>
        <p className="text-accent text-sm mt-2">
          Luna checks its storage and database before you continue setup.
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
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent mt-5 mb-1 first:mt-0">
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
          <p className="text-xs text-accent animate-in fade-in duration-300 h-6">Running checks…</p>
        )}
        {allPassed && (
          <p className="text-xs text-accent animate-in fade-in duration-300 h-6">All checks passed.</p>
        )}
        {hasFailed && (
          <div className="animate-in fade-in slide-in-from-bottom-1 duration-500 ease-out">
            <p className="text-xs text-error flex items-center gap-1.5 mb-2">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
              Some checks failed. Fix the issues above and try again.
            </p>
            <PreflightRemediation failedChecks={checkEntries} />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {allPassed && (
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
