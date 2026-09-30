import PropTypes from "prop-types";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import { TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";

const STATE_PILLS = {
  as_is: "success",
  readonly: "warning",
  missing: "warning",
  ejected: "info",
  failed: "error",
};

/**
 * Plain-language drive state label.
 * @param {string} state
 */
function plainDriveState(state) {
  if (state === "as_is") return "Ready";
  if (state === "readonly") {
    return (
      <TermHint content="Luna can open files here but cannot save changes. Check the filesystem, or a write-lock switch on the stick — not the cable or USB port.">
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
 * The drive card's status pill: the drive's state in plain words, colored
 * by how much attention it needs.
 *
 * @param {{ drive: { state: string } }} props
 */
export default function DriveStatusPill({ drive }) {
  if (!drive) return null;
  return (
    <Pill variant={STATE_PILLS[drive.state] || "info"}>
      {plainDriveState(drive.state)}
    </Pill>
  );
}

DriveStatusPill.propTypes = {
  drive: PropTypes.shape({
    state: PropTypes.string.isRequired,
  }),
};
