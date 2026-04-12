import PropTypes from "prop-types";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

export default function CollapsibleSection({
  title,
  children,
  defaultOpen = false,
  mono = false,
  size = "sm",
  background = false,
  className = "",
}) {
  const [open, setOpen] = useState(defaultOpen);

  const sizeClass = size === "xs" ? "text-xs" : "text-sm";

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 ${sizeClass} text-accent hover:text-primary motion-safe:transition-colors w-full py-1 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded-pill ${mono ? "font-mono" : ""}`}
        aria-expanded={open}
      >
        <ChevronDown
          size={size === "xs" ? 12 : 14}
          className={`motion-safe:transition-transform duration-200 ${
            open ? "rotate-180" : "rotate-0"
          }`}
          aria-hidden="true"
        />
        <span>{title}</span>
      </button>
      <div
        className={`overflow-hidden motion-safe:transition-all ease-[var(--motion-easing-emphasized)] ${
          open ? "max-h-96 opacity-100" : "max-h-0 opacity-0"
        }`}
        style={{ transitionDuration: "var(--motion-duration-medium1)" }}
      >
        <div className={background ? "mt-3 bg-primary/5 rounded-card p-3" : "pt-2 pl-6"}>
          {children}
        </div>
      </div>
    </div>
  );
}

CollapsibleSection.propTypes = {
  title: PropTypes.string.isRequired,
  children: PropTypes.node,
  defaultOpen: PropTypes.bool,
  mono: PropTypes.bool,
  size: PropTypes.oneOf(["sm", "xs"]),
  background: PropTypes.bool,
  className: PropTypes.string,
};
