// Turns whatever a request threw into what the card needs: the words to show,
// whether "Try again" makes sense, and, for name clashes and "this widens who
// can open it" warnings, the decision the person has to make.

import { apiErrorMessage } from "../api.js";
import { failedText, text } from "./copy.js";

/**
 * @typedef {{
 *   type: "exists", existingKind: "file"|"dir",
 *   options: Array<"replace"|"keep_both"|"skip">,
 * } | { type: "broadens", message: string, options: ["confirm","skip"] }} Decision
 */

/**
 * @typedef {{
 *   message: string,
 *   retryable: boolean,
 *   offline: boolean,
 *   aborted?: boolean,
 *   queueFull?: boolean,
 *   decision?: Decision,
 * }} Classified
 */

const RETRYABLE_STATUS = new Set([0, 401, 408, 429, 502, 503, 504]);

/** @param {unknown} err */
export function isAbort(err) {
  return /** @type {any} */ (err)?.name === "AbortError";
}

/**
 * The decision for a name that is already taken.
 * @param {"file"|"dir"} existingKind
 * @param {{ sameFolder?: boolean }} [ctx]
 * @returns {Decision}
 */
export function existsDecision(existingKind, ctx = {}) {
  const canReplace = existingKind === "file" && !ctx.sameFolder;
  return {
    type: "exists",
    existingKind,
    options: canReplace ? ["replace", "keep_both", "skip"] : ["keep_both", "skip"],
  };
}

/**
 * @param {unknown} err
 * @param {string} kind the operation kind, to pick the fallback wording
 * @param {{
 *   existingKind?: "file"|"dir",
 *   sameFolder?: boolean,
 *   uncodedConflictIsExists?: boolean,
 * }} [ctx]
 *   `sameFolder`: a copy into its own folder (no Replace).
 *   `uncodedConflictIsExists`: multipart upload errors come back from the XHR
 *   helpers without `code`/`data`, so a bare 409 there means "name taken".
 * @returns {Classified}
 */
export function classifyError(err, kind, ctx = {}) {
  const e = /** @type {any} */ (err) || {};
  if (isAbort(err)) {
    return { message: "", retryable: false, offline: false, aborted: true };
  }
  const status = typeof e.status === "number" ? e.status : undefined;
  const code = e.code || null;
  const message = apiErrorMessage(err, failedText(kind));

  if (status === 503 && code === "queue_full") {
    return { message, retryable: true, offline: false, queueFull: true };
  }

  if (status === 409 && code === "broadens_access") {
    return {
      message,
      retryable: false,
      offline: false,
      decision: { type: "broadens", message, options: ["confirm", "skip"] },
    };
  }

  const isExists = status === 409 && (code === "exists" || (!code && ctx.uncodedConflictIsExists));
  if (isExists) {
    const existingKind =
      e.data?.existing_kind === "dir" || e.data?.existing_kind === "file"
        ? e.data.existing_kind
        : ctx.existingKind || "file";
    return {
      message,
      retryable: false,
      offline: false,
      decision: existsDecision(existingKind, ctx),
    };
  }

  const offline = status === 0;
  return {
    message: offline ? text.offline : message,
    retryable: status !== undefined && RETRYABLE_STATUS.has(status),
    offline,
  };
}
