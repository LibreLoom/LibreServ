import PropTypes from "prop-types";
import Pill from "../common/Pill.jsx";

function ChatCreditBar({ used, cap, planName }) {
  const pct = cap > 0 ? (used / cap) * 100 : 0;
  const isHigh = pct > 80;

  const creditText = cap > 0
    ? `Credit: $${used.toFixed(2)} / $${cap.toFixed(2)}`
    : `Credit: Unlimited`;

  return (
    <div className="flex items-center gap-2 text-xs text-primary/50 font-mono">
      <span className={isHigh ? "text-error" : ""}>
        {creditText}
      </span>
      {planName && (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill text-xs bg-primary text-secondary">
          {planName}
        </span>
      )}
    </div>
  );
}

ChatCreditBar.propTypes = {
  used: PropTypes.number.isRequired,
  cap: PropTypes.number.isRequired,
  planName: PropTypes.string,
};

export default ChatCreditBar;
