import PropTypes from "prop-types";

export default function AnimatedCheckbox({ checked, onChange, children, className = "" }) {
  return (
    <label className={`flex items-start gap-3 cursor-pointer group ${className}`}>
      <div
        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all duration-200 ${
          checked
            ? "border-accent bg-accent"
            : "border-primary/30 group-hover:border-primary/50"
        }`}
      >
        <svg
          className={`w-3 h-3 text-primary transition-all duration-200 ${
            checked ? "scale-100 opacity-100" : "scale-0 opacity-0"
          }`}
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2.5 6L5 8.5L9.5 3.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      <span className="text-sm text-primary/60 leading-relaxed">{children}</span>
    </label>
  );
}

AnimatedCheckbox.propTypes = {
  checked:   PropTypes.bool.isRequired,
  onChange:  PropTypes.func.isRequired,
  children:  PropTypes.node.isRequired,
  className: PropTypes.string,
};
