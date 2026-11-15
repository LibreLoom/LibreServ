import PropTypes from "prop-types";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import { TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { describeDriveHealth } from "../../lib/driveHealth.js";
import { Lock } from "lucide-react";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { isLocked, isUnopenable } from "../../lib/drives.js";

const READ_ONLY_HINT =
  "Luna can open files here but cannot save changes. Check the filesystem, or a write-lock switch on the stick — not the cable or USB port.";

/**
 * The drive card's status pill: the one thing most worth knowing about the
 * drive, in plain words. Unplugged and Ejected come first, then a drive Luna
 * can't open, then a failing or worn drive (so a health pill never sits next
 * to "Ready"), then Read only, then Ready.
 *
 * `health` is the drive's health report as the API returns it; leave it out
 * (or pass undefined while it loads) and the pill says nothing about health.
 *
 * @param {{
 *   drive: { state: string, mounted?: boolean, encrypted?: boolean, locked?: boolean } | null,
 *   health?: import("../../lib/driveHealth.js").DriveHealthReport | null,
 *   surface?: "primary" | "secondary",
 * }} props
 */
export default function DriveStatusPill({ drive, health, surface = "secondary" }) {
  if (!drive) return null;
  if (drive.state === "missing") return <Pill variant="warning">Unplugged</Pill>;
  if (drive.state === "ejected") return <Pill variant="info">Ejected</Pill>;
  if (isLocked(drive)) {
    return (
      <Pill variant="info">
        <Lock size={ICON_SIZE.xs} aria-hidden="true" />
        <TermHint content="This drive is protected with a password. Its files open once someone enters it." surface={surface}>Locked</TermHint>
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
        <TermHint content={READ_ONLY_HINT} surface={surface}>Read only</TermHint>
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
  }),
  health: PropTypes.object,
  surface: PropTypes.oneOf(["primary", "secondary"]),
};
