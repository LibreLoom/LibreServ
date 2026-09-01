import PropTypes from "prop-types";
import PageNotice from "./PageNotice.jsx";

/**
 * PageNotice wrapper for modal bodies — keeps error copy inside the dialog.
 */
export default function ModalErrorNotice({ error, className = "mt-2" }) {
  if (!error) return null;
  return (
    <PageNotice variant="error" className={className}>
      {error}
    </PageNotice>
  );
}

ModalErrorNotice.propTypes = {
  error: PropTypes.string,
  className: PropTypes.string,
};
