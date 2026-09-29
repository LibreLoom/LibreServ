import { House } from "lucide-react";
import PropTypes from "prop-types";
import LayeredPill from "@libreloom/ui/components/ui/LayeredPill.jsx";
import { TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";

const STATE_PILLS = {
  as_is: "success",
  readonly: "warning",
  missing: "warning",
  ejected: "info",
  failed: "error",
};

/** Status-dot class matching each STATE_PILLS variant. */
const STATE_DOTS = {
  success: "bg-success",
  warning: "bg-warning",
  info: "bg-info",
  error: "bg-error",
};

/**
 * Plain-language drive state label.
 * @param {string} state
 */
function plainDriveState(state) {
  if (state === "as_is") return "Ready";
  if (state === "readonly") {
    return (
      <TermHint surface="primary" content="Luna can open files here but cannot save changes. Check the filesystem, or a write-lock switch on the stick — not the cable or USB port.">
        Read only
      </TermHint>
    );
  }
  if (state === "missing") return "Unplugged";
  if (state === "ejected") return "Ejected";
  if (state === "failed") return "Problem";
  return state;
}

/**
 * The card's layered status pill: front chip carries the state (with its
 * color dot); the rear slot is reserved for the member-home marker so the
 * two facts share one pill. Empty rear slot collapses cleanly.
 *
 * @param {{ drive: { state: string, member_home?: boolean, member_home_auto?: boolean } }} props
 */
export default function DriveStatusPill({ drive }) {
  if (!drive) return null;
  const variant = STATE_PILLS[drive.state] || "info";
  const dot = STATE_DOTS[variant] || "bg-info";
  const memberHome = drive.member_home === true;
  return (
    <LayeredPill
      icon={<span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />}
      actionIcon={<House size={11} />}
      actionLabel={
        memberHome ? (
          <>
            <TermHint
              content={
                drive.member_home_auto
                  ? "Members' private Home folders live on this drive — Luna picked it automatically. Choose a different drive on the Users page."
                  : "Members' private Home folders live on this drive. Choose a different drive on the Users page."
              }
            >
              Member home
            </TermHint>
            {drive.member_home_auto ? " · auto" : ""}
          </>
        ) : null
      }
    >
      {plainDriveState(drive.state)}
    </LayeredPill>
  );
}

DriveStatusPill.propTypes = {
  drive: PropTypes.shape({
    state: PropTypes.string.isRequired,
    member_home: PropTypes.bool,
    member_home_auto: PropTypes.bool,
  }),
};
