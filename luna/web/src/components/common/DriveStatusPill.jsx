import PropTypes from "prop-types";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
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
 * With `onActions`, the status and the drive's rare actions are ONE LayeredPill:
 * the status is the chip, the actions menu the trailing segment. Without it,
 * the status stays a plain tinted pill.
 *
 * @param {{
 *   drive: { state: string, label?: string, mounted?: boolean, encrypted?: boolean, locked?: boolean } | null,
 *   health?: import("../../lib/driveHealth.js").DriveHealthReport | null,
 *   surface?: "primary" | "secondary",
 *   onActions?: () => void,
 * }} props
 */
export default function DriveStatusPill({ drive, health, surface = "secondary", onActions }) {
  const status = describeStatus(drive, health);
  if (!status) return null;
  const { label, tone, icon, hint } = status;
  const content = hint ? (
    <TermHint content={hint} surface={surface}>
      {label}
    </TermHint>
  ) : (
    label
  );

  // With actions, the status and the drive's rare actions are one LayeredPill:
  // the status is the chip, the actions menu the trailing segment.
  if (onActions) {
    return (
      <LayeredPill
        icon={icon}
        actionIcon={<Ellipsis size={ICON_SIZE.xs} aria-hidden="true" />}
        actionIconOnly
        actionLabel={<span className="sr-only">Actions</span>}
        actionAriaLabel={`Actions for ${drive.label || "this drive"}`}
        actionHaptic={false}
        onAction={onActions}
      >
        {content}
      </LayeredPill>
    );
  }
  return (
    <Pill variant={tone}>
      {icon}
      {content}
    </Pill>
  );
}

/**
 * The one thing most worth knowing about the drive: its words, its tone, and
 * the aside that explains it when the words need explaining.
 *
 * @param {{ state: string, label?: string, mounted?: boolean, encrypted?: boolean, locked?: boolean } | null} drive
 * @param {import("../../lib/driveHealth.js").DriveHealthReport | null | undefined} health
 * @returns {{ label: string, tone: "success"|"warning"|"info"|"error"|"muted", icon?: import("react").ReactElement, hint?: string } | null}
 */
function describeStatus(drive, health) {
  if (!drive) return null;
  if (drive.state === "missing") return { label: "Unplugged", tone: "warning" };
  if (drive.state === "ejected") return { label: "Ejected", tone: "info" };
  if (isLocked(drive)) {
    return {
      label: "Locked",
      tone: "info",
      icon: <Lock size={ICON_SIZE.xs} aria-hidden="true" />,
      hint: "This drive is protected with a password. Enter the password to open its files.",
    };
  }
  if (isUnopenable(drive)) return { label: "Can't open", tone: "warning" };

  const copy = health ? describeDriveHealth(health) : null;
  if (copy && (copy.verdict === "failing" || copy.verdict === "watch")) {
    return { label: copy.pill.label, tone: copy.pill.variant };
  }

  if (drive.state === "readonly") {
    return { label: "Read only", tone: "warning", hint: READ_ONLY_HINT };
  }
  if (drive.state === "as_is") return { label: "Ready", tone: "success" };
  return { label: drive.state, tone: "info" };
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
