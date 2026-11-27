import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import PropTypes from "prop-types";
import { ArrowRight } from "lucide-react";
import { cn } from "@libreloom/ui/lib/utils.js";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import CollapsibleSection from "@libreloom/ui/components/common/CollapsibleSection.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import CheckMore from "../common/CheckMore.jsx";
import CheckStatusIcon from "../common/CheckStatusIcon.jsx";
import CheckStatusTag from "../common/CheckStatusTag.jsx";
import { getJsonAllowErrorStatus } from "../../lib/api.js";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  SETUP_CATEGORY_ORDER,
  displayLabel,
  statusRank,
} from "../../lib/healthChecks.js";

const LOAD_ERRORS = {
  reach: "Make sure this device can still reach Luna, then select Re-run checks.",
  answer: "Luna answered, but without the check results. Select Re-run checks.",
};

// Summary panel tint per verdict: a status /20 fill + /30 border over the card.
const VERDICT_TONE = {
  pending: "border-primary/15",
  passed: "bg-success/20 border-success/30",
  warning: "bg-warning/20 border-warning/30",
  failed: "bg-error/20 border-error/30",
};

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function byStatusThenLabel([an, a], [bn, b]) {
  return (
    statusRank(a?.status) - statusRank(b?.status) ||
    displayLabel(an, a).localeCompare(displayLabel(bn, b))
  );
}

/** Worst status across a list of checks. */
function worstStatus(list) {
  if (list.some(([, c]) => c?.status === "failed")) return "failed";
  if (list.some(([, c]) => c?.status === "warning")) return "warning";
  return "passed";
}

/**
 * Runs the checks. A failure says why: `reach` when no answer came back,
 * `answer` when Luna answered without check results.
 */
async function loadPreflight(signal) {
  try {
    const data = await getJsonAllowErrorStatus("/api/v1/setup/preflight", { signal });
    return data?.checks ? { checks: data.checks, healthy: data.healthy } : { failure: "answer" };
  } catch (err) {
    return { failure: /** @type {any} */ (err)?.status === 0 ? "reach" : "answer" };
  }
}

/** @returns {"success" | "warning" | "error"} */
function outcomeOf(result) {
  if (!result?.checks || !result.healthy) return "error";
  return Object.values(result.checks).some((c) => c?.status === "warning") ? "warning" : "success";
}

// ─── Summary: the verdict first, then one pill per area ──────────────────────
function Summary({ verdict, title, detail, categories, busy }) {
  return (
    <div
      className={cn(
        "rounded-large-element border p-5 motion-safe:transition-colors motion-safe:duration-500",
        VERDICT_TONE[verdict],
      )}
      aria-live="polite"
    >
      <div className="flex items-center gap-4">
        <CheckStatusIcon status={verdict} size="lg" />
        <div className="min-w-0">
          <p
            key={title}
            className="font-mono text-lg text-primary animate-in fade-in slide-in-from-bottom-1 duration-300"
          >
            {title}
          </p>
          {detail && (
            <p key={detail} className="text-sm text-primary mt-0.5 animate-in fade-in duration-300">
              {detail}
            </p>
          )}
        </div>
      </div>

      <ul className="flex flex-wrap gap-2 mt-4" aria-label="Areas checked">
        {categories.map(({ id, status }, i) => (
          <li
            key={id}
            className="flex items-center gap-1.5 pl-1 pr-3 py-1 rounded-chip border border-primary/15 text-xs text-primary animate-in fade-in slide-in-from-bottom-1 duration-300"
            style={{ animationDelay: `${i * 50}ms`, animationFillMode: "backwards" }}
          >
            <CheckStatusIcon status={busy ? "pending" : status} size="sm" />
            {CATEGORY_LABELS[id] || id}
          </li>
        ))}
      </ul>
    </div>
  );
}

Summary.propTypes = {
  verdict: PropTypes.oneOf(["pending", "passed", "warning", "failed"]).isRequired,
  title: PropTypes.string.isRequired,
  detail: PropTypes.string,
  categories: PropTypes.arrayOf(
    PropTypes.shape({ id: PropTypes.string.isRequired, status: PropTypes.string }),
  ).isRequired,
  busy: PropTypes.bool,
};

// ─── A check that failed or warned: its message and the fix one step in ─────
function IssueRow({ name, check, delay }) {
  return (
    <li
      className="flex items-start gap-3.5 p-4 rounded-large-element border border-primary/15 animate-in fade-in slide-in-from-bottom-2 duration-400"
      style={{ animationDelay: `${delay}ms`, animationFillMode: "backwards" }}
    >
      <CheckStatusIcon status={check.status} />
      <div className="flex-1 min-w-0 pt-0.5">
        <div className="flex items-start justify-between gap-3">
          <span className="text-sm text-primary">{displayLabel(name, check)}</span>
          <CheckStatusTag status={check.status} />
        </div>
        {check.message && (
          <p className="text-xs text-primary mt-1 break-words">{check.message}</p>
        )}
        {check.more && <CheckMore text={check.more} />}
      </div>
    </li>
  );
}

IssueRow.propTypes = {
  name: PropTypes.string.isRequired,
  check: PropTypes.object.isRequired,
  delay: PropTypes.number.isRequired,
};

// ─── Passed checks, grouped by area, folded away by default ─────────────────
function PassedList({ grouped, count }) {
  return (
    <CollapsibleSection
      pill
      title={`${count} ${plural(count, "check", "checks")} passed`}
    >
      <div className="pt-1">
        {CATEGORY_ORDER.map((category) => {
          const list = grouped[category];
          if (!list?.length) return null;
          return (
            <div key={category} className="mt-3 first:mt-0">
              <p className="font-mono text-[11px] text-primary mb-1">
                {CATEGORY_LABELS[category] || category}
              </p>
              <ul>
                {list.map(([name, check]) => {
                  const free = name === "disk_space" ? check.details?.free_human : null;
                  return (
                    <li key={name} className="flex items-center gap-2.5 py-1.5">
                      <CheckStatusIcon status="passed" size="sm" />
                      <span className="text-sm text-primary flex-1 min-w-0">
                        {displayLabel(name, check)}
                      </span>
                      {free && <span className="text-xs text-primary shrink-0">{free} free</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}

PassedList.propTypes = {
  grouped: PropTypes.object.isRequired,
  count: PropTypes.number.isRequired,
};

export default function PreflightStep({ onPass, advancing = false }) {
  const [checks, setChecks] = useState(null);
  const [healthy, setHealthy] = useState(null);
  const [error, setError] = useState(/** @type {false | "reach" | "answer"} */ (false));
  const [running, setRunning] = useState(true);
  const requestRef = useRef(/** @type {AbortController|null} */ (null));

  const run = useCallback((announce) => {
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    return loadPreflight(request.signal).then((result) => {
      if (request.signal.aborted || requestRef.current !== request) return;
      requestRef.current = null;
      if (result.checks) {
        setChecks(result.checks);
        setHealthy(result.healthy);
      } else {
        setError(result.failure === "reach" ? "reach" : "answer");
      }
      setRunning(false);
      if (announce) haptic(outcomeOf(result));
    });
  }, []);

  const rerun = async () => {
    setRunning(true);
    setError(false);
    await run(true);
  };

  useEffect(() => {
    void run(false);
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [run]);

  const entries = useMemo(() => (checks ? Object.entries(checks) : []), [checks]);
  const hasResults = entries.length > 0;
  const rerunning = running && hasResults;
  const done = hasResults && !running;

  const { issues, failedCount, warningCount, passedCount, passedGrouped, categories } = useMemo(() => {
    const grouped = {};
    const passedGrouped = {};
    const issues = [];
    let failedCount = 0;
    for (const [name, check] of entries) {
      const cat = check?.category || "system";
      const entry = [name, check];
      (grouped[cat] ||= []).push(entry);
      if (check?.status === "passed") (passedGrouped[cat] ||= []).push(entry);
      else {
        issues.push(entry);
        if (check?.status === "failed") failedCount++;
      }
    }
    issues.sort(byStatusThenLabel);
    for (const list of Object.values(passedGrouped)) list.sort(byStatusThenLabel);
    const categories = entries.length
      ? CATEGORY_ORDER.filter((id) => grouped[id]?.length).map((id) => ({ id, status: worstStatus(grouped[id]) }))
      : SETUP_CATEGORY_ORDER.map((id) => ({ id, status: "pending" }));
    return {
      issues, failedCount, passedGrouped, categories,
      passedCount: entries.length - issues.length,
      warningCount: issues.length - failedCount,
    };
  }, [entries]);

  let verdict = "pending";
  let title = "Checking Luna…";
  let detail = null;
  if (rerunning) {
    title = "Checking again…";
  } else if (error) {
    verdict = "failed";
    title = "Could not run the system check";
    detail = LOAD_ERRORS[error];
  } else if (done && healthy === false) {
    verdict = "failed";
    title = "Setup can't continue yet";
    detail = `${failedCount} ${plural(failedCount, "check", "checks")} failed. See what to do below, then re-run the checks.`;
  } else if (done && warningCount > 0) {
    verdict = "warning";
    title = "Ready to continue";
    detail = `${warningCount} ${plural(warningCount, "check has a warning", "checks have warnings")}. You can still continue setup.`;
  } else if (done) {
    verdict = "passed";
    title = "Everything checks out";
    detail = `All ${entries.length} checks passed.`;
  }

  const canContinue = done && !error && healthy === true;
  const showRerun = error || issues.length > 0 || rerunning;

  return (
    <>
      <div className="mb-6">
        <h2 className="font-mono text-3xl font-normal text-primary">System check</h2>
        <p className="text-sm text-primary mt-2">
          Luna checks its system, storage, network, drives, and features before you continue setup.
        </p>
      </div>

      <Summary
        verdict={verdict}
        title={title}
        detail={detail}
        categories={categories}
        busy={running}
      />

      {hasResults && (
        <div
          className={cn(
            "mt-6 space-y-5 motion-safe:transition-opacity motion-safe:duration-300",
            rerunning && "opacity-45",
          )}
          aria-busy={rerunning}
        >
          {issues.length > 0 && (
            <section>
              <h3 className="font-mono text-[11px] text-primary mb-2">Needs attention</h3>
              <ul className="space-y-2">
                {issues.map(([name, check], i) => (
                  <IssueRow key={name} name={name} check={check} delay={i * 70} />
                ))}
              </ul>
            </section>
          )}

          {passedCount > 0 && <PassedList grouped={passedGrouped} count={passedCount} />}
        </div>
      )}

      <div className="flex flex-col gap-3 mt-8">
        {canContinue && (
          <Button
            variant="primary"
            fullWidth
            onClick={onPass}
            loading={advancing}
            className="group py-4 font-mono hover:scale-[1.02] animate-in fade-in slide-in-from-bottom-2 duration-300"
          >
            Continue
            <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" aria-hidden="true" />
          </Button>
        )}
        {showRerun && (
          <Button
            variant="outline"
            surface="secondary"
            fullWidth
            onClick={rerun}
            loading={running}
            disabled={advancing}
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
  advancing: PropTypes.bool,
};
