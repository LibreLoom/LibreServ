import PropTypes from "prop-types";

export default function ValueDisplay({
  label,
  value,
  mono = true,
  fallback = "N/A",
  className = "",
}) {
  if (!label) {
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded-pill bg-primary/10 ${mono ? "font-mono" : ""} text-sm text-primary ${className}`}>
        {value ?? fallback}
      </span>
    );
  }

  return (
    <div className={`flex items-center justify-between py-2 px-3 border border-primary/10 rounded-large-element bg-primary/5 ${className}`}>
      <span className="text-sm text-accent">{label}</span>
      <span className={`text-sm text-primary px-2 py-0.5 rounded-pill bg-primary/10 ${mono ? "font-mono" : ""}`}>
        {value ?? fallback}
      </span>
    </div>
  );
}

ValueDisplay.propTypes = {
  label: PropTypes.string,
  value: PropTypes.string,
  mono: PropTypes.bool,
  fallback: PropTypes.string,
  className: PropTypes.string,
};
