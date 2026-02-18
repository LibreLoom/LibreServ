import { useState, useRef, useEffect } from "react";
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

export default function RefreshDropdown({ value, onChange, onOpenChange }) {
  const [isOpen, setIsOpen] = useState(false);
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

  useEffect(() => {
    function handleClickOutside(event) {
      if (
        containerRef.current?.contains(event.target) ||
        portalRef.current?.contains(event.target)
      ) {
        return;
      }
      setIsOpen(false);
      onOpenChange?.(false);
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        setIsOpen(false);
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
  }, [isOpen, onOpenChange]);

  const handleSelect = (intervalValue) => {
    onChange(intervalValue);
    buttonRef.current?.focus();
  };

  const handleToggle = () => {
    if (!isOpen) {
      updatePosition();
    }
    const newState = !isOpen;
    setIsOpen(newState);
    onOpenChange?.(newState);
  };

  return (
    <div className="relative w-full" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        className="inline-flex flex-col items-start gap-0 px-0 py-0 bg-transparent text-primary text-xs font-medium motion-safe:transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-primary"
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
            className="bg-secondary text-accent ring-inset ring-2 ring-accent rounded-large-element py-0 z-100 pop-in overflow-hidden"
            tabIndex={-1}
          >
            {REFRESH_INTERVALS.map((interval) => (
              <li key={interval.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={value === interval.value}
                  onClick={() => handleSelect(interval.value)}
                  className={`w-full text-left px-4 py-2 text-xs motion-safe:transition-colors cursor-pointer rounded-none ${
                    value === interval.value
                      ? "bg-accent text-primary font-medium"
                      : "hover:bg-primary/10"
                  }`}
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
