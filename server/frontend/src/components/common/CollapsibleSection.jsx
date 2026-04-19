import PropTypes from "prop-types";
import { ChevronDown } from "lucide-react";
import { useState, useId } from "react";

export default function CollapsibleSection({
  title,
  children,
  defaultOpen = false,
  mono = false,
  size = "sm",
  background = false,
  pill = false,
  className = "",
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  const sizeClass = size === "xs" ? "text-xs" : size === "md" ? "text-base" : "text-sm";

  const wrapperClass = pill
    ? `border border-primary/10 rounded-large-element bg-primary/5 overflow-hidden ${className}`
    : className;

  return (
    <div className={wrapperClass}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 ${sizeClass} text-secondary/70 hover:text-secondary motion-safe:transition-colors w-full focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded-pill ${
          pill ? "py-2 px-3" : "py-1"
        } ${mono ? "font-mono" : ""}`}
        aria-expanded={open}
        aria-controls={contentId}
      >
        <ChevronDown
          size={size === "xs" ? 12 : size === "md" ? 18 : 14}
          className={`motion-safe:transition-transform duration-200 ${
            open ? "rotate-180" : "rotate-0"
          }`}
          aria-hidden="true"
        />
        <span>{title}</span>
      </button>
      <div
        id={contentId}
        className={`overflow-hidden motion-safe:transition-all ease-[var(--motion-easing-emphasized)] ${
          open ? "max-h-[800px] opacity-100" : "max-h-0 opacity-0"
        }`}
        style={{ transitionDuration: "var(--motion-duration-medium1)" }}
      >
        <div className={pill ? "px-3 pb-4" : background ? "mt-3 bg-primary/5 rounded-card p-3" : "pt-2 pl-6"}>
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
  size: PropTypes.oneOf(["sm", "md", "xs"]),
  background: PropTypes.bool,
  pill: PropTypes.bool,
  className: PropTypes.string,
};
