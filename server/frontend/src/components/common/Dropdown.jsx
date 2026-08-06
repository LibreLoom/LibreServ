import { useState, useRef, useEffect, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSmoothResize } from "../../hooks/useSmoothResize";
import { haptic } from "../../utils/haptics";

/**
 * @typedef {object} DropdownProps
 * @property {Array<{value: string, label: string}>} options
 * @property {string} value
 * @property {(value: string) => void} onChange
 * @property {string} [placeholder]
 * @property {string} [label]
 * @property {"primary"|"secondary"} [surface]
 * @property {boolean} [fullWidth]
 * @property {boolean} [disabled]
 * @property {boolean} [ghost]
 * @property {string} [className]
 * @property {string} [id]
 */

/** @param {DropdownProps & { [key: string]: any }} props */
export default function Dropdown({
  options,
  value,
  onChange,
  placeholder = "Select...",
  label,
  surface = "secondary",
  fullWidth = false,
  disabled = false,
  ghost = false,
  className = "",
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef(null);
  const portalRef = useRef(null);
  const buttonRef = useRef(null);
  useSmoothResize(buttonRef, { x: !fullWidth });

  const selectedOption = options.find((o) => o.value === value);
  const textClass = surface === "primary" ? "text-secondary" : "text-primary";
  const bgClass = ghost ? "bg-transparent" : `bg-${surface}`;
  const hoverClass = ghost
    ? `hover:bg-${surface === "primary" ? "secondary" : "primary"}/10`
    : "";

  const updatePosition = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const menuWidth = portalRef.current?.offsetWidth || rect.width;
      let left = rect.left + window.scrollX;
      if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
      if (left < 8) left = 8;
      setPosition({ top: rect.bottom + window.scrollY + 4, left });
    }
  }, []);

  const close = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      setIsOpen(false);
      setIsClosing(false);
      setActiveIndex(-1);
    }, 160);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(event) {
      if (containerRef.current?.contains(event.target) || portalRef.current?.contains(event.target)) return;
      close();
    }
    function handleEscape(event) {
      if (event.key === "Escape") {
        close();
        buttonRef.current?.focus();
      }
    }
    function handleScroll() {
      updatePosition();
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [isOpen, updatePosition, close]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updatePosition();
    if (portalRef.current) updatePosition();
  }, [isOpen, updatePosition]);

  const handleSelect = (optionValue) => {
    haptic("selection");
    onChange(optionValue);
    close();
    buttonRef.current?.focus();
  };

  const handleToggle = () => {
    if (disabled) return;
    if (isOpen) {
      close();
    } else {
      updatePosition();
      setIsOpen(true);
    }
  };

  const handleKeyDown = (event) => {
    if (!isOpen) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + options.length) % options.length);
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      handleSelect(options[activeIndex].value);
    }
  };

  return (
    <div className={cn("relative", fullWidth && "w-full", className)} ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        data-slot="dropdown-trigger"
        onClick={handleToggle}
        disabled={disabled}
        onKeyDown={handleKeyDown}
        className={cn(
          "items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer rounded-pill",
          "motion-safe:transition-all no-focus-outline",
          "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
          `focus-visible:ring-offset-${surface}`,
          "active:motion-safe:scale-95 disabled:opacity-50 disabled:cursor-not-allowed",
          fullWidth ? "w-full inline-flex" : "inline-flex",
          bgClass,
          textClass,
          ghost ? "font-mono" : "font-medium",
          hoverClass
        )}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={label ? `${label}: ${selectedOption?.label || "select"}` : undefined}
      >
        {label && !ghost && <span className="opacity-70">{label}</span>}
        <span className={cn("inline-flex items-center gap-1 whitespace-nowrap", ghost ? "" : "font-mono", fullWidth && "justify-between w-full")}>
          {selectedOption?.label || placeholder}
          <ChevronDown
            size={14}
            className={cn("motion-safe:transition-transform motion-safe:duration-300", isOpen && !isClosing ? "rotate-180" : "rotate-0")}
            style={{ transitionTimingFunction: "var(--motion-easing-emphasized)" }}
            aria-hidden="true"
          />
        </span>
      </button>

      {isOpen &&
        createPortal(
          <ul
            ref={portalRef}
            data-slot="dropdown-menu"
            role="listbox"
            style={{ position: "absolute", top: position.top, left: position.left }}
            className={cn(
              "bg-secondary text-primary font-mono ring-inset ring-2 ring-accent",
              "rounded-large-element py-0 z-50 overflow-hidden min-w-[8rem]",
              isClosing ? "animate-dropdown-close" : "animate-dropdown-open"
            )}
            tabIndex={-1}
          >
            {options.map((option, i) => (
              <li
                key={option.value}
                data-slot="dropdown-option"
                className={isClosing ? "" : "animate-dropdown-option"}
                style={isClosing ? undefined : { animationDelay: `${i * 45}ms` }}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={value === option.value}
                  onClick={() => handleSelect(option.value)}
                  className={cn(
                    "w-full text-left px-4 py-2 text-xs motion-safe:transition-all motion-safe:duration-150 motion-safe:ease-out",
                    "cursor-pointer rounded-none",
                    value === option.value
                      ? "bg-accent text-primary font-medium"
                      : i === activeIndex
                        ? "bg-primary/10 motion-safe:translate-x-0.5"
                        : "hover:bg-primary/10 hover:motion-safe:translate-x-0.5"
                  )}
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
