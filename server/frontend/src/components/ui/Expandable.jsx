import { useState } from "react";
import { ChevronDown } from "lucide-react";
import PropTypes from "prop-types";

export default function Expandable({
  children,
  label = "Show details",
  expandedLabel = "Hide details",
  defaultOpen = false,
  className = "",
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const toggle = () => setIsOpen(!isOpen);

  return (
    <div className={className}>
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1 text-sm text-accent hover:text-primary mt-3 cursor-pointer"
        aria-expanded={isOpen}
      >
        <ChevronDown
          size={16}
          className={`motion-safe:transition-transform duration-200 ${isOpen ? "rotate-180" : "rotate-0"}`}
          aria-hidden="true"
        />
        <span>{isOpen ? expandedLabel : label}</span>
      </button>

      <div
        className={`motion-safe:transition-all duration-300 ease-out ${
          isOpen ? "max-h-96 overflow-visible" : "max-h-0 overflow-hidden"
        }`}
        aria-hidden={!isOpen}
      >
        {children}
      </div>
    </div>
  );
}

Expandable.propTypes = {
  children: PropTypes.node.isRequired,
  label: PropTypes.string,
  expandedLabel: PropTypes.string,
  defaultOpen: PropTypes.bool,
  className: PropTypes.string,
};
