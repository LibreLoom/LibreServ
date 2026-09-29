import PropTypes from "prop-types";
import { useQuery } from "@tanstack/react-query";
import { CAP } from "../../../lib/access.js";
import { readFormSeen } from "../../../lib/formDocument.js";
import { fileSourceScope, useFileSource } from "../../../lib/fileSource.jsx";

/**
 * Small "N responses" pill shown next to `.lunaform` rows in file listings.
 * Asks the active FileSource for the count only — a folder of forms must
 * not pull every answer into the browser. The public respond link never
 * exposes it. Callers only mount it during real browsing with view access.
 *
 * @param {{ driveId: string, formPath: string }} props
 */
export default function FormResponseBadge({ driveId, formPath }) {
  const source = useFileSource();
  const scope = fileSourceScope(source, driveId);
  const canView = !source.guest || ((source.capsBits ?? 0) & CAP.VIEW) !== 0;
  const count = useQuery({
    // Its own key: the builder caches the full list under
    // ["form-responses", …]; this one only ever holds a number.
    queryKey: ["form-response-count", scope, formPath],
    queryFn: () => source.formResponseCount(driveId, formPath),
    enabled: canView,
    staleTime: 30_000,
  });
  const n = count.data;
  if (typeof n !== "number") return null;
  const fresh = Math.max(0, n - readFormSeen(scope, formPath));
  const label = fresh > 0
    ? (fresh === 1 ? "1 new" : `${fresh} new`)
    : (n === 1 ? "1 response" : `${n} responses`);
  const title = fresh > 0
    ? (fresh === 1 ? "1 new response since you last looked" : `${fresh} new responses since you last looked`)
    : (n === 1 ? "1 response so far" : `${n} responses so far`);
  return (
    <span
      className="rounded-pill surface-primary px-2 py-0.5 font-mono text-xs"
      title={title}
    >
      {label}
    </span>
  );
}

FormResponseBadge.propTypes = {
  driveId: PropTypes.string.isRequired,
  formPath: PropTypes.string.isRequired,
};
