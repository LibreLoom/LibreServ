import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { ChevronDown, Plus } from "lucide-react";
import Button from "../ui/Button.jsx";
import { cn } from "@/lib/utils";
import { createKindsFor, groupedCreateKinds } from "../../lib/createKinds.js";

/**
 * One New button that opens a growing list of create kinds.
 *
 * A single kind (folder-only pickers) skips the menu and goes straight to
 * that action. Adding office types later is a catalog change, not more
 * toolbar buttons.
 *
 * @param {{
 *   onPick: (kind: import("../../lib/createKinds.js").CreateKind) => void,
 *   ids?: string[],
 * }} props
 */
export default function NewItemMenu({ onPick, ids }) {
  const kinds = useMemo(() => createKindsFor(ids), [ids]);
  const groups = useMemo(() => groupedCreateKinds(kinds), [kinds]);
  const showGroupLabels = groups.length > 1;
  const single = kinds.length === 1 ? kinds[0] : null;

  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const portalRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const buttonRef = useRef(/** @type {HTMLButtonElement|null} */ (null));

  const close = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      setIsOpen(false);
      setIsClosing(false);
      setActiveIndex(0);
    }, 160);
  }, []);

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const menuWidth = portalRef.current?.offsetWidth || Math.max(rect.width, 176);
    let left = rect.left + window.scrollX;
    if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
    if (left < 8) left = 8;
    setPosition({ top: rect.bottom + window.scrollY + 4, left });
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    function handleClickOutside(event) {
      if (containerRef.current?.contains(event.target) || portalRef.current?.contains(event.target)) return;
      close();
    }
    function handleEscape(event) {
      if (event.key === "Escape") {
        close();
        containerRef.current?.querySelector("button")?.focus();
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
  }, [isOpen, close, updatePosition]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updatePosition();
  }, [isOpen, updatePosition]);

  function pick(kind) {
    onPick(kind);
    if (isOpen) close();
  }

  function handleTrigger() {
    if (single) {
      pick(single);
      return;
    }
    if (isOpen) {
      close();
      return;
    }
    updatePosition();
    setIsOpen(true);
  }

  function handleMenuKeyDown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % kinds.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + kinds.length) % kinds.length);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const kind = kinds[activeIndex];
      if (kind) pick(kind);
    }
  }

  let flatIndex = -1;

  return (
    <div className="relative inline-flex" ref={containerRef}>
      <span ref={buttonRef} className="inline-flex">
      <Button
        variant="outline"
        surface="secondary"
        size="sm"
        type="button"
        aria-haspopup={single ? undefined : "menu"}
        aria-expanded={single ? undefined : isOpen}
        aria-label={single ? `New ${single.label.toLowerCase()}` : "New"}
        onClick={handleTrigger}
      >
        {single ? (
          <single.icon size={14} aria-hidden="true" />
        ) : (
          <Plus size={14} aria-hidden="true" />
        )}
        {single ? `New ${single.label.toLowerCase()}` : "New"}
        {single ? null : (
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={cn(
              "motion-safe:transition-transform motion-safe:duration-300",
              isOpen && !isClosing ? "rotate-180" : "rotate-0",
            )}
          />
        )}
      </Button>
      </span>

      {isOpen && !single
        ? createPortal(
          <div
            ref={portalRef}
            role="menu"
            aria-label="New"
            tabIndex={-1}
            onKeyDown={handleMenuKeyDown}
            style={{ position: "absolute", top: position.top, left: position.left }}
            className={cn(
              "bg-secondary text-primary ring-inset ring-2 ring-accent",
              "rounded-large-element z-50 overflow-hidden min-w-[12rem] max-h-72 overflow-y-auto",
              isClosing ? "animate-dropdown-close" : "animate-dropdown-open",
            )}
          >
            {groups.map((group) => (
              <div key={group.label || "items"}>
                {showGroupLabels && group.label ? (
                  <p className="px-4 pt-2.5 pb-1 font-mono text-xs uppercase tracking-widest text-primary">
                    {group.label}
                  </p>
                ) : null}
                {group.items.map((kind) => {
                  flatIndex += 1;
                  const index = flatIndex;
                  const Icon = kind.icon;
                  return (
                    <button
                      key={kind.id}
                      type="button"
                      role="menuitem"
                      className={cn(
                        "w-full flex items-center gap-2 px-4 py-2 text-sm text-left cursor-pointer",
                        "text-primary font-mono motion-safe:transition-all motion-safe:duration-150",
                        index === activeIndex
                          ? "bg-primary/10"
                          : "hover:bg-primary/10",
                        isClosing ? "" : "animate-dropdown-option",
                      )}
                      style={isClosing ? undefined : { animationDelay: `${index * 45}ms` }}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => pick(kind)}
                    >
                      <Icon size={14} aria-hidden="true" className="shrink-0" />
                      {kind.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}

NewItemMenu.propTypes = {
  onPick: PropTypes.func.isRequired,
  ids: PropTypes.arrayOf(PropTypes.string),
};
