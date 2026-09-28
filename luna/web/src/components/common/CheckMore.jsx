import PropTypes from "prop-types";
import CollapsibleSection from "@libreloom/ui/components/common/CollapsibleSection.jsx";

/** The level under a health-check row's one-sentence message. */
export default function CheckMore({ text }) {
  return (
    <CollapsibleSection title="Details" size="xs" className="mt-1">
      <p className="text-xs text-primary break-words">{text}</p>
    </CollapsibleSection>
  );
}

CheckMore.propTypes = {
  text: PropTypes.string.isRequired,
};
