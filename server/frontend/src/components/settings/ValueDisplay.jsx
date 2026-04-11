import PropTypes from "prop-types";

export default function ValueDisplay({ label, value, fallback = "N/A", className = "" }) {
  return (
    <div className={`flex items-center justify-between py-1.5 ${className}`}>
      <span className="text-sm text-accent">{label}</span>
      <span className="text-sm text-primary font-mono">
        {value ?? fallback}
      </span>
    </div>
  );
}

ValueDisplay.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.string,
  fallback: PropTypes.string,
  className: PropTypes.string,
};
