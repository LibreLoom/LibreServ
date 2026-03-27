import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

export default function Dropdown({
  options,
  value,
  onChange,
  placeholder = "Select...",
  label,
  width,
  className = "",
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const containerRef = useRef(null);
  const portalRef = useRef(null);
  const buttonRef = useRef(null);

  const selectedOption = options.find((o) => o.value === value);

  const updatePosition = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const menuWidth = width || rect.width;
      let left = rect.left + window.scrollX;

      if (left + menuWidth > window.innerWidth - 8) {
        left = window.innerWidth - menuWidth - 8;
      }
      if (left < 8) {
        left = 8;
      }

      setPosition({
        top: rect.bottom + window.scrollY + 4,
        left,
      });
    }
  }, [width]);

  useEffect(() => {
    function handleClickOutside(event) {
      if (
        containerRef.current?.contains(event.target) ||
        portalRef.current?.contains(event.target)
      ) {
        return;
      }
      setIsOpen(false);
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        setIsOpen(false);
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
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        updatePosition();
      });
    }
  }, [isOpen, updatePosition]);

  const handleSelect = (optionValue) => {
    onChange(optionValue);
    setIsOpen(false);
    buttonRef.current?.focus();
  };

  const handleToggle = () => {
    if (!isOpen) {
      updatePosition();
    }
    setIsOpen(!isOpen);
  };

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        className="inline-flex flex-col items-start gap-0 px-3 py-1.5 bg-primary text-secondary text-xs font-medium motion-safe:transition-colors cursor-pointer rounded-pill focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-primary"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={label ? `${label}: ${selectedOption?.label || "select"}` : undefined}
      >
        {label && <span className="text-accent">{label}</span>}
        <span className="inline-flex items-center gap-1 font-mono">
          {selectedOption?.label || placeholder}
          <ChevronDown
            size={14}
            className={`motion-safe:transition-transform duration-200 ${isOpen ? "rotate-180" : "rotate-0"}`}
            aria-hidden="true"
          />
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
            }}
            className="bg-secondary text-primary ring-inset ring-2 ring-accent rounded-large-element py-0 z-100 pop-in overflow-hidden min-w-[8rem] animate-dropdown-open"
            tabIndex={-1}
          >
            {options.map((option) => (
              <li key={option.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={value === option.value}
                  onClick={() => handleSelect(option.value)}
                  className={`w-full text-left px-4 py-2 text-xs motion-safe:transition-colors cursor-pointer rounded-none ${
                    value === option.value
                      ? "bg-accent text-primary font-medium"
                      : "hover:bg-primary/10"
                  }`}
                >
                  {option.label}
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
