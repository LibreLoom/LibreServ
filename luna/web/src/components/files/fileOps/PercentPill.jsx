import PropTypes from "prop-types";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import RollingNumber from "@libreloom/ui/components/common/RollingNumber.jsx";

/**
 * A percentage drawn as a chip, for every place the file task card reports one:
 * the collapsed summary, the meta line and a running upload.
 *
 * The digits roll rather than re-enter on every progress emit, so the chip
 * itself stays put while the number counts — a pill that re-entered ten times a
 * second would read as a flicker, not as progress.
 *
 * @param {{ value: number }} props `value` is 0-100.
 */
export default function PercentPill({ value }) {
  return (
    <InlinePill>
      <RollingNumber value={value} />%
    </InlinePill>
  );
}

PercentPill.propTypes = {
  value: PropTypes.number.isRequired,
};
