import PropTypes from "prop-types";
import { ChevronDown } from "lucide-react";
import { useState, useId } from "react";
import { cn } from "@/lib/utils";

export default function CollapsibleSection({
  title,
  children,
  defaultOpen = false,
  mono = false,
  size = "sm",
  pill = false,
  className = "",
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  const sizeClass = size === "xs" ? "text-xs" : size === "md" ? "text-base" : "text-sm";

  const wrapperClass = pill
    ? cn(
        "border rounded-large-element bg-primary/5 motion-safe:transition-colors motion-safe:duration-150",
        open ? "border-primary/35 bg-primary/10" : "border-primary/20 hover:border-primary/35",
        className
      )
    : className;

  return (
    <div data-slot="collapsible" className={wrapperClass}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex items-center gap-1.5 motion-safe:transition-all w-full",
          "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded-pill",
          sizeClass,
          pill ? "text-primary font-medium py-2 px-3" : "text-inherit py-1",
          mono && "font-mono"
        )}
        aria-expanded={open}
        aria-controls={contentId}
      >
        <ChevronDown
          size={size === "xs" ? 12 : size === "md" ? 18 : 14}
          className={cn("motion-safe:transition-transform duration-200", open ? "rotate-180" : "rotate-0")}
          aria-hidden="true"
        />
        <span>{title}</span>
      </button>
      <div
        id={contentId}
        aria-hidden={!open}
        className={cn(
          "grid motion-safe:transition-all motion-safe:duration-300 motion-safe:ease-[var(--motion-easing-emphasized)]",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        )}
      >
        <div className="overflow-hidden">
          <div
            key={open ? "open" : "closed"}
            className={cn(
              pill ? "px-3 pb-2" : "pt-2 pl-6",
              open && "animate-alert-enter"
            )}
          >
            {children}
          </div>
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
  pill: PropTypes.bool,
  className: PropTypes.string,
};
