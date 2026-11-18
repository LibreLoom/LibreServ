import PropTypes from "prop-types";
import LayeredPill from "@libreloom/ui/components/ui/LayeredPill.jsx";
import { TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { describeDriveHealth } from "../../lib/driveHealth.js";
import { Ellipsis, Lock } from "lucide-react";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { isLocked, isUnopenable } from "../../lib/drives.js";

const READ_ONLY_HINT =
  "Luna can open files here but cannot save changes. A write-lock switch on the drive, a full drive, or a damaged file system can cause this.";

/**
 * The drive card's status pill: the one thing most worth knowing about the
 * drive, in plain words. Unplugged and Ejected come first, then a drive Luna
 * can't open, then a failing or worn drive (so a health pill never sits next
 * to "Ready"), then Read only, then Ready.
 *
 * `health` is the drive's health report as the API returns it; leave it out
 * (or pass undefined while it loads) and the pill says nothing about health.
 *
 * It is always a LayeredPill; with `onActions`, the drive's rare actions are
 * its trailing segment.
 *
 * @param {{
 *   drive: { state: string, label?: string, mounted?: boolean, encrypted?: boolean, locked?: boolean } | null,
 *   health?: import("../../lib/driveHealth.js").DriveHealthReport | null,
 *   surface?: "primary" | "secondary",
 *   onActions?: () => void,
 * }} props
 */
export default function DriveStatusPill({ drive, health, surface = "primary", onActions }) {
  const status = describeStatus(drive, health);
  if (!status) return null;
  const { label, icon, hint } = status;
  const content = hint ? (
    <TermHint content={hint} surface={surface}>
      {label}
    </TermHint>
  ) : (
    label
  );

  // Always the one LayeredPill: the status is the chip, and the drive's rare
  // actions (when given) are the trailing segment. It lives in the card's
  // panel, so it names the panel's surface.
  return (
    <LayeredPill
      surface="primary"
      icon={icon}
      {...(onActions
        ? {
            actionIcon: <Ellipsis size={ICON_SIZE.xs} aria-hidden="true" />,
            actionIconOnly: true,
            actionLabel: <span className="sr-only">Actions</span>,
            actionAriaLabel: `Actions for ${drive.label || "this drive"}`,
            actionHaptic: false,
            onAction: onActions,
          }
        : {})}
    >
      {content}
    </LayeredPill>
  );
}

/**
 * The one thing most worth knowing about the drive: its words and
 * the aside that explains it when the words need explaining.
 *
 * @param {{ state: string, label?: string, mounted?: boolean, encrypted?: boolean, locked?: boolean } | null} drive
 * @param {import("../../lib/driveHealth.js").DriveHealthReport | null | undefined} health
 * @returns {{ label: string, icon?: import("react").ReactElement, hint?: string } | null}
 */
function describeStatus(drive, health) {
  if (!drive) return null;
  if (drive.state === "missing") return { label: "Unplugged" };
  if (drive.state === "ejected") return { label: "Ejected" };
  if (isLocked(drive)) {
    return {
      label: "Locked",
      icon: <Lock size={ICON_SIZE.xs} aria-hidden="true" />,
      hint: "This drive is protected with a password. Enter the password to open its files.",
    };
  }
  if (isUnopenable(drive)) return { label: "Can't open" };

  const copy = health ? describeDriveHealth(health) : null;
  if (copy && (copy.verdict === "failing" || copy.verdict === "watch")) {
    return { label: copy.pill.label };
  }

  if (drive.state === "readonly") {
    return { label: "Read only", hint: READ_ONLY_HINT };
  }
  if (drive.state === "as_is") return { label: "Ready" };
  return { label: drive.state };
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
  onActions: PropTypes.func,
};
