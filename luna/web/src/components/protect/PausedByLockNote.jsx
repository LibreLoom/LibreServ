import PropTypes from "prop-types";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";

/**
 * Says a backup is waiting because a drive it uses is locked. lunad sends
 * `paused: "locked"` and `locked_drive_names` on a drive backup; it renders
 * nothing for any other backup. Text only: the surface it sits on supplies the color.
 *
 * @param {{ backup: { paused?: string | null, locked_drive_names?: string[] } }} props
 */
export default function PausedByLockNote({ backup }) {
  const names = backup.paused === "locked" ? backup.locked_drive_names || [] : [];
  if (names.length === 0) return null;
  return (
    <p className="text-sm">
      Paused until{" "}
      {names.map((name, i) => (
        <span key={name}>
          {i > 0 && (i === names.length - 1 ? " and " : ", ")}
          <InlinePill>{name}</InlinePill>
        </span>
      ))}{" "}
      {names.length === 1 ? "is" : "are"} unlocked.
    </p>
  );
}

PausedByLockNote.propTypes = { backup: PropTypes.object.isRequired };
