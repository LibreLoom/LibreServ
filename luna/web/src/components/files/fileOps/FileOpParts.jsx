import PropTypes from "prop-types";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";

/**
 * Draws copy.js parts: plain strings stay text, `{ pill }` becomes an InlinePill.
 * @param {{ parts: Array<string | { pill: string }> }} props
 */
export default function FileOpParts({ parts }) {
  return (
    <>
      {parts.map((part, index) =>
        typeof part === "string" ? (
          <span key={index}>{part}</span>
        ) : (
          <InlinePill key={index}>{part.pill}</InlinePill>
        ),
      )}
    </>
  );
}

FileOpParts.propTypes = {
  parts: PropTypes.arrayOf(
    PropTypes.oneOfType([PropTypes.string, PropTypes.shape({ pill: PropTypes.string.isRequired })]),
  ).isRequired,
};
