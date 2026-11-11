import PropTypes from "prop-types";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import { TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { describeDriveHealth } from "../../lib/driveHealth.js";
import { isConvertingDrive, isLockedDrive, isUnopenable } from "../../lib/drives.js";

const READ_ONLY_HINT =
  "Luna can open files here but cannot save changes. Check the filesystem, or a write-lock switch on the stick — not the cable or USB port.";

const LOCKED_HINT =
  "This drive is encrypted and locked. Anyone with access to this drive can unlock it.";

/**
 * The drive card's status pill: the one thing most worth knowing about the
 * drive, in plain words. Unplugged and Ejected come first, then a conversion
 * in flight, then a locked drive, then a drive Luna can't open, then a failing
 * or worn drive (so a health pill never sits next to "Ready"), then Read only,
 * then Ready.
 *
 * `health` is the drive's health report as the API returns it; leave it out
 * (or pass undefined while it loads) and the pill says nothing about health.
 *
 * @param {{
 *   drive: { state: string, mounted?: boolean, encrypted?: boolean, locked?: boolean, converting?: boolean } | null,
 *   health?: import("../../lib/driveHealth.js").DriveHealthReport | null,
 * }} props
 */
export default function DriveStatusPill({ drive, health }) {
  if (!drive) return null;
  if (drive.state === "missing") return <Pill variant="warning">Unplugged</Pill>;
  if (drive.state === "ejected") return <Pill variant="info">Ejected</Pill>;
  // A conversion holds the drive for hours; that is the state worth showing.
  if (isConvertingDrive(drive)) return <Pill variant="info">Formatting</Pill>;
  // Locked before "can't open": a locked drive has no mount, and that is not a
  // fault. It needs a password, not a repair.
  if (isLockedDrive(drive)) {
    return (
      <Pill variant="info">
        <TermHint content={LOCKED_HINT}>Locked</TermHint>
      </Pill>
    );
  }
  if (isUnopenable(drive)) return <Pill variant="warning">Can't open</Pill>;

  const copy = health ? describeDriveHealth(health) : null;
  if (copy && (copy.verdict === "failing" || copy.verdict === "watch")) {
    return <Pill variant={copy.pill.variant}>{copy.pill.label}</Pill>;
  }

  if (drive.state === "readonly") {
    return (
      <Pill variant="warning">
        <TermHint content={READ_ONLY_HINT}>Read only</TermHint>
      </Pill>
    );
  }
  if (drive.state === "as_is") return <Pill variant="success">Ready</Pill>;
  return <Pill variant="info">{drive.state}</Pill>;
}

DriveStatusPill.propTypes = {
  drive: PropTypes.shape({
    state: PropTypes.string.isRequired,
    mounted: PropTypes.bool,
    encrypted: PropTypes.bool,
    locked: PropTypes.bool,
    converting: PropTypes.bool,
  }),
  health: PropTypes.object,
};
