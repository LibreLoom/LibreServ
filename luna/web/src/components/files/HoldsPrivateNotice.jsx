import PropTypes from "prop-types";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";

/** @param {{ names: string[] }} props */
function Pills({ names }) {
  return (
    <>
      {names.map((name, i) => (
        <span key={name}>
          {i > 0 && (i === names.length - 1 ? " and " : ", ")}
          <InlinePill>{name}</InlinePill>
        </span>
      ))}
    </>
  );
}

/**
 * Inline error for a delete that Luna refused because private items sit inside.
 * @param {{ hold: NonNullable<ReturnType<typeof import("../../lib/holdsPrivate.js").holdsPrivateOf>>, className?: string }} props
 */
export default function HoldsPrivateNotice({ hold, className = "mt-2" }) {
  return (
    <PageNotice variant="error" className={className}>
      {hold.owners ? (
        <>
          This folder holds private items belonging to <Pills names={hold.owners} />.
          They have to move or delete them first.
        </>
      ) : hold.items ? (
        <>
          This folder holds your private items <Pills names={hold.items} />.
          Move or delete them first.
        </>
      ) : (
        hold.message || "This folder can't be deleted because it holds items you can't see. An Admin can help."
      )}
    </PageNotice>
  );
}

HoldsPrivateNotice.propTypes = {
  hold: PropTypes.shape({
    owners: PropTypes.arrayOf(PropTypes.string),
    items: PropTypes.arrayOf(PropTypes.string),
    message: PropTypes.string,
  }).isRequired,
  className: PropTypes.string,
};
