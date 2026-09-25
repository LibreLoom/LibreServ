import PropTypes from "prop-types";
import { useQuery } from "@tanstack/react-query";
import { CAP } from "../../../lib/access.js";
import { latestResponses } from "../../../lib/formDocument.js";
import { fileSourceScope, useFileSource } from "../../../lib/fileSource.jsx";

/**
 * Small "N answers" pill shown next to `.lunaform` rows in file listings.
 * Reads the form's responses through the active FileSource — the public
 * respond link never exposes them. A missing answers file (nobody has
 * answered yet) renders a quiet "0 answers". Callers only mount it during
 * real browsing with view access.
 *
 * @param {{ driveId: string, formPath: string }} props
 */
export default function FormResponseBadge({ driveId, formPath }) {
  const source = useFileSource();
  const canView = !source.guest || ((source.capsBits ?? 0) & CAP.VIEW) !== 0;
  const count = useQuery({
    queryKey: ["form-responses", fileSourceScope(source, driveId), formPath],
    queryFn: async () => latestResponses(await source.formResponses(driveId, formPath)).length,
    enabled: canView,
    staleTime: 30_000,
  });
  if (count.data == null) return null;
  const n = count.data;
  return (
    <span
      className="rounded-pill bg-primary text-secondary px-2 py-0.5 font-mono text-xs"
      title={n === 1 ? "1 person answered" : `${n} people answered`}
    >
      {n === 1 ? "1 answer" : `${n} answers`}
    </span>
  );
}

FormResponseBadge.propTypes = {
  driveId: PropTypes.string.isRequired,
  formPath: PropTypes.string.isRequired,
};
