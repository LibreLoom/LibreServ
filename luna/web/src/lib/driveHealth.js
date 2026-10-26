/**
 * Turn a drive's health report (GET /api/v1/drives/:id/health) into plain copy.
 *
 * Luna decides the verdict, so this file reads only `verdict`, `reason`,
 * `signals`, `temperature_max_*` and `overall`. It never compares a number with
 * a limit of its own.
 */

/**
 * @typedef {{
 *   kind: string,
 *   level: string,
 *   value: number | null,
 *   limit: number | null,
 * }} HealthSignal
 *
 * @typedef {{
 *   available?: boolean,
 *   reason?: string | null,
 *   verdict?: string,
 *   overall?: string,
 *   temperature_c?: number | null,
 *   temperature_max_c?: number | null,
 *   temperature_max_source?: string,
 *   reallocated_sectors?: number | null,
 *   pending_sectors?: number | null,
 *   uncorrectable_sectors?: number | null,
 *   signals?: HealthSignal[],
 * }} DriveHealthReport
 *
 * @typedef {{ key: string, label: string, hint: string, value: string }} HealthRow
 *
 * @typedef {{
 *   verdict: "checking" | "ok" | "watch" | "failing" | "unknown",
 *   pill: { variant: "muted" | "success" | "warning" | "error", label: string },
 *   summary: string,
 *   hint?: string,
 *   needsYou: null | { tone: "problem" | "warning", rank: number, title: string, detail: string },
 *   rows: HealthRow[],
 *   steps: string[],
 * }} DriveHealthCopy
 */

const COPY_NOW = "Copy your files to another drive now.";
const KEEP_AND_BACK_UP = "Keep using it, and make sure it's backed up.";
const WATCH_SUMMARY = "Still working. Keep using it, and make sure its files are backed up.";
const NO_REPORT_HINT =
  "Hard drives keep a health report that Luna reads. Some USB cases don't pass it on. Luna can still use the drive, but it can't warn you early.";

/**
 * @param {HealthSignal[]} signals
 * @param {string} kind
 */
function findSignal(signals, kind) {
  return signals.find((signal) => signal.kind === kind);
}

/**
 * Plain copy for a drive's health, or null when nothing should be said
 * (an SSD, USB stick or other drive without a hard drive health report).
 * `undefined` or `null` means the report is still loading.
 *
 * @param {DriveHealthReport | null | undefined} health
 * @returns {DriveHealthCopy | null}
 */
export function describeDriveHealth(health) {
  if (health == null) {
    return {
      verdict: "checking",
      pill: { variant: "muted", label: "Checking health…" },
      summary: "Checking this drive's health…",
      needsYou: null,
      rows: [],
      steps: [],
    };
  }
  if (health.reason === "not_a_hard_drive") return null;

  const signals = Array.isArray(health.signals) ? health.signals : [];
  const top = signals[0];
  const verdict = health.verdict ?? "unknown";

  if (verdict === "failing") {
    return {
      verdict,
      pill: { variant: "error", label: "Failing" },
      summary: `This drive is failing. ${COPY_NOW}`,
      needsYou: { tone: "problem", rank: 12, title: " is failing", detail: failingDetail(top) },
      rows: buildRows(health, signals),
      steps: [
        "Plug in another drive with enough free space and add it to Luna.",
        "Open this drive, tick Select all, choose Copy, and pick the new drive.",
        "When the copy is done, remove this drive from Luna and stop using it.",
      ],
    };
  }

  if (verdict === "watch") {
    const watch = watchCopy(top, health);
    /** @type {string[]} */
    const steps = [
      "Keep using it.",
      "Make sure its files are backed up: use the Back up button on this drive's card.",
    ];
    if (findSignal(signals, "temperature")?.level === "watch") {
      steps.push("Give it more air: away from heaters and out of closed cupboards.");
    }
    return {
      verdict,
      pill: { variant: "warning", label: watch.pill },
      summary: watch.summary,
      needsYou: { tone: "warning", rank: 70, title: watch.title, detail: watch.detail },
      rows: buildRows(health, signals),
      steps,
    };
  }

  if (verdict === "ok") {
    return {
      verdict,
      pill: { variant: "success", label: "Healthy" },
      summary: "This hard drive reported no problems.",
      needsYou: null,
      rows: buildRows(health, signals),
      steps: [],
    };
  }

  return {
    verdict: "unknown",
    pill: { variant: "muted", label: "Health unknown" },
    summary: "Luna couldn't read this hard drive's health report.",
    hint: NO_REPORT_HINT,
    needsYou: null,
    rows: buildRows(health, signals),
    steps: [],
  };
}

/** @param {HealthSignal | undefined} top */
function failingDetail(top) {
  const n = top?.value;
  switch (top?.kind) {
    case "self_check_failed":
      return `Its own self-check failed. ${COPY_NOW}`;
    case "worn_past_limit":
      return `It's past its maker's wear limit. ${COPY_NOW}`;
    case "pending_sectors":
    case "uncorrectable_sectors":
      return `It can't read ${n} spots on its disk. ${COPY_NOW}`;
    case "reallocated_sectors":
      return `${n} spots on its disk have worn out. ${COPY_NOW}`;
    default:
      return COPY_NOW;
  }
}

/**
 * @param {HealthSignal | undefined} top
 * @param {DriveHealthReport} health
 * @returns {{ pill: string, summary: string, title: string, detail: string }}
 */
function watchCopy(top, health) {
  switch (top?.kind) {
    case "error_log":
      return {
        pill: "Logged errors",
        summary: WATCH_SUMMARY,
        title: " has logged errors",
        detail: `It recorded errors while reading or writing. ${KEEP_AND_BACK_UP}`,
      };
    case "self_test_errors":
      return {
        pill: "Failed a self-test",
        summary: WATCH_SUMMARY,
        title: " failed a self-test",
        detail: `Its own test found a problem. ${KEEP_AND_BACK_UP}`,
      };
    case "temperature": {
      const max = top.limit ?? health.temperature_max_c;
      return {
        pill: "Running hot",
        summary: "Still working, but too hot. Move it somewhere cooler or give it more air.",
        title: " is running hot",
        detail: `It's ${top.value}°C, above the ${max}°C it's made for. Move it somewhere cooler.`,
      };
    }
    case "worn_in_past":
      return {
        pill: "Showing wear",
        summary: WATCH_SUMMARY,
        title: " is showing wear",
        detail: `It went past its maker's wear limit once. ${KEEP_AND_BACK_UP}`,
      };
    default:
      return {
        pill: "Showing wear",
        summary: WATCH_SUMMARY,
        title: " is showing wear",
        detail: `${top?.value} spots on its disk have worn out. ${KEEP_AND_BACK_UP}`,
      };
  }
}

/**
 * The detail rows for the Files page. A row appears only when its number or
 * signal is present in the report.
 *
 * @param {DriveHealthReport} health
 * @param {HealthSignal[]} signals
 * @returns {HealthRow[]}
 */
function buildRows(health, signals) {
  /** @type {HealthRow[]} */
  const rows = [];

  rows.push({
    key: "self-check",
    label: "Drive's self-check",
    hint: "Hard drives test themselves and report pass or fail.",
    value:
      health.overall === "passed" ? "Passed" : health.overall === "failed" ? "Failed" : "Not reported",
  });

  if (health.temperature_c != null) {
    const level = findSignal(signals, "temperature")?.level;
    const source =
      health.temperature_max_source === "drive"
        ? `This drive says it's made to run at up to ${health.temperature_max_c}°C.`
        : `Most hard drives are made to run at up to ${health.temperature_max_c}°C.`;
    const t = health.temperature_c;
    let value = `${t}°C · normal`;
    let hint = `Hard drives get warm while they work. ${source}`;
    if (level === "note") {
      value = `${t}°C · warm`;
      hint = `Close to its limit. ${source} Keep air moving around it.`;
    } else if (level === "watch" || level === "failing") {
      value = `${t}°C · too hot`;
      hint = `Above its limit. ${source} Heat wears a drive out faster.`;
    }
    rows.push({ key: "temperature", label: "Temperature", hint, value });
  }

  if (health.reallocated_sectors != null) {
    const n = health.reallocated_sectors;
    const level = findSignal(signals, "reallocated_sectors")?.level;
    let value = "None";
    if (n > 0) value = `${n} · ${level === "failing" ? "too many" : "showing wear"}`;
    rows.push({
      key: "replaced-spots",
      label: "Replaced spots",
      hint: "Parts of the disk that wore out. The drive moved their data to spare space. A few is a warning sign, and the number usually grows. Luna treats 100 or more as failing.",
      value,
    });
  }

  if (health.pending_sectors != null || health.uncorrectable_sectors != null) {
    const n = (health.pending_sectors ?? 0) + (health.uncorrectable_sectors ?? 0);
    rows.push({
      key: "unreadable-spots",
      label: "Unreadable spots",
      hint: "Parts of the disk the drive couldn't read. Files stored there may already be damaged.",
      value: n > 0 ? `${n} · failing` : "None",
    });
  }

  if (findSignal(signals, "error_log")) {
    rows.push({
      key: "error-log",
      label: "Error log",
      hint: "The drive recorded errors while reading or writing. One or two can come from a loose cable; more point to wear.",
      value: "Has errors",
    });
  }
  if (findSignal(signals, "self_test_errors")) {
    rows.push({
      key: "self-test",
      label: "Self-test",
      hint: "The drive's own surface test found a fault.",
      value: "Found a problem",
    });
  }
  const wearHint = "A wear measure the maker sets has passed its failure line.";
  if (findSignal(signals, "worn_past_limit")) {
    rows.push({ key: "wear-limit", label: "Wear limit", hint: wearHint, value: "Past the maker's limit" });
  } else if (findSignal(signals, "worn_in_past")) {
    rows.push({ key: "wear-limit", label: "Wear limit", hint: wearHint, value: "Went past it once" });
  }

  return rows;
}
