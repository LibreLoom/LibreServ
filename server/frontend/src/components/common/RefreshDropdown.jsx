import { cn } from "@/lib/utils";
import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

const REFRESH_INTERVALS = [
  { label: "1 second", value: 1000 },
  { label: "5 seconds", value: 5000 },
  { label: "10 seconds", value: 10000 },
  { label: "30 seconds", value: 30000 },
  { label: "1 minute", value: 60000 },
  { label: "5 minutes", value: 300000 },
  { label: "15 minutes", value: 900000 },
  { label: "30 minutes", value: 1800000 },
  { label: "1 hour", value: 3600000 },
];

/** @param {{ value: any, onChange: any, onOpenChange?: any }} _ */
export default function RefreshDropdown({ value, onChange, onOpenChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0 });
  const containerRef = useRef(null);
  const portalRef = useRef(null);
  const buttonRef = useRef(null);

  const selectedInterval = REFRESH_INTERVALS.find((i) => i.value === value);

  const updatePosition = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPosition({
        top: rect.bottom + window.scrollY + 4,
        left: rect.left + window.scrollX,
        width: rect.width,
      });
    }
  };

  const close = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      setIsOpen(false);
      setIsClosing(false);
    }, 160);
  }, []);

  useEffect(() => {
    function handleClickOutside(event) {
      if (
        containerRef.current?.contains(event.target) ||
        portalRef.current?.contains(event.target)
      ) {
        return;
      }
      close();
      onOpenChange?.(false);
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        close();
        onOpenChange?.(false);
        buttonRef.current?.focus();
      }
    }

    function handleScroll() {
      if (isOpen) {
        updatePosition();
      }
    }

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
      window.addEventListener("scroll", handleScroll, true);
      window.addEventListener("resize", handleScroll);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [isOpen, onOpenChange, close]);

  const handleSelect = (intervalValue) => {
    onChange(intervalValue);
    close();
    onOpenChange?.(false);
    buttonRef.current?.focus();
  };

  const handleToggle = () => {
    if (isOpen) {
      close();
      onOpenChange?.(false);
    } else {
      updatePosition();
      setIsOpen(true);
      onOpenChange?.(true);
    }
  };

  return (
    <div className={cn("relative w-full")} ref={containerRef} data-slot="refresh-dropdown">
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        className={cn("inline-flex flex-col items-start gap-0 px-0 py-0 bg-transparent text-primary text-xs font-medium motion-safe:transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-primary", "no-focus-outline")}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={`Refresh interval: ${selectedInterval?.label || "select"}`}
      >
        <span className="text-accent">Refresh Interval:</span>
        <span className="font-mono">
          {selectedInterval?.label || "Select..."}
        </span>
      </button>

      {isOpen &&
        createPortal(
          <ul
            ref={portalRef}
            role="listbox"
            style={{
              position: "absolute",
              top: position.top,
              left: position.left,
              width: position.width,
            }}
            className={cn("bg-secondary text-primary ring-inset ring-2 ring-accent rounded-large-element py-0 z-100 overflow-hidden", isClosing ? "animate-dropdown-close" : "animate-dropdown-open")}
            tabIndex={-1}
          >
            {REFRESH_INTERVALS.map((interval, i) => (
              <li
                key={interval.value}
                className={isClosing ? "" : "animate-dropdown-option"}
                style={isClosing ? undefined : { animationDelay: `${i * 30}ms` }}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={value === interval.value}
                  onClick={() => handleSelect(interval.value)}
                  className={cn("w-full text-left px-4 py-2 text-xs motion-safe:transition-all motion-safe:duration-150 motion-safe:ease-out cursor-pointer rounded-none", value === interval.value ? "bg-accent text-primary font-medium" : "hover:bg-primary/10 hover:motion-safe:translate-x-0.5")}
                >
                  {interval.label}
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}

export { REFRESH_INTERVALS };
